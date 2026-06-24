// Headless GAMEPLAY SCREENSHOT of Slim3D (Deno + WebGPU/wgpu, real GPU).
// Runs the MLS-MPM sim to a nice blob state, then runs the FULL fluid render
// pipeline (depth -> bilateral -> thickness/gaussian -> fluid composite, with a
// procedural environment cubemap) into an OFFSCREEN rgba8unorm texture, reads the
// pixels back, and writes a PNG. No browser/canvas needed.
//   deno run --unstable-webgpu --allow-read --allow-write shot_harness.js [out.png]
//
// Tunables via env: SHOT_YAW, SHOT_PITCH, SHOT_DIST (radians/units), SHOT_PRESS=1
// to flatten the blob first, SHOT_W/SHOT_H pixels, SHOT_COLOR=r,g,b (0..1).

const SIM = "d:/SunnydayTech/Studio/Slim3D/mls-mpm";
const REND = "d:/SunnydayTech/Studio/Slim3D/render";
const OUT = Deno.args[0] || "d:/tmp/slim3d-validate/shot.png";
const E = Deno.env.get.bind(Deno.env);
const W = +(E("SHOT_W") || 1200), H = +(E("SHOT_H") || 900);
const YAW = +(E("SHOT_YAW") ?? Math.PI / 4);
const PITCH = +(E("SHOT_PITCH") ?? -0.5);
const DIST = +(E("SHOT_DIST") || 62);
const DO_PRESS = E("SHOT_PRESS") === "1";
const COL = (E("SHOT_COLOR") || "0.949,0.298,0.549").split(",").map(Number); // Glossy pink
const FOAM = +(E("SHOT_FOAM") || 0), GLOSS = +(E("SHOT_GLOSS") || 0.95), OPACITY = +(E("SHOT_OPACITY") || 0.85);

const STRUCT = 128, FLOATS = 32, CELL = 16, GRIDS = 64, FP = 1e6, DT = 0.10;
const BOX = [40, 30, 60], N_REQ = +(E("SHOT_N") || 70000);
const FOV = (45 * Math.PI) / 180, R_RADIUS = 0.6, DIAM = 2 * R_RADIUS;
const MAT = [4.0, 8.0, 0.6, -0.30, 0.10, 0, 0, 0]; // Glossy default material

// ---------- tiny column-major mat4 / vec3 math (WebGPU [0,1] depth) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), ri = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * ri, -1, 0, 0, near * far * ri, 0];
}
function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1];
}
function invert(m) {
  const inv = new Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let det = m[0]*inv[0]+m[1]*inv[4]+m[2]*inv[8]+m[3]*inv[12];
  det = 1 / det;
  return inv.map((v) => v * det);
}

// ---------- minimal PNG encoder (zlib stored blocks; no deps) ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length); body.set(t); body.set(data, t.length);
  return [u32(data.length), body, u32(crc32(body))];
}
async function zlibDeflate(raw) {
  // Real DEFLATE via the web-standard CompressionStream('deflate') = zlib (RFC1950),
  // exactly what a PNG IDAT wants -> small files (vs an uncompressed stored stream).
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter(); w.write(raw); w.close();
  const chunks = []; const r = cs.readable.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  return concat(chunks);
}
function concat(arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; }
  return o;
}
async function encodePNG(w, h, rgba) {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = concat([u32(w), u32(h), new Uint8Array([8, 6, 0, 0, 0])]);
  return concat([sig, ...chunk("IHDR", ihdr), ...chunk("IDAT", await zlibDeflate(raw)), ...chunk("IEND", new Uint8Array(0))]);
}

// ---------- device ----------
const adapter = await navigator.gpu?.requestAdapter();
if (!adapter) { console.log("NO_ADAPTER"); Deno.exit(2); }
const device = await adapter.requestDevice();
const rd = (d, f) => Deno.readTextFileSync(`${d}/${f}`);
const FMT = "rgba8unorm";

// sim shaders/pipelines (same as press_harness)
const simMods = {};
for (const f of ["clearGrid", "p2g_1", "p2g_2", "updateGrid", "g2p", "copyPosition", "pointerForce"])
  simMods[f] = device.createShaderModule({ code: rd(SIM, `${f}.wgsl`) });
