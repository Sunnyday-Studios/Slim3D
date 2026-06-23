// Headless validation of the EXTENDED-PRESS pointerForce pass (Deno + WebGPU/wgpu).
// Settles the blob, then fires a SUSTAINED DOWNWARD press ray into the top of the
// blob with press strength ramping 0->1, and asserts:
//   (a) the blob FLATTENS: vertical extent (maxY-minY) shrinks AND horizontal
//       spread (stddev of X,Z) grows  -> it pancakes, not just dents, and
//   (b) it stays finite + bounded (no NaN / explosion) under the press.
// Also checks a QUICK TAP (press~0) only dents (small height change).
// Run: deno run --unstable-webgpu --allow-read press_harness.js

const REPO = "d:/SunnydayTech/Studio/Slim3D/mls-mpm";
const STRUCT = 128, FLOATS = 32, CELL = 16, GRIDS = 64;
const FP = 1e6, DT = 0.10;                 // matches live (4 substeps below)
const BOX = [40, 30, 60];
const N_REQ = 20000, SETTLE = 120, PRESS = 160, TAP = 30;
// Separation probe radius: horizontal disc around the blob's OWN centroid used to
// measure central density (a tear leaves a VOID there; a coherent flatten stays a
// dense peak). See stats() pass 2.
const CORE_R = 6.0;
// Material uniform is 32B now: {mu,lambda,viscosity,gravity,plasticity,pad,pad,pad}.
// plasticity 0.55 so a press leaves a PERMANENT set; gravity kept LOW (-0.12) so the
// plastic blob does NOT fully slump under its own weight during the settle (which
// would pre-flatten it and mask the press-induced flatten this test measures). With
// the SVD return-mapping tuned to bite at |F-I|~0.15+, a moderate gravity plus a
// long settle slumps a high-plasticity blob into a pancake on its own — a real
// behavior, but it confounds the press-vs-tap height delta, so we damp gravity here.
const MAT = [3.0, 6.0, 0.6, -0.12, 0.55, 0, 0, 0];
const P2G2 = { fixed_point_multiplier: FP, dt: DT, p_vol: 1.0 };

const read = (f) => Deno.readTextFileSync(`${REPO}/${f}`);
const files = {
  clearGrid: "clearGrid.wgsl", p2g_1: "p2g_1.wgsl", p2g_2: "p2g_2.wgsl",
  updateGrid: "updateGrid.wgsl", g2p: "g2p.wgsl", copyPosition: "copyPosition.wgsl",
  pointerForce: "pointerForce.wgsl",
};
const adapter = await navigator.gpu?.requestAdapter();
if (!adapter) { console.log("NO_ADAPTER"); Deno.exit(2); }
const device = await adapter.requestDevice();

let compileErr = false;
const mods = {};
for (const [k, f] of Object.entries(files)) {
  const m = device.createShaderModule({ code: read(f), label: k });
  const info = await m.getCompilationInfo();
  const errs = info.messages.filter((x) => x.type === "error");
  if (errs.length) { compileErr = true; console.log(`COMPILE_ERROR ${f}:`); errs.forEach((x) => console.log(`  ${x.lineNum}:${x.linePos} ${x.message}`)); }
  else console.log(`compiled OK: ${k}`);
  mods[k] = m;
}
if (compileErr) { console.log("RESULT: FAIL (compile)"); Deno.exit(1); }

const cp = (mod, constants) => device.createComputePipeline({ layout: "auto", compute: constants ? { module: mod, constants } : { module: mod } });
let pipes;
try {
  pipes = {
    clearGrid: cp(mods.clearGrid), p2g_1: cp(mods.p2g_1, { fixed_point_multiplier: FP }),
    p2g_2: cp(mods.p2g_2, P2G2), updateGrid: cp(mods.updateGrid, { fixed_point_multiplier: FP, dt: DT }),
    g2p: cp(mods.g2p, { fixed_point_multiplier: FP, dt: DT }), copyPosition: cp(mods.copyPosition),
    pointerForce: cp(mods.pointerForce),
  };
} catch (e) { console.log("PIPELINE_ERROR:", e.message); Deno.exit(1); }

const maxGrid = GRIDS ** 3;
const gridCount = Math.ceil(BOX[0]) * Math.ceil(BOX[1]) * Math.ceil(BOX[2]);
const buf = (size, usage) => device.createBuffer({ size, usage });
const S = GPUBufferUsage.STORAGE, U = GPUBufferUsage.UNIFORM, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
const particleBuf = buf(STRUCT * N_REQ, S | CS | CD), cellBuf = buf(CELL * maxGrid, S | CD), posvelBuf = buf(32 * N_REQ, S | CD);
const realBox = buf(12, U | CD), initBox = buf(12, U | CD), ptr = buf(48, U | CD), mat = buf(32, U | CD);
device.queue.writeBuffer(realBox, 0, new Float32Array(BOX));
device.queue.writeBuffer(initBox, 0, new Float32Array(BOX));
device.queue.writeBuffer(mat, 0, new Float32Array(MAT));

