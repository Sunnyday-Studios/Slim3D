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

// ---------- self-contained animated-GIF encoder (median-cut palette + LZW). No deps. ----------
function medianCut(samples, maxColors) {
  const range = (px) => {
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const p of px) { if (p[0] < r0) r0 = p[0]; if (p[0] > r1) r1 = p[0]; if (p[1] < g0) g0 = p[1]; if (p[1] > g1) g1 = p[1]; if (p[2] < b0) b0 = p[2]; if (p[2] > b1) b1 = p[2]; }
    return [r1 - r0, g1 - g0, b1 - b0];
  };
  let boxes = [samples];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1, bch = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const r = range(boxes[i]); const m = Math.max(r[0], r[1], r[2]);
      if (m > best) { best = m; bi = i; bch = r[0] >= r[1] && r[0] >= r[2] ? 0 : (r[1] >= r[2] ? 1 : 2); }
    }
    if (bi < 0) break;
    const box = boxes[bi]; box.sort((a, b) => a[bch] - b[bch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bb = 0; for (const p of b) { r += p[0]; g += p[1]; bb += p[2]; }
    const n = b.length || 1; return [Math.round(r / n), Math.round(g / n), Math.round(bb / n)];
  });
}
function buildLUT(palette) { // 5-bit-per-channel nearest-palette LUT for fast mapping
  const lut = new Uint8Array(32768);
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const R = r * 8 + 4, G = g * 8 + 4, B = b * 8 + 4; let bi = 0, bd = 1e18;
    for (let i = 0; i < palette.length; i++) { const p = palette[i]; const d = (p[0] - R) ** 2 + (p[1] - G) ** 2 + (p[2] - B) ** 2; if (d < bd) { bd = d; bi = i; } }
    lut[(r << 10) | (g << 5) | b] = bi;
  }
  return lut;
}
function mapFrame(rgba, lut) {
  const n = rgba.length / 4, idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) idx[i] = lut[((rgba[i * 4] >> 3) << 10) | ((rgba[i * 4 + 1] >> 3) << 5) | (rgba[i * 4 + 2] >> 3)];
  return idx;
}
function lzwEncode(minCodeSize, pixels) {
  const out = []; let acc = 0, nbits = 0;
  const write = (code, len) => { acc |= code << nbits; nbits += len; while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; } };
  const clearCode = 1 << minCodeSize, eoi = clearCode + 1;
  let codeSize = minCodeSize + 1, table = new Map(), next = clearCode + 2;
  const reset = () => { table = new Map(); next = clearCode + 2; codeSize = minCodeSize + 1; };
  write(clearCode, codeSize);
  let cur = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i], key = cur * 256 + k;
    if (table.has(key)) { cur = table.get(key); }
    else {
      write(cur, codeSize);
      // bump code size BEFORE assigning the new entry (matches the reference decoder's
      // table-growth timing; bumping AFTER next++ is the classic off-by-one that corrupts).
      if (next < 4096) { if (next === (1 << codeSize) && codeSize < 12) codeSize++; table.set(key, next); next++; }
      else { write(clearCode, codeSize); reset(); }
      cur = k;
    }
  }
  write(cur, codeSize); write(eoi, codeSize);
  if (nbits > 0) out.push(acc & 255);
  return out;
}
function encodeGIF(w, h, framesIdx, palette, delayCs) {
  // FRAME DIFFERENCING: a static background (the tabletop) is encoded only in frame 0;
  // later frames store just the bbox of CHANGED pixels, with unchanged ones set to a
  // reserved TRANSPARENT index and disposal=1 (do not dispose) so the prior frame shows
  // through. Keeps a textured-background GIF tiny. (palette must be <=255 to leave the
  // transparent slot free.)
  const TRANS = palette.length;                                       // reserved transparent index
  const b = []; const u16 = (n) => b.push(n & 255, (n >> 8) & 255);
  const str = (s) => { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); };
  let bits = 1; while ((1 << bits) < palette.length + 1) bits++;       // room for TRANS
  const gctSize = 1 << bits, minCodeSize = Math.max(2, bits);
  str("GIF89a"); u16(w); u16(h); b.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < gctSize; i++) { const c = palette[i] || [0, 0, 0]; b.push(c[0], c[1], c[2]); }
  b.push(0x21, 0xff, 0x0b); str("NETSCAPE2.0"); b.push(0x03, 0x01); u16(0); b.push(0x00); // loop forever
  let prev = null;
  for (let fi = 0; fi < framesIdx.length; fi++) {
    const cur = framesIdx[fi];
    let x0 = 0, y0 = 0, bw = w, bh = h, sub, transFlag = 0;
    if (fi === 0) { sub = cur; }                                       // full opaque base
    else {
      let minx = w, miny = h, maxx = -1, maxy = -1;
      const diff = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (cur[i] === prev[i]) diff[i] = TRANS;
        else { diff[i] = cur[i]; const px = i % w, py = (i / w) | 0; if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
      }
      transFlag = 1;
      if (maxx < 0) { bw = 1; bh = 1; sub = new Uint8Array([TRANS]); }
      else {
        x0 = minx; y0 = miny; bw = maxx - minx + 1; bh = maxy - miny + 1;
        sub = new Uint8Array(bw * bh);
        for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) sub[yy * bw + xx] = diff[(y0 + yy) * w + (x0 + xx)];
      }
    }
    b.push(0x21, 0xf9, 0x04, (1 << 2) | transFlag); u16(delayCs); b.push(transFlag ? TRANS : 0, 0x00); // GCE: disposal=1
    b.push(0x2c); u16(x0); u16(y0); u16(bw); u16(bh); b.push(0x00);    // image descriptor (sub-rect)
    b.push(minCodeSize);
    const lzw = lzwEncode(minCodeSize, sub);
    for (let i = 0; i < lzw.length; i += 255) { const c = lzw.slice(i, i + 255); b.push(c.length); for (const x of c) b.push(x); }
    b.push(0x00);
    prev = cur;
  }
  b.push(0x3b);
  return Uint8Array.from(b);
}