const cp = (m, c) => device.createComputePipeline({ layout: "auto", compute: c ? { module: m, constants: c } : { module: m } });
const sp = {
  clearGrid: cp(simMods.clearGrid), p2g_1: cp(simMods.p2g_1, { fixed_point_multiplier: FP }),
  p2g_2: cp(simMods.p2g_2, { fixed_point_multiplier: FP, dt: DT, p_vol: 1.0 }),
  updateGrid: cp(simMods.updateGrid, { fixed_point_multiplier: FP, dt: DT }),
  g2p: cp(simMods.g2p, { fixed_point_multiplier: FP, dt: DT }), copyPosition: cp(simMods.copyPosition),
  pointerForce: cp(simMods.pointerForce),
};

// render shaders/pipelines (mirror fluidRender.ts)
const rMod = (f) => device.createShaderModule({ code: rd(REND, f) });
const mDepth = rMod("depthMap.wgsl"), mBilat = rMod("bilateral.wgsl"), mFluid = rMod("fluid.wgsl");
const mFull = rMod("fullScreen.wgsl"), mThick = rMod("thicknessMap.wgsl"), mGauss = rMod("gaussian.wgsl");
const mSphere = rMod("sphere.wgsl");
const MODE = E("SHOT_MODE") || "fluid";
const screenC = { screenWidth: W, screenHeight: H };
const filterC = { depth_threshold: R_RADIUS * 10, max_filter_size: 100, projected_particle_constant: (12 * DIAM * 0.05 * (H / 2)) / Math.tan(FOV / 2) };
const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
const rp = (desc) => device.createRenderPipeline(desc);
const depthMapPipe = rp({ layout: "auto", vertex: { module: mDepth }, fragment: { module: mDepth, targets: [{ format: "r32float" }] }, primitive: { topology: "triangle-list" }, depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth32float" } });
const depthFiltPipe = rp({ layout: "auto", vertex: { module: mFull, constants: screenC }, fragment: { module: mBilat, constants: filterC, targets: [{ format: "r32float" }] }, primitive: { topology: "triangle-list" } });
const thickMapPipe = rp({ layout: "auto", vertex: { module: mThick }, fragment: { module: mThick, targets: [{ format: "r16float", writeMask: GPUColorWrite.RED, blend: { color: { operation: "add", srcFactor: "one", dstFactor: "one" }, alpha: { operation: "add", srcFactor: "one", dstFactor: "one" } } }] }, primitive: { topology: "triangle-list" } });
const thickFiltPipe = rp({ layout: "auto", vertex: { module: mFull, constants: screenC }, fragment: { module: mGauss, targets: [{ format: "r16float" }] }, primitive: { topology: "triangle-list" } });
const fluidPipe = rp({ layout: "auto", vertex: { module: mFull, constants: screenC }, fragment: { module: mFluid, targets: [{ format: FMT }] }, primitive: { topology: "triangle-list" } });
const spherePipe = rp({ layout: "auto", vertex: { module: mSphere }, fragment: { module: mSphere, targets: [{ format: FMT }] }, primitive: { topology: "triangle-list" }, depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth32float" } });

// buffers
const maxGrid = GRIDS ** 3, gridCount = BOX[0] * BOX[1] * BOX[2];
const B = (size, usage) => device.createBuffer({ size, usage });
const S = GPUBufferUsage.STORAGE, U = GPUBufferUsage.UNIFORM, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
const particleBuf = B(STRUCT * N_REQ, S | CS | CD), cellBuf = B(CELL * maxGrid, S | CD), posvelBuf = B(32 * N_REQ, S | CD);
const realBox = B(12, U | CD), initBox = B(12, U | CD), ptr = B(64, U | CD), mat = B(32, U | CD);
const rUni = B(272, U | CD), styleBuf = B(32, U | CD);
device.queue.writeBuffer(realBox, 0, new Float32Array(BOX));
device.queue.writeBuffer(initBox, 0, new Float32Array(BOX));
device.queue.writeBuffer(mat, 0, new Float32Array(MAT));
device.queue.writeBuffer(styleBuf, 0, new Float32Array([COL[0], COL[1], COL[2], GLOSS, OPACITY, FOAM, 0, 0]));

// filter dir uniforms
const fxBuf = B(8, U | CD), fyBuf = B(8, U | CD);
device.queue.writeBuffer(fxBuf, 0, new Float32Array([1, 0]));
device.queue.writeBuffer(fyBuf, 0, new Float32Array([0, 1]));

// seed blob like the real initDambreak (i-outer, spacing 0.65, jitter 2)
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
console.log(`seeded ${N} particles`);

// offscreen render targets
const T = (fmt, usage) => device.createTexture({ size: [W, H, 1], format: fmt, usage }).createView();
const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
const depthMapTV = T("r32float", RA | TB), tmpDepthTV = T("r32float", RA | TB);
const thickTV = T("r16float", RA | TB), tmpThickTV = T("r16float", RA | TB);
const depthTestTV = T("depth32float", RA);
const finalTex = device.createTexture({ size: [W, H, 1], format: FMT, usage: RA | GPUTextureUsage.COPY_SRC });
const finalTV = finalTex.createView();

// procedural environment cubemap (soft studio: lighter top, darker bottom)
const CUBE = 32;
const cubeTex = device.createTexture({ size: [CUBE, CUBE, 6], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, dimension: "2d" });
for (let face = 0; face < 6; face++) {
  const px = new Uint8Array(CUBE * CUBE * 4);
  for (let y = 0; y < CUBE; y++) for (let x = 0; x < CUBE; x++) {
    const t = y / (CUBE - 1); // 0 top .. 1 bottom in face space
    // face 2 = +Y (sky, bright), face 3 = -Y (floor, dim); sides = vertical gradient
    let base;
    if (face === 2) base = [235, 240, 250];
    else if (face === 3) base = [120, 120, 130];
    else base = [200 - t * 90, 205 - t * 90, 220 - t * 80];
    const o = (y * CUBE + x) * 4;
    px[o] = base[0]; px[o + 1] = base[1]; px[o + 2] = base[2]; px[o + 3] = 255;
  }
  device.queue.writeTexture({ texture: cubeTex, origin: [0, 0, face] }, px, { bytesPerRow: CUBE * 4, rowsPerImage: CUBE }, [CUBE, CUBE, 1]);
}
const cubeTV = cubeTex.createView({ dimension: "cube" });

// bind groups
const bg = (pl, entries) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries });
const e = (b, r) => ({ binding: b, resource: r });
const eb = (b, buf) => ({ binding: b, resource: { buffer: buf } });
const simBG = {
  clearGrid: bg(sp.clearGrid, [eb(0, cellBuf)]),
  p2g_1: bg(sp.p2g_1, [eb(0, particleBuf), eb(1, cellBuf), eb(2, initBox)]),
  p2g_2: bg(sp.p2g_2, [eb(0, particleBuf), eb(1, cellBuf), eb(2, initBox), eb(3, mat)]),
  updateGrid: bg(sp.updateGrid, [eb(0, cellBuf), eb(1, realBox), eb(2, initBox), eb(3, mat)]),
  g2p: bg(sp.g2p, [eb(0, particleBuf), eb(1, cellBuf), eb(2, realBox), eb(3, initBox), eb(4, mat)]),
  copyPosition: bg(sp.copyPosition, [eb(0, particleBuf), eb(1, posvelBuf)]),
  pointerForce: bg(sp.pointerForce, [eb(0, particleBuf), eb(1, ptr)]),
};
const depthMapBG = bg(depthMapPipe, [eb(0, posvelBuf), eb(1, rUni)]);
const depthFiltBG = [bg(depthFiltPipe, [e(1, depthMapTV), eb(2, fxBuf)]), bg(depthFiltPipe, [e(1, tmpDepthTV), eb(2, fyBuf)])];
const thickMapBG = bg(thickMapPipe, [eb(0, posvelBuf), eb(1, rUni)]);
const thickFiltBG = [bg(thickFiltPipe, [e(1, thickTV), eb(2, fxBuf)]), bg(thickFiltPipe, [e(1, tmpThickTV), eb(2, fyBuf)])];
const fluidBG = bg(fluidPipe, [e(0, sampler), e(1, depthMapTV), eb(2, rUni), e(3, thickTV), e(4, cubeTV), eb(5, styleBuf)]);
const sphereBG = bg(spherePipe, [eb(0, posvelBuf), eb(1, rUni)]);

// sim step
const wg = (x) => Math.ceil(x / 64);
function step(enc) {
  const p = enc.beginComputePass();
  for (let s = 0; s < 4; s++)
    for (const k of ["clearGrid", "p2g_1", "p2g_2", "updateGrid", "g2p", "copyPosition"]) {
      p.setBindGroup(0, simBG[k]); p.setPipeline(sp[k]);
      p.dispatchWorkgroups(wg(k === "clearGrid" || k === "updateGrid" ? gridCount : N));
    }
  p.end();
}
function writePtr(o, d, f, r, press, on, contact = [0, 0, 0]) {
  const A = new Float32Array(16); const dl = Math.hypot(...d) || 1;
  A[0] = o[0]; A[1] = o[1]; A[2] = o[2]; A[3] = r;
  A[4] = d[0] / dl; A[5] = d[1] / dl; A[6] = d[2] / dl; A[7] = press;
  A[8] = f[0]; A[9] = f[1]; A[10] = f[2]; A[11] = on ? 1 : 0;
  A[12] = contact[0]; A[13] = contact[1]; A[14] = contact[2];
  device.queue.writeBuffer(ptr, 0, A);
}

// settle
writePtr([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, 0, false);
const SETTLE = +(E("SHOT_SETTLE") || 90);
for (let s = 0; s < SETTLE; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); }
await device.queue.onSubmittedWorkDone();

// centroid (for camera target + optional press center)
async function centroid() {
  const stg = B(STRUCT * N, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(particleBuf, 0, stg, 0, STRUCT * N); device.queue.submit([enc.finish()]);
  await stg.mapAsync(GPUMapMode.READ); const f = new Float32Array(stg.getMappedRange().slice(0)); stg.unmap();
  let sx = 0, sy = 0, sz = 0, lo = 1e9, hi = -1e9;
  for (let i = 0; i < N; i++) { const o = i * FLOATS; sx += f[o]; sy += f[o + 1]; sz += f[o + 2]; lo = Math.min(lo, f[o + 1]); hi = Math.max(hi, f[o + 1]); }
  return { cx: sx / N, cy: sy / N, cz: sz / N, ylo: lo, yhi: hi };
}
let c = await centroid();
console.log(`settled centroid=(${c.cx.toFixed(1)},${c.cy.toFixed(1)},${c.cz.toFixed(1)}) yrange=[${c.ylo.toFixed(1)},${c.yhi.toFixed(1)}]`);

if (DO_PRESS) {
  const contact = [c.cx, 4, c.cz];
  for (let s = 0; s < 120; s++) {
    const press = Math.min(1, s / 48);
    writePtr([c.cx, BOX[1] * 2, c.cz], [0, -1, 0], [0, -0.35, 0], 7, press, true, contact);
    const enc = device.createCommandEncoder(); step(enc); { const p = enc.beginComputePass(); p.setBindGroup(0, simBG.pointerForce); p.setPipeline(sp.pointerForce); p.dispatchWorkgroups(wg(N)); p.end(); } device.queue.submit([enc.finish()]);
  }
  writePtr([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, 0, false);
  for (let s = 0; s < 30; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); }
  await device.queue.onSubmittedWorkDone();
  c = await centroid();
}

// camera
const target = [c.cx, Math.max(2, (c.ylo + c.yhi) / 2), c.cz];
const eye = [target[0] + DIST * Math.cos(PITCH) * Math.sin(YAW), target[1] - DIST * Math.sin(PITCH), target[2] + DIST * Math.cos(PITCH) * Math.cos(YAW)];
const proj = perspective(FOV, W / H, 0.1, 500), view = lookAt(eye, target, [0, 1, 0]);
const uni = new Float32Array(68);
uni[0] = 1 / W; uni[1] = 1 / H; uni[2] = DIAM;
invert(proj).forEach((v, i) => uni[4 + i] = v);
proj.forEach((v, i) => uni[20 + i] = v);
view.forEach((v, i) => uni[36 + i] = v);
invert(view).forEach((v, i) => uni[52 + i] = v);
device.queue.writeBuffer(rUni, 0, uni);

// ---- render ----
device.pushErrorScope("validation");
const enc = device.createCommandEncoder();
const ca = (view, clear) => ({ view, clearValue: clear, loadOp: "clear", storeOp: "store" });
if (MODE === "sphere") {
  const pass = enc.beginRenderPass({ colorAttachments: [ca(finalTV, { r: 0.8, g: 0.8, b: 0.8, a: 1 })], depthStencilAttachment: { view: depthTestTV, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
  pass.setPipeline(spherePipe); pass.setBindGroup(0, sphereBG); pass.draw(6, N); pass.end();
} else {
let pass = enc.beginRenderPass({ colorAttachments: [ca(depthMapTV, { r: 0, g: 0, b: 0, a: 1 })], depthStencilAttachment: { view: depthTestTV, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
pass.setPipeline(depthMapPipe); pass.setBindGroup(0, depthMapBG); pass.draw(6, N); pass.end();
for (let i = 0; i < 4; i++) {
  pass = enc.beginRenderPass({ colorAttachments: [ca(tmpDepthTV, { r: 0, g: 0, b: 0, a: 1 })] });
  pass.setPipeline(depthFiltPipe); pass.setBindGroup(0, depthFiltBG[0]); pass.draw(6); pass.end();
  pass = enc.beginRenderPass({ colorAttachments: [ca(depthMapTV, { r: 0, g: 0, b: 0, a: 1 })] });
  pass.setPipeline(depthFiltPipe); pass.setBindGroup(0, depthFiltBG[1]); pass.draw(6); pass.end();
}
pass = enc.beginRenderPass({ colorAttachments: [ca(thickTV, { r: 0, g: 0, b: 0, a: 1 })] });
pass.setPipeline(thickMapPipe); pass.setBindGroup(0, thickMapBG); pass.draw(6, N); pass.end();
pass = enc.beginRenderPass({ colorAttachments: [ca(tmpThickTV, { r: 0, g: 0, b: 0, a: 1 })] });
pass.setPipeline(thickFiltPipe); pass.setBindGroup(0, thickFiltBG[0]); pass.draw(6); pass.end();
pass = enc.beginRenderPass({ colorAttachments: [ca(thickTV, { r: 0, g: 0, b: 0, a: 1 })] });
pass.setPipeline(thickFiltPipe); pass.setBindGroup(0, thickFiltBG[1]); pass.draw(6); pass.end();
pass = enc.beginRenderPass({ colorAttachments: [ca(finalTV, { r: 0.8, g: 0.8, b: 0.8, a: 1 })] });
pass.setPipeline(fluidPipe); pass.setBindGroup(0, fluidBG); pass.draw(6); pass.end();
}

// readback (256-aligned rows)
const bpr = Math.ceil(W * 4 / 256) * 256;
const readBuf = B(bpr * H, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
enc.copyTextureToBuffer({ texture: finalTex }, { buffer: readBuf, bytesPerRow: bpr, rowsPerImage: H }, [W, H, 1]);
device.queue.submit([enc.finish()]);
const errScope = await device.popErrorScope();
if (errScope) console.log("GPU VALIDATION ERROR:", errScope.message);
await readBuf.mapAsync(GPUMapMode.READ);
const padded = new Uint8Array(readBuf.getMappedRange().slice(0)); readBuf.unmap();
const rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) rgba.set(padded.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
// stats + force opaque (so transparent zeros read as BLACK, not viewer-white)
let mn = 255, mx = 0, asum = 0;
for (let i = 0; i < W * H; i++) { for (let ch = 0; ch < 3; ch++) { const v = rgba[i * 4 + ch]; mn = Math.min(mn, v); mx = Math.max(mx, v); } asum += rgba[i * 4 + 3]; rgba[i * 4 + 3] = 255; }
console.log(`pixel rgb range [${mn},${mx}] meanAlpha=${(asum / (W * H)).toFixed(0)}`);
Deno.writeFileSync(OUT, await encodePNG(W, H, rgba));
console.log(`wrote ${OUT} (${W}x${H})`);