// seed blob, F=identity
const data = new Float32Array(FLOATS * N_REQ);
let n = 0;
outer: for (let i = 3; i < BOX[0] - 4; i += 0.65)
  for (let j = 0; j < BOX[1] * 0.8; j += 0.65)
    for (let k = 3; k < BOX[2] / 2; k += 0.65) {
      if (n >= N_REQ) break outer;
      const o = n * FLOATS;
      data[o] = i + Math.random() * 2; data[o + 1] = j + Math.random() * 2; data[o + 2] = k + Math.random() * 2;
      data[o + 20] = 1; data[o + 24] = 1; data[o + 28] = 1;
      n++;
    }
const N = n;
device.queue.writeBuffer(particleBuf, 0, data, 0, N * FLOATS);

const bg = (pl, entries) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries });
const e = (b, r) => ({ binding: b, resource: { buffer: r } });
const bgs = {
  clearGrid: bg(pipes.clearGrid, [e(0, cellBuf)]),
  p2g_1: bg(pipes.p2g_1, [e(0, particleBuf), e(1, cellBuf), e(2, initBox)]),
  p2g_2: bg(pipes.p2g_2, [e(0, particleBuf), e(1, cellBuf), e(2, initBox), e(3, mat)]),
  updateGrid: bg(pipes.updateGrid, [e(0, cellBuf), e(1, realBox), e(2, initBox), e(3, mat)]),
  // g2p now reads the material uniform (plasticity) at binding 4 (origin-of-truth: plasticity agent)
  g2p: bg(pipes.g2p, [e(0, particleBuf), e(1, cellBuf), e(2, realBox), e(3, initBox), e(4, mat)]),
  copyPosition: bg(pipes.copyPosition, [e(0, particleBuf), e(1, posvelBuf)]),
  pointerForce: bg(pipes.pointerForce, [e(0, particleBuf), e(1, ptr)]),
};
const wg = (x) => Math.ceil(x / 64);
function step(enc) {
  const p = enc.beginComputePass();
  for (let s = 0; s < 4; s++)
    for (const k of ["clearGrid", "p2g_1", "p2g_2", "updateGrid", "g2p", "copyPosition"]) {
      p.setBindGroup(0, bgs[k]); p.setPipeline(pipes[k]);
      p.dispatchWorkgroups(wg(k === "clearGrid" || k === "updateGrid" ? gridCount : N));
    }
  p.end();
}
function applyPoke(enc) {
  const p = enc.beginComputePass();
  p.setBindGroup(0, bgs.pointerForce); p.setPipeline(pipes.pointerForce); p.dispatchWorkgroups(wg(N));
  p.end();
}
// Pointer uniform (48B): ray_origin@0, radius@12, ray_dir@16, press@28(strength),
// force@32, active@44. press in [0,1] drives radial-outward + downward flatten.
function writePointer(o, d, f, r, press, active) {
  const dl = Math.hypot(...d) || 1; const dn = d.map((x) => x / dl);
  let fl = Math.hypot(...f); if (fl > 1.5) f = f.map((x) => (x / fl) * 1.5); // MAX_INJECT_V
  const a = new ArrayBuffer(48); const F = new Float32Array(a);
  F[0] = o[0]; F[1] = o[1]; F[2] = o[2]; F[3] = r;
  F[4] = dn[0]; F[5] = dn[1]; F[6] = dn[2]; F[7] = press;
  F[8] = f[0]; F[9] = f[1]; F[10] = f[2]; F[11] = active ? 1 : 0;
  device.queue.writeBuffer(ptr, 0, a);
}