// ---------- procedural tabletop (wood / granite / marble) ----------
function tableTexture(w, h, kind) {
  const px = new Uint8Array(w * h * 4);
  const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
  const vnoise = (x, y) => { // value noise, smooth-interpolated
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    const ux = xf * xf * (3 - 2 * xf), uy = yf * yf * (3 - 2 * yf);
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
  };
  const turb = (x, y) => { let t = 0, f = 1, a = 1; for (let o = 0; o < 6; o++) { t += Math.abs(vnoise(x * f, y * f) - 0.5) * 2 * a; f *= 2; a *= 0.5; } return t; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h; let r, g, b;
    if (kind === "marble") {
      // classic veined marble: a sine band warped by fractal turbulence -> organic veins.
      const sx = u * 5.5, sy = v * 4.2;
      const tb = turb(sx, sy);
      const m = Math.sin((sx + sy * 0.4 + tb * 2.4) * 2.0);   // primary vein field [-1,1]
      let L = 70 + 175 * Math.pow(0.5 + 0.5 * m, 0.75);        // light base, dark veins
      // a few sharp dark hairline veins where the warped field crosses zero
      L -= Math.pow(1 - Math.abs(m), 14) * 70;
      L -= Math.pow(1 - Math.abs(Math.sin((sy * 1.7 + turb(sy, sx) * 2.0) * 2.0)), 18) * 55;
      L += (hash(x * 1.3, y * 1.3) - 0.5) * 14;                // fine grain
      L = Math.max(28, Math.min(250, L));
      r = L * 0.99; g = L; b = L * 1.03;                       // faint cool tint
    } else if (kind === "granite") {
      // high-contrast salt-and-pepper stone: black + white grains over mottled mid-gray
      const mott = vnoise(x * 0.18, y * 0.18);
      let base = 55 + mott * 120 + (hash(x, y) - 0.5) * 130;   // strong per-pixel speckle
      if (hash(x * 2.7, y * 3.9) > 0.972) base = 235;          // bright white flecks
      if (hash(x * 4.1, y * 1.7) < 0.028) base = 18;           // black flecks
      base = Math.max(10, Math.min(245, base));
      r = base * 0.98; g = base; b = base * 1.05;
    } else {                                                   // walnut wood
      const ring = 0.5 + 0.5 * Math.sin((v * 26 + Math.sin(u * 5.0) * 1.2 + hash(0, Math.floor(v * 26)) * 2) * Math.PI);
      const fiber = 0.5 + 0.5 * Math.sin(v * 220 + u * 4);
      const t = 0.46 + 0.30 * ring + 0.10 * fiber + 0.10 * (hash(x * 0.5, y * 2.0) - 0.5);
      r = 120 * t; g = 78 * t; b = 46 * t;
    }
    const light = 1.0 + 0.16 * (1 - (u * 0.6 + v));            // soft upper-left light
    const dx = u - 0.5, dy = v - 0.55, vig = 1 - 0.9 * (dx * dx + dy * dy); // gentle vignette
    const m = Math.max(0.3, light * vig);
    const o = (y * w + x) * 4;
    px[o] = Math.min(255, r * m); px[o + 1] = Math.min(255, g * m); px[o + 2] = Math.min(255, b * m); px[o + 3] = 255;
  }
  return px;
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
const mDepth = rMod("depthMap.wgsl"), mBilat = rMod("bilateral.wgsl");
// fluid.wgsl, modified to sample a BACKGROUND TEXTURE (the wood/granite tabletop) instead
// of the hard-coded flat gray. bgColor feeds BOTH the empty background AND the slime's
// refraction, so the slime tints the wood beneath it. (Harness-only string patch; the
// game's render/fluid.wgsl is untouched.)
let fluidSrc = rd(REND, "fluid.wgsl");
fluidSrc = fluidSrc.replace("@group(0) @binding(5) var<uniform> style: SlimeStyle;",
  "@group(0) @binding(5) var<uniform> style: SlimeStyle;\n@group(0) @binding(6) var bg_texture: texture_2d<f32>;");
fluidSrc = fluidSrc.replace("let bgColor: vec3f = vec3f(0.8, 0.8, 0.8);",
  "let bgColor: vec3f = textureSampleLevel(bg_texture, texture_sampler, input.uv, 0.0).rgb;");
const mFluid = device.createShaderModule({ code: fluidSrc });
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

// background sampled by the (patched) fluid shader's bgColor. wood/granite = textured
// tabletop; flat = a solid dark color (huge uniform area => GIFs compress tiny).
const BG_KIND = E("SHOT_BG") || "wood";
let bgPx;
if (BG_KIND === "flat") {
  const c = (E("SHOT_BGCOLOR") || "34,30,28").split(",").map(Number);
  bgPx = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { bgPx[i * 4] = c[0]; bgPx[i * 4 + 1] = c[1]; bgPx[i * 4 + 2] = c[2]; bgPx[i * 4 + 3] = 255; }
} else bgPx = tableTexture(W, H, BG_KIND);
const bgTex = device.createTexture({ size: [W, H, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
device.queue.writeTexture({ texture: bgTex }, bgPx, { bytesPerRow: W * 4, rowsPerImage: H }, [W, H, 1]);
const bgTV = bgTex.createView();

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
const fluidBG = bg(fluidPipe, [e(0, sampler), e(1, depthMapTV), eb(2, rUni), e(3, thickTV), e(4, cubeTV), eb(5, styleBuf), e(6, bgTV)]);
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

// ---- shared render helpers ----
const ca = (view, clear) => ({ view, clearValue: clear, loadOp: "clear", storeOp: "store" });
const bpr = Math.ceil(W * 4 / 256) * 256;
const readBuf = B(bpr * H, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
async function readback(enc) {
  enc.copyTextureToBuffer({ texture: finalTex }, { buffer: readBuf, bytesPerRow: bpr, rowsPerImage: H }, [W, H, 1]);
  device.queue.submit([enc.finish()]);
  const err = await device.popErrorScope(); if (err) console.log("GPU VALIDATION ERROR:", err.message);
  await readBuf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(readBuf.getMappedRange().slice(0)); readBuf.unmap();
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) rgba.set(padded.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255; // opaque
  return rgba;
}
async function renderFluid() {
  device.pushErrorScope("validation");
  const enc = device.createCommandEncoder();
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
  return await readback(enc);
}
async function renderSphere() {
  device.pushErrorScope("validation");
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [ca(finalTV, { r: 0.8, g: 0.8, b: 0.8, a: 1 })], depthStencilAttachment: { view: depthTestTV, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
  pass.setPipeline(spherePipe); pass.setBindGroup(0, sphereBG); pass.draw(6, N); pass.end();
  return await readback(enc);
}
function setCamera(target, dist) {
  const eye = [target[0] + dist * Math.cos(PITCH) * Math.sin(YAW), target[1] - dist * Math.sin(PITCH), target[2] + dist * Math.cos(PITCH) * Math.cos(YAW)];
  const proj = perspective(FOV, W / H, 0.1, 500), view = lookAt(eye, target, [0, 1, 0]);
  const uni = new Float32Array(68);
  uni[0] = 1 / W; uni[1] = 1 / H; uni[2] = DIAM;
  invert(proj).forEach((v, i) => uni[4 + i] = v);
  proj.forEach((v, i) => uni[20 + i] = v);
  view.forEach((v, i) => uni[36 + i] = v);
  invert(view).forEach((v, i) => uni[52 + i] = v);
  device.queue.writeBuffer(rUni, 0, uni);
}
async function centroid() {
  const stg = B(STRUCT * N, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(particleBuf, 0, stg, 0, STRUCT * N); device.queue.submit([enc.finish()]);
  await stg.mapAsync(GPUMapMode.READ); const f = new Float32Array(stg.getMappedRange().slice(0)); stg.unmap();
  let sx = 0, sy = 0, sz = 0, lo = 1e9, hi = -1e9;
  for (let i = 0; i < N; i++) { const o = i * FLOATS; sx += f[o]; sy += f[o + 1]; sz += f[o + 2]; lo = Math.min(lo, f[o + 1]); hi = Math.max(hi, f[o + 1]); }
  return { cx: sx / N, cy: sy / N, cz: sz / N, ylo: lo, yhi: hi };
}

writePtr([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, 0, false); // idle pointer

if (E("SHOT_GIF") === "1") {
  // ---- DROP + JIGGLE animation (fixed camera, captured AS the seeded block falls + wobbles) ----
  setCamera([+(E("GIF_TX") || BOX[0] / 2 - 1), +(E("GIF_TY") || 7), +(E("GIF_TZ") || 20)], DIST);
  const FRAMES = +(E("GIF_FRAMES") || 38), EVERY = +(E("GIF_EVERY") || 2), DELAY = +(E("GIF_DELAY") || 50);
  const rgbaFrames = [];
  for (let fi = 0; fi < FRAMES; fi++) {
    for (let s = 0; s < EVERY; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); }
    rgbaFrames.push(await renderFluid());
    if (fi % 8 === 0) console.log(`frame ${fi + 1}/${FRAMES}`);
  }
  // shared palette from sampled pixels across the sequence, then map + LZW each frame
  const samples = [];
  for (const f of rgbaFrames) for (let i = 0; i < W * H; i += 137) samples.push([f[i * 4], f[i * 4 + 1], f[i * 4 + 2]]);
  const palette = medianCut(samples, 255); // 255 colors + 1 reserved transparent index
  const lut = buildLUT(palette);
  const framesIdx = rgbaFrames.map((f) => mapFrame(f, lut));
  const gif = encodeGIF(W, H, framesIdx, palette, Math.round(DELAY / 10));
  Deno.writeFileSync(OUT, gif);
  console.log(`wrote ${OUT} GIF ${W}x${H} ${FRAMES}f ${(gif.length / 1024) | 0}KB`);
} else {
  // ---- single still ----
  const SETTLE = +(E("SHOT_SETTLE") || 90);
  for (let s = 0; s < SETTLE; s++) { const enc = device.createCommandEncoder(); step(enc); device.queue.submit([enc.finish()]); }
  await device.queue.onSubmittedWorkDone();
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
  setCamera([c.cx, Math.max(2, (c.ylo + c.yhi) / 2), c.cz], DIST);
  const rgba = MODE === "sphere" ? await renderSphere() : await renderFluid();
  Deno.writeFileSync(OUT, await encodePNG(W, H, rgba));
  console.log(`wrote ${OUT} (${W}x${H})`);
}
