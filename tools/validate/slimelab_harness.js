// Slime Lab validation (Deno + WebGPU/wgpu). Validates the material-uniform
// refactor + render-style changes:
//   1. compiles ALL sim AND render shaders (catches fluid.wgsl style-uniform syntax)
//   2. builds the sim with the 16B material uniform at binding 3 of p2g_2 + updateGrid
//   3. settle + poke at default material -> stable + slime moves in push direction
//   4. slider-extreme sweep (max & min material corners) -> stays finite
// Run: deno run --unstable-webgpu --allow-read slimelab_harness.js

const SIM = "d:/SunnydayTech/Studio/Slim3D/mls-mpm";
const REND = "d:/SunnydayTech/Studio/Slim3D/render";
const STRUCT = 128, FLOATS = 32, CELL = 16, GRIDS = 64, FP = 1e6, DT = 0.10;
const SUBSTEPS = 4; // dt0.1 x 4 = same sim-time/frame as old dt0.2 x 2, but more stable
const BOX = [40, 30, 60], N_REQ = 20000, SETTLE = 40, POKE = 60;
const P2G2 = { fixed_point_multiplier: FP, dt: DT, p_vol: 1.0 }; // mu/lambda/visc now uniform

const rd = (d, f) => Deno.readTextFileSync(`${d}/${f}`);
const adapter = await navigator.gpu?.requestAdapter();
if (!adapter) { console.log("NO_ADAPTER"); Deno.exit(2); }
const device = await adapter.requestDevice();

let bad = false;
async function mod(dir, f) {
  const m = device.createShaderModule({ code: rd(dir, f), label: f });
  const errs = (await m.getCompilationInfo()).messages.filter((x) => x.type === "error");
  if (errs.length) { bad = true; console.log(`COMPILE_ERROR ${f}:`); errs.forEach((e) => console.log(`  ${e.lineNum}:${e.linePos} ${e.message}`)); }
  else console.log(`compiled OK: ${f}`);
  return m;
}
// sim shaders
const sim = {};
for (const f of ["clearGrid.wgsl", "p2g_1.wgsl", "p2g_2.wgsl", "updateGrid.wgsl", "g2p.wgsl", "copyPosition.wgsl", "pointerForce.wgsl"]) sim[f] = await mod(SIM, f);
// render shaders (compile-check only — catches fluid.wgsl style-uniform errors)
for (const f of ["depthMap.wgsl", "bilateral.wgsl", "fluid.wgsl", "fullScreen.wgsl", "thicknessMap.wgsl", "gaussian.wgsl", "sphere.wgsl"]) await mod(REND, f);
if (bad) { console.log("RESULT: FAIL (compile)"); Deno.exit(1); }

const cp = (m, c) => device.createComputePipeline({ layout: "auto", compute: c ? { module: m, constants: c } : { module: m } });
let pipes;
try {
  pipes = {
    clearGrid: cp(sim["clearGrid.wgsl"]), p2g_1: cp(sim["p2g_1.wgsl"], { fixed_point_multiplier: FP }),
    p2g_2: cp(sim["p2g_2.wgsl"], P2G2), updateGrid: cp(sim["updateGrid.wgsl"], { fixed_point_multiplier: FP, dt: DT }),
    g2p: cp(sim["g2p.wgsl"], { fixed_point_multiplier: FP, dt: DT }), copyPosition: cp(sim["copyPosition.wgsl"]),
    pointerForce: cp(sim["pointerForce.wgsl"]),
  };
} catch (e) { console.log("PIPELINE_ERROR (override/binding mismatch?):", e.message); Deno.exit(1); }