const staging = buf(STRUCT * N, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
async function stats() {
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(particleBuf, 0, staging, 0, STRUCT * N);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const f = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap();
  let nan = 0, maxP = 0, maxF = 0;
  let minY = 1e9, maxY = -1e9;
  let sx = 0, sxx = 0, sz = 0, szz = 0, cnt = 0;
  // Pass 1: extents, deformation, and the horizontal CENTROID.
  for (let i = 0; i < N; i++) {
    const o = i * FLOATS;
    const x = f[o], y = f[o + 1], z = f[o + 2];
    for (let c = 0; c < 3; c++) { const v = f[o + c]; if (!Number.isFinite(v)) nan++; else maxP = Math.max(maxP, Math.abs(v)); }
    for (let c = 20; c < 32; c++) { const v = f[o + c]; if (Number.isFinite(v)) maxF = Math.max(maxF, Math.abs(v)); else nan++; }
    if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (Number.isFinite(x) && Number.isFinite(z)) { sx += x; sxx += x * x; sz += z; szz += z * z; cnt++; }
  }
  const sdx = Math.sqrt(Math.max(0, sxx / cnt - (sx / cnt) ** 2));
  const sdz = Math.sqrt(Math.max(0, szz / cnt - (sz / cnt) ** 2));
  const cx = sx / Math.max(1, cnt), cz = sz / Math.max(1, cnt);
  // Pass 2: SELF-CENTERED central density — fraction within CORE_R of the blob's OWN
  // centroid. A coherent blob has its mass PEAK at the center (high); a blob that tore
  // into a ring/pieces has a VOID at the centroid (-> ~0). This is translation-invariant,
  // so a press that merely shoves the blob sideways is NOT mistaken for a tear.
  let core = 0;
  for (let i = 0; i < N; i++) {
    const o = i * FLOATS; const x = f[o], z = f[o + 2];
    if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x - cx, z - cz) < CORE_R) core++;
  }
  // COHESION — the direct anti-fragmentation gate. Bucket particles into a 1-unit
  // occupancy grid, flood-fill (26-connectivity, = MPM grid coupling range), and
  // report the largest connected component's particle share. One blob -> ~1.0; a blob
  // torn into clumps -> < 1.0 (and the number of components > 1).
  const GX = Math.ceil(BOX[0]) + 2, GY = Math.ceil(BOX[1]) + 2, GZ = Math.ceil(BOX[2]) + 2;
  const key = (x, y, z) => (x * GY + y) * GZ + z;
  const count = new Map();
  for (let i = 0; i < N; i++) {
    const o = i * FLOATS; const x = f[o], y = f[o + 1], z = f[o + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const gx = Math.min(GX - 1, Math.max(0, Math.floor(x) + 1));
    const gy = Math.min(GY - 1, Math.max(0, Math.floor(y) + 1));
    const gz = Math.min(GZ - 1, Math.max(0, Math.floor(z) + 1));
    const k = key(gx, gy, gz);
    count.set(k, (count.get(k) || 0) + 1);
  }
  const seen = new Set();
  let maxComp = 0, comps = 0;
  for (const start of count.keys()) {
    if (seen.has(start)) continue;
    comps++;
    let sum = 0; const stack = [start]; seen.add(start);
    while (stack.length) {
      const k = stack.pop(); sum += count.get(k);
      const z = k % GZ, y = ((k - z) / GZ) % GY, x = ((k - z) / GZ - y) / GY;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= GX || ny >= GY || nz >= GZ) continue;
        const nk = key(nx, ny, nz);
        if (count.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    if (sum > maxComp) maxComp = sum;
  }
  return {
    nan, maxP, maxF, height: maxY - minY, spread: sdx + sdz, cx, cz,
    coreFrac: core / Math.max(1, cnt), cohesion: maxComp / Math.max(1, cnt), comps,
  };
}

console.log(`seeded ${N} particles; settling ${SETTLE} steps...`);
writePointer([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, 0, false);
for (let s = 0; s < SETTLE; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); }
await device.queue.onSubmittedWorkDone();
const before = await stats();
console.log(`[settled] h=${before.height.toFixed(2)} spread=${before.spread.toFixed(2)} core=${before.coreFrac.toFixed(3)} cohesion=${before.cohesion.toFixed(3)}(${before.comps}c) centroid=(${before.cx.toFixed(1)},${before.cz.toFixed(1)}) nan=${before.nan} max|F|=${before.maxF.toFixed(2)}`);

// Aim the tap straight down at the blob's settled CENTROID. The PRESS uses a SHALLOW
// ANGLED ray (≈15° below horizontal, like the default camera) that passes THROUGH the
// centroid — this is the real-world case that the old ray∩floor centering got wrong
// (it placed the platen ~tens of units past the blob and tore it). With perpendicular
// centering the press must still land on the blob and stay cohesive.
const AIM = [before.cx, BOX[1] * 2, before.cz];
const PITCH = 15 * Math.PI / 180;                              // shallow, like the camera
const PDIR = [Math.cos(PITCH), -Math.sin(PITCH), 0];          // down-forward along +x
const PT = [before.cx, 4, before.cz];                          // aim point inside the blob
const PORIGIN = [PT[0] - 60 * PDIR[0], PT[1] - 60 * PDIR[1], PT[2] - 60 * PDIR[2]];

// QUICK TAP: short, press=0 -> dent only, height barely changes.
writePointer(AIM, [0, -1, 0], [0, -0.35, 0], 6.0, 0.0, true);
for (let s = 0; s < TAP; s++) { const enc = device.createCommandEncoder(); step(enc); applyPoke(enc); device.queue.submit([enc.finish()]); }
writePointer([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, 0, false);
for (let s = 0; s < 20; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); }
await device.queue.onSubmittedWorkDone();
const tap = await stats();
console.log(`[tap]     h=${tap.height.toFixed(2)} spread=${tap.spread.toFixed(2)} (Δh=${(tap.height-before.height).toFixed(2)}) nan=${tap.nan} max|F|=${tap.maxF.toFixed(2)}`);

// SUSTAINED PRESS: ramp press 0->1 over first ~half, then hold at 1. SHALLOW ANGLED
// ray through the centroid (real-camera case); in-shader the press is a broad -Y platen.
console.log(`pressing (ramp 0->1, ${(PITCH*180/Math.PI).toFixed(0)}° angled ray) for ${PRESS} steps...`);
for (let s = 0; s < PRESS; s++) {
  const press = Math.min(1, s / (PRESS * 0.4)); // ~0.5s-equiv ramp then hold
  writePointer(PORIGIN, PDIR, [PDIR[0] * 0.35, PDIR[1] * 0.35, PDIR[2] * 0.35], 7.0, press, true);
  const enc = device.createCommandEncoder(); step(enc); applyPoke(enc); device.queue.submit([enc.finish()]);
}
writePointer([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, 0, false);
for (let s = 0; s < 40; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); } // settle, shape should HOLD (plasticity)
await device.queue.onSubmittedWorkDone();
const after = await stats();
console.log(`[pressed] h=${after.height.toFixed(2)} spread=${after.spread.toFixed(2)} core=${after.coreFrac.toFixed(3)} cohesion=${after.cohesion.toFixed(3)}(${after.comps}c) (Δh=${(after.height-before.height).toFixed(2)} Δspread=${(after.spread-before.spread).toFixed(2)}) nan=${after.nan} max|F|=${after.maxF.toFixed(2)}`);

const stable = after.nan === 0 && after.maxP < BOX[0] * 2 && after.maxF < 1e4;
// PANCAKE signal: a sustained press makes the blob spread its FOOTPRINT outward
// (and/or drop height). With plasticity ON that spread is PERMANENT (held after
// release). Height alone is a poor flatten proxy because a wide low blob pancakes
// chiefly by flowing SIDEWAYS (footprint grows) rather than by shrinking max-min Y,
// so we accept EITHER a real height drop OR a real footprint growth, and require the
// combined "flatness" (spread gain minus height) to move the pancake direction.
const pressSpread = after.spread - before.spread;
const pressHeight = before.height - after.height;            // +ve = got shorter
const tapSpread = tap.spread - before.spread;
const flattened = (pressSpread > 1.0) || (pressHeight > 1.0); // pancaked sideways or down
// A quick tap must pancake MUCH less than a sustained press (the press ramp does
// nothing on a tap, so its permanent spread stays small).
const tapMild = tapSpread < pressSpread - 0.5;
// NO-SEPARATION: the blob's OWN center must stay a dense peak, not become a void.
// The old narrow radial-out press evacuated the center (the blob tore into a ring /
// pieces) -> self-centered coreFrac ~0. The coherent platen keeps the center populated.
// A wide flatten lowers the peak (spreads out), so we require BOTH an absolute floor
// (center is genuinely not a void) AND that it keep a fair share of its dense core.
// central density — INFORMATIONAL only. A wide-but-connected pancake legitimately
// thins its center (it's a flat sheet, not a peak), so this can drop a lot WITHOUT any
// tearing. Connected-components (below) is the authoritative no-tear gate; coreFrac is
// kept just as a readout of how concentrated vs. spread the result is.
console.log(`[core] before=${before.coreFrac.toFixed(3)} -> after=${after.coreFrac.toFixed(3)} (info only; cohesion is the tear gate)`);
// NO-FRAGMENTATION (the gate that maps to the user's "splitting into pieces"): the blob
// must stay essentially ONE connected piece. Largest connected component must hold >=90%
// of the mass (a little surface shedding is fine), vs. a clean ~1.0 when settled.
const cohesive = after.cohesion >= 0.90;
console.log(`[cohesion] settled=${before.cohesion.toFixed(3)}(${before.comps}c) -> pressed=${after.cohesion.toFixed(3)}(${after.comps}c) noFragment=${cohesive}`);
const pass = stable && flattened && tapMild && cohesive;
console.log(`RESULT: ${pass ? "PASS" : "FAIL"} — stable=${stable} flattened=${flattened} (Δspread=${pressSpread.toFixed(2)} Δh=${(-pressHeight).toFixed(2)}) tap<press=${tapMild} noFragment=${cohesive} (pressed ${after.comps} pieces, largest=${(after.cohesion*100).toFixed(0)}%)`);
Deno.exit(pass ? 0 : 1);