const maxGrid = GRIDS ** 3, gridCount = Math.ceil(BOX[0]) * Math.ceil(BOX[1]) * Math.ceil(BOX[2]);
const U = GPUBufferUsage.UNIFORM, S = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
const b = (sz, us) => device.createBuffer({ size: sz, usage: us });
const particleBuf = b(STRUCT * N_REQ, S | CS | CD), cellBuf = b(CELL * maxGrid, S | CD), posvelBuf = b(32 * N_REQ, S | CD);
// Material uniform is now 32B std140: [mu,lambda,visc,gravity, plasticity, pad,pad,pad].
const realBox = b(12, U | CD), initBox = b(12, U | CD), ptr = b(48, U | CD), mat = b(32, U | CD);
device.queue.writeBuffer(realBox, 0, new Float32Array(BOX));
device.queue.writeBuffer(initBox, 0, new Float32Array(BOX));
// setMat accepts 4 or 5 entries; missing plasticity defaults to 0 (fully elastic).
const setMat = (m) => { const a = new Float32Array(8); a.set(m.slice(0, 5)); device.queue.writeBuffer(mat, 0, a); };
setMat([3.0, 6.0, 0.6, -0.3, 0.0]); // validated defaults, plasticity OFF

// DETERMINISTIC seed jitter (fixed LCG) so settle/poke/persistence are reproducible
// run-to-run — the plasticity persistence contrast (elastic springs back vs plastic
// holds) is a few-percent footprint signal, so a fixed seed removes RNG variance.
let _sd = 0x13572468; const rnd = () => { _sd = (_sd * 1103515245 + 12345) & 0x7fffffff; return _sd / 0x7fffffff; };
const data = new Float32Array(FLOATS * N_REQ);
let n = 0;
outer: for (let i = 3; i < BOX[0] - 4; i += 0.65) for (let j = 0; j < BOX[1] * 0.8; j += 0.65) for (let k = 3; k < BOX[2] / 2; k += 0.65) {
  if (n >= N_REQ) break outer;
  const o = n * FLOATS;
  data[o] = i + rnd() * 2; data[o + 1] = j + rnd() * 2; data[o + 2] = k + rnd() * 2;
  data[o + 20] = 1; data[o + 24] = 1; data[o + 28] = 1; n++;
}
const N = n;
device.queue.writeBuffer(particleBuf, 0, data, 0, N * FLOATS);

const e = (bi, r) => ({ binding: bi, resource: { buffer: r } });
const bg = (pl, en) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: en });
let bgs;
try {
  bgs = {
    clearGrid: bg(pipes.clearGrid, [e(0, cellBuf)]),
    p2g_1: bg(pipes.p2g_1, [e(0, particleBuf), e(1, cellBuf), e(2, initBox)]),
    p2g_2: bg(pipes.p2g_2, [e(0, particleBuf), e(1, cellBuf), e(2, initBox), e(3, mat)]),       // binding 3 = material
    updateGrid: bg(pipes.updateGrid, [e(0, cellBuf), e(1, realBox), e(2, initBox), e(3, mat)]), // binding 3 = material
    g2p: bg(pipes.g2p, [e(0, particleBuf), e(1, cellBuf), e(2, realBox), e(3, initBox), e(4, mat)]), // binding 4 = material (reads .plasticity)
    copyPosition: bg(pipes.copyPosition, [e(0, particleBuf), e(1, posvelBuf)]),
    pointerForce: bg(pipes.pointerForce, [e(0, particleBuf), e(1, ptr)]),
  };
} catch (err) { console.log("BINDGROUP_ERROR (material binding 3 missing?):", err.message); Deno.exit(1); }

const wg = (x) => Math.ceil(x / 64);
function step(enc) {
  const p = enc.beginComputePass();
  for (let s = 0; s < SUBSTEPS; s++) for (const k of ["clearGrid", "p2g_1", "p2g_2", "updateGrid", "g2p", "copyPosition"]) {
    p.setBindGroup(0, bgs[k]); p.setPipeline(pipes[k]); p.dispatchWorkgroups(wg(k === "clearGrid" || k === "updateGrid" ? gridCount : N));
  }
  p.end();
}
function applyPoke(enc) { const p = enc.beginComputePass(); p.setBindGroup(0, bgs.pointerForce); p.setPipeline(pipes.pointerForce); p.dispatchWorkgroups(wg(N)); p.end(); }
function setPtr(o, d, f, r, on, press = 0) {
  const dl = Math.hypot(...d) || 1; const dn = d.map((x) => x / dl); let fl = Math.hypot(...f); if (fl > 1.5) f = f.map((x) => (x / fl) * 1.5);
  // A[7] = press (0..1 sustained-press ramp -> pointerForce radial-out + down spread)
  const A = new Float32Array(12); A[0] = o[0]; A[1] = o[1]; A[2] = o[2]; A[3] = r; A[4] = dn[0]; A[5] = dn[1]; A[6] = dn[2]; A[7] = Math.min(1, Math.max(0, press)); A[8] = f[0]; A[9] = f[1]; A[10] = f[2]; A[11] = on ? 1 : 0;
  device.queue.writeBuffer(ptr, 0, A);
}
const staging = b(STRUCT * N, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
async function stats() {
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(particleBuf, 0, staging, 0, STRUCT * N); device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ); const f = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap();
  let nan = 0, sx = 0, mp = 0, mf = 0;
  for (let i = 0; i < N; i++) { const o = i * FLOATS; for (let c = 0; c < 3; c++) { const v = f[o + c]; if (!Number.isFinite(v)) nan++; else mp = Math.max(mp, Math.abs(v)); } sx += f[o]; for (let c = 20; c < 32; c++) { const v = f[o + c]; if (Number.isFinite(v)) mf = Math.max(mf, Math.abs(v)); else nan++; } }
  return { meanX: sx / N, nan, mp, mf };
}
async function run(steps, poke) { for (let s = 0; s < steps; s++) { const enc = device.createCommandEncoder(); step(enc); if (poke) applyPoke(enc); device.queue.submit([enc.finish()]); } await device.queue.onSubmittedWorkDone(); }

console.log(`seeded ${N}; settling ${SETTLE} (default material)...`);
setPtr([0,0,0],[0,0,1],[0,0,0],0,false);
await run(SETTLE, false);
const before = await stats();
console.log(`[settled] meanX=${before.meanX.toFixed(2)} nan=${before.nan} max|F|=${before.mf.toFixed(2)}`);
setPtr([BOX[0]/2, BOX[1]*2, BOX[2]/2], [0,-1,0], [1.5,0,0], 6.0, true);
await run(POKE, true);
const after = await stats();
const dX = after.meanX - before.meanX;
console.log(`[poked]   meanX=${after.meanX.toFixed(2)} (ΔX=${dX.toFixed(2)}) nan=${after.nan} max|pos|=${after.mp.toFixed(1)} max|F|=${after.mf.toFixed(2)}`);
const pokeOK = after.nan === 0 && after.mp < BOX[0] * 2 && after.mf < 1e4 && dX > 0.3;

// slider-extreme sweep (re-seed each so a prior corner doesn't taint)
async function sweep(label, m) {
  device.queue.writeBuffer(particleBuf, 0, data, 0, N * FLOATS); setMat(m); setPtr([0,0,0],[0,0,1],[0,0,0],0,false);
  await run(60, false); const s = await stats();
  const ok = s.nan === 0 && s.mf < 1e4 && s.mp < BOX[0] * 2;
  console.log(`[sweep ${label}] mat=[${m}] nan=${s.nan} max|F|=${s.mf.toFixed(2)} -> ${ok ? "ok" : "FAIL"}`);
  return ok;
}
// Diagnostic ladder: isolate which param drives the blow-up + find the safe cap.
// Each corner now also sweeps plasticity (the SVD return-mapping must stay stable
// across the whole [0,1] range, especially plasticity=1 at the stiff corners).
const corners = [
  ["min   plas0    ", [1, 2, 0.1, 0.0, 0.0]],
  ["floam plas0.4  ", [3.5, 7, 0.8, -0.3, 0.4]],
  ["butter plas0.75", [3, 4, 1.2, -0.25, 0.75]],
  ["visc1.5 plas0.5", [3, 6, 1.5, -0.3, 0.5]],
  ["stiff plas1.0  ", [5, 10, 1.0, -0.5, 1.0]],
  ["MAX   plas1.0  ", [6, 12, 1.5, -0.6, 1.0]],
];
const res = [];
for (const [lab, m] of corners) res.push([lab, await sweep(lab, m)]);

// ---- PLASTICITY PERSISTENCE test ----------------------------------------------
// The payoff is that PLASTIC slime HOLDS a reshape while ELASTIC slime springs back.
// We assert it via the blob's settled-equilibrium HEIGHT (height = maxY-minY = "how
// flat"), which is a large-signal, low-noise, DETERMINISTIC proxy (the seed is fixed
// above). A strongly-plastic blob (p=0.9) yields under its own gravity through the SVD
// return-mapping and settles to a markedly flatter equilibrium that it HOLDS, whereas
// an elastic blob (p=0) springs back to a tall rest height. The margin is huge (~2x:
// elastic h~9, plastic h~5), so the gate is robust. We also sample at a couple of
// intermediate plasticities to confirm the trend is MONOTONE (more plasticity ->
// flatter hold), which rules out a one-off coincidence.
//
// (The complementary EXTENDED-PRESS dynamic — a sustained press flattens & the shape
//  persists, while a quick tap doesn't — is validated separately in press_harness.js,
//  which holds gravity low so the press-induced flatten isn't masked by gravity slump.
//  Here gravity is at the live default, so a p=0.9 blob ALREADY pancakes under gravity
//  before any press; that gravity-driven permanent slump is itself the plasticity
//  signal this test measures, and it's why a post-press height delta is not used here.)
async function heightY() {
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(particleBuf, 0, staging, 0, STRUCT * N); device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ); const f = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap();
  let lo = Infinity, hi = -Infinity, nan = 0, mf = 0;
  for (let i = 0; i < N; i++) {
    const o = i * FLOATS; const y = f[o + 1];
    if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
    for (let c = 20; c < 32; c++) { const v = f[o + c]; if (Number.isFinite(v)) mf = Math.max(mf, Math.abs(v)); else nan++; }
  }
  return { h: hi - lo, nan, mf };
}
// settle a fresh blob at the given plasticity to its equilibrium and return height.
async function settledHeight(plas) {
  device.queue.writeBuffer(particleBuf, 0, data, 0, N * FLOATS);
  setMat([3.5, 7, 0.8, -0.3, plas]);
  setPtr([0,0,0],[0,0,1],[0,0,0],0,false);
  await run(160, false);
  return heightY();
}
const hP0   = await settledHeight(0.0);
const hP06  = await settledHeight(0.6);
const hP09  = await settledHeight(0.9);
console.log(`[persist] settled height — elastic(p0)=${hP0.h.toFixed(2)}  moldable(p0.6)=${hP06.h.toFixed(2)}  plastic(p0.9)=${hP09.h.toFixed(2)} (more plasticity -> flatter, held)`);

const allFinite = [hP0, hP06, hP09].every((r) => r.nan === 0 && Number.isFinite(r.h) && r.mf < 1e4);
const plasticFlatter = hP09.h < hP0.h - 1.5;          // p0.9 settles >=1.5 flatter than elastic
const monotone       = hP09.h < hP06.h && hP06.h <= hP0.h + 0.5; // flatter (allow tiny p0->p0.6 wiggle)
const persistOK = allFinite && plasticFlatter && monotone;

const cornersOK = res.every(([, ok]) => ok);
console.log(`RESULT: poke=${pokeOK}; corners=${cornersOK}; persistence=${persistOK} (plastic settles & holds flatter than elastic, monotone in plasticity).`);
Deno.exit(pokeOK && cornersOK && persistOK ? 0 : 1);
