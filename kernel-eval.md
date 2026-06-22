# Slime Kernel Evaluation

Decision: pick one simulation kernel for an interactive, pointer-driven slime blob
running in-browser with zero install. Optimize for device reach and easy access, not
fidelity. Hard gate: the kernel must natively be able to represent **cohesive
viscoelastic deformation** (stretch, sag, snap-back, finger-poke). Dye/smoke advection
alone is disqualified for the core.

All facts below were verified against live sources on **2026-06-22** (repos cloned and
read; browser-support figures read from caniuse/vendor docs). Every external claim is
cited inline. No benchmark was run in this environment — see "Benchmark status".

---

## 1. Weighted decision matrix

Weights (sum 100): **Device reach 30 · Cold-load/bundle 15 · Mobile/iGPU perf 20 ·
Material fit (viscoelastic) 20 · License 10 · Solo maintainability 5.**
Scores 0–5 per axis. Weighted total = Σ(score/5 × weight), max 100.

| Kernel (ref repo) | Reach 30 | Load 15 | Perf 20 | Material 20 | License 10 | Maint 5 | **Total** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **MLS-MPM** — matsuoka-601/WebGPU-Ocean | 3 | 5 | 4 | 4 | 5 | 3 | **78** |
| **SPH** — jeantimex/fluid | 3 | 4 | 3 | 3 | 5 | 3 | **67** |
| **PIC/FLIP** — jeantimex/fluid | 3 | 4 | 3 | 2 | 5 | 2 | **62** |
| **Grid NS (Stam)** — kishimisu / PavelDoGreat | 5 | 5 | 5 | **0** | 5* | 5 | **80 → DQ** |

\* License score reflects the *usable* PavelDoGreat variant (MIT); the kishimisu WebGPU
variant has **no license at all** and is independently disqualified (see §4).

**Read this carefully:** Grid NS scores highest numerically (80) yet is **eliminated**.
The material requirement is a *gate*, not a weighted axis you can buy back with reach and
load time. A velocity field carrying dye has no material, so its "material fit" is 0 and
it fails the hard requirement regardless of total. Among kernels that clear the gate,
**MLS-MPM wins at 78.**

Scoring rationale (per axis, condensed):
- **Reach** — all three particle methods are WebGPU-only with no feasible WebGL2 port
  (compute + storage buffers + integer atomics; WebGL2 has none of these), so they tie at
  3: good (82.3% global WebGPU) but no native fallback. Grid NS via PavelDoGreat is
  WebGL2-with-WebGL1-fallback → ~universal, scores 5.
- **Load** — MLS-MPM core is ~600 LOC, near-vanilla, smallest extraction → 5; the
  jeantimex solvers live in a 45k-LOC, 12-demo repo (core ~1.2k LOC each, strippable) → 4.
- **Perf** — MLS-MPM claims the highest integrated-GPU ceiling (~100k particles) of the
  particle methods → 4; SPH neighbor search and FLIP's 20-iteration pressure projection are
  heavier on mobile → 3 each.
- **Material** — MLS-MPM is the recognized backbone for viscoelastic/elastoplastic MPM
  (snow, jelly, slime) → 4; SPH can take Clavet viscoelastic springs → 3; FLIP's grid
  projection dissipates elastic detail, worst particle base → 2; Grid NS cannot represent a
  material → 0.
- **License** — MIT across the board for the usable repos → 5.
- **Maint** — adding a deformation gradient + return mapping to MPM is real physics but
  well-trodden → 3; FLIP has the most moving parts (particles + MAC grid + pressure solve +
  transfer) → 2.

---

## 2. Ranked recommendation

**1st — MLS-MPM, forked from matsuoka-601/WebGPU-Ocean (MIT). This is the pick.**

It wins on the two axes that decide a slime game: **material fit** and **footprint**.
MLS-MPM is the standard, well-documented backbone for deformable elastic/viscoelastic
materials — the same transfer machinery (P2G → grid update → G2P with an APIC affine
matrix) that production snow/jelly/slime MPM is built on. The repo genuinely implements
MLS-MPM (verified: APIC affine `C`, quadratic B-spline weights, MLS stress scatter in
`mls-mpm/*.wgsl`), not a mislabeled SPH. The core is **~600 LOC** with near-vanilla deps
(`wgpu-matrix` + a radix sort you can drop), and it ships a ready-to-restyle **screen-space
fluid renderer** (depth → bilateral blur → normal reconstruction → Fresnel/thickness), so
you get a thick, refractive blob look for free. License is clean **MIT**
(`LICENSE`: "Copyright (c) 2025 matsuoka-601", standard permission grant). Claimed ceiling
~100k particles on integrated graphics / ~300k on decent GPUs (author claim, README §
"Performance", unverified hardware — see §6 benchmark status).

**The one real gap:** the shipped material is **Newtonian water**, not slime. The particle
struct carries no deformation gradient `F`; stress is pure Tait pressure + viscosity
(`p2g_2.wgsl`), so it has no memory of rest shape — no stretch-and-snap-back. You must
**add `F` + a Neo-Hookean/corotated elastic stress with a viscoelastic/plastic return
mapping** (the canonical MPM jelly/snow extension). That is net-new physics, but it is
exactly what MLS-MPM is *for*, and it is the same work on any particle base — and MPM needs
*less* of it than the alternatives, which is why it ranks first.

**2nd — SPH (jeantimex/fluid, MIT).** Viable backup. As shipped it gets you water→honey
(viscosity smoothing + repulsive near-pressure), but **no cohesion and no elastic memory** —
the repo cites Clavet 2005 yet only ported the double-density-relaxation half, not the
viscoelastic spring network (`grep spring|plastic|restLength` → zero hits). To get slime you
bolt on Clavet springs yourself. SPH is the *more natural* particle base for that than FLIP
(no grid projection to dissipate the springs), which is why it edges out #3.

**3rd — PIC/FLIP (jeantimex/fluid, MIT).** Same repo, real solver, but the worst slime base:
the grid pressure projection that makes FLIP good at incompressible water actively dissipates
the elastic detail you need for snap-back. More moving parts to maintain, less to show for it.

**DQ — Grid Navier-Stokes (Stam stable fluids).** Disqualified for the core (§4).

---

## 3. Material-fit honesty note

**None of the four kernels produces viscoelastic slime as shipped.** The decision is not
"which one is slime out of the box" — it's "which method class is the right kernel to *build*
slime on, with the least net-new code and the broadest reach." MLS-MPM is that class: the
viscoelastic extension is standard (nialltl's MLS-MPM guide; the MPM snow/jelly literature;
EA's `pbmpm`, which this repo already credits for the atomic trick). SPH is second
(Clavet springs). FLIP is a poor base. Grid NS cannot do it at all. The ranking reflects
*distance-to-slime*, and MLS-MPM is closest.

---

## 4. Kill criteria / disqualifiers (per candidate)

- **Grid NS — kishimisu/WebGPU-Fluid-Simulation:** **(a)** No LICENSE file anywhere in the
  repo → GitHub default is all-rights-reserved; you may not legally fork or redistribute it
  ([GitHub: choosealicense / "no license"](https://choosealicense.com/no-permission/)).
  **(b)** Wrong material model — passive RGB **dye advected on a velocity field**
  (`advectDyeShader`, `src/shaders.js`), no surface, no cohesion, no elasticity. **(c)**
  WebGPU-flag-only (2023, Chrome Canary "Unsafe WebGPU"). **Three independent kills.**
- **Grid NS — PavelDoGreat/WebGL-Fluid-Simulation:** Clean MIT
  ([LICENSE](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation/blob/master/LICENSE),
  "Copyright (c) 2017 Pavel Dobryakov"; the "sponsorship clause" rumor is false — it's only a
  `FUNDING.yml`), but **wrong material model**: dye on a velocity field, decays to nothing
  (`advectionShader`, `DENSITY_DISSIPATION`). **Killed for the core by the hard requirement.**
  Survives as a *secondary* layer (§5).
- **PIC/FLIP — jeantimex/fluid:** Not killed, but **deprioritized** — grid projection
  dissipates elastic detail; least suitable particle base for cohesive slime.
- **SPH — jeantimex/fluid:** Not killed — backup pick; requires adding a Clavet viscoelastic
  spring network (net-new code) for true slime behavior.
- **MLS-MPM — matsuoka-601/WebGPU-Ocean:** Not killed. Two caveats, neither fatal:
  **(1)** WebGPU-only, no WebGL2 path (handled by §5 fallback); **(2)** Newtonian material
  must be extended to viscoelastic (handled by §2/§7).

---

## 5. Fallback plan for devices without WebGPU

WebGPU global support is **82.3%** ([caniuse/webgpu](https://caniuse.com/webgpu), read
2026-06-22): default-on in Chrome/Edge 113+ desktop (May 2023,
[Chrome blog](https://developer.chrome.com/blog/webgpu-release)), Chrome 121+ on Android 12+
Qualcomm/ARM (Jan 2024, [Chrome blog](https://developer.chrome.com/blog/new-in-webgpu-121)),
Firefox 141+ **Windows-only** (Jul 2025,
[PCWorld](https://www.pcworld.com/article/2851602/firefox-is-finally-getting-webgpu-but-only-on-windows.html);
macOS 145 ARM-only, Linux/Android still off — [web.dev](https://web.dev/blog/webgpu-supported-major-browsers)),
and **iOS/macOS Safari 26** (~Sept 2025,
[WebKit WWDC25](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)).
That leaves ~18% with no WebGPU — plus pre-26 iPhones, Firefox on Linux/Mac/Android, and two
**unverified iOS risks**: WebGPU in **WKWebView/in-app browsers** (Instagram/Twitter link
opens) and **Lockdown Mode**. WebGL2 reaches **94.44%**
([caniuse/webgl2](https://caniuse.com/webgl2), 2026-06-22) — ~12 points more.

**An MPM kernel cannot be ported to WebGL2** (no compute shaders, no storage buffers, no
atomics; the whole P2G/G2P is compute+atomic). So the fallback is **graceful degradation to a
different, lighter representation that still satisfies the hard requirement**, not a port:

1. **Capability detection at boot:** `const a = await navigator.gpu?.requestAdapter()`. If
   `a` is null → load the WebGL2 path. If present, read `a.limits`
   (`maxStorageBufferBindingSize`, default 128 MiB —
   [MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits))
   and the `shader-f16` feature (standard on Apple GPUs —
   [WWDC25 WebGPU](https://dev.to/arshtechpro/wwdc-2025-webgpu-on-apple-platforms-16pa)) to
   **scale particle count by tier**: ~200k desktop, ~60–100k mobile WebGPU.
2. **WebGL2 fallback core (preserves the interaction):** a **2D XPBD / Verlet mass-spring
   blob** — a few hundred to a few thousand nodes with distance + bending constraints — rendered
   as a metaball surface (marching squares + threshold). This *keeps* cohesive viscoelastic
   behavior (stretch/sag/snap-back/poke) at lower fidelity in 2D, so even the fallback meets the
   hard requirement. Deliberately a *simple* second engine, not a second fluid sim, to bound
   maintenance.
3. **Secondary ambient layer (any device):** PavelDoGreat WebGL2 fluid (MIT) for background
   swirl/dye/ripple reacting to the blob's motion — runs on the same low-end hardware via its
   WebGL1 fallback. Strip its Google Analytics tag on adoption.
4. **No-go path:** if neither WebGPU nor WebGL2 (≪6%), show a static styled blob + "open in a
   modern browser." Verify the iOS WKWebView/Lockdown cases on a real device before launch.

---

## 6. Benchmark status

**No benchmark was run in this environment** — it has no GPU/browser harness, so the
particle-count-vs-framerate numbers are the repos' own documented claims and should be treated
as such: WebGPU-Ocean README claims ~100k particles on integrated graphics / ~300k on "decent
GPUs" for MLS-MPM (vs ~30k for its SPH path), with a fixed 64³ grid and only 2 substeps/frame
(the author notes the shipped `dt=0.20` is marginal: "occasionally the simulation explodes").
jeantimex/fluid claims "tens of thousands of particles at 60 FPS" with no hardware named and no
benchmark table — treat as marketing. **Before committing, run a smoke test on a mid-tier
Android (Adreno) and an iPhone (Safari 26) at 40k/70k/120k particles** with the elastic material
added, since the viscoelastic stress term raises per-particle cost above the shipped Newtonian
numbers.

---

## 7. Portability / precision trap — P2G integer atomics

WGSL has no float atomics, so both MLS-MPM and FLIP scatter particle mass/momentum to the grid
using **integer `atomicAdd` on a fixed-point encoding** — verified in both repos:

- WebGPU-Ocean (`p2g_1.wgsl`, `p2g_2.wgsl`): grid cells are `atomic<i32>`;
  `encodeFixedPoint(f) = i32(f * fixed_point_multiplier)` with **`fixed_point_multiplier = 1e7`**
  (`mls-mpm.ts`). An `i32` saturates at ±2.147e9, so each accumulated channel has only
  **±~214.7 of headroom** with a 1e-7 quantization step. Fine for the tuned water demo, but a
  **real ceiling for slime**: denser, stickier, higher-momentum material pushes per-cell sums
  toward that wall, where overflow wraps *silently* (corruption / blow-ups). Mitigation: lower
  the multiplier (trade precision for headroom), clamp velocities, or renormalize per cell.
- jeantimex FLIP (`flip_simulation.wgsl`): same pattern, `SCALE = 10000.0` → ~±2.1e5 headroom,
  ~1e-4 precision, no saturating guard.

This is the standard WebGPU MPM workaround (the repo credits EA `pbmpm`), not a bug — but it is
the first thing to re-tune when you raise mass/velocity for sticky material, and a real
portability gotcha if a driver handles i32 atomic overflow differently.

---

## 8. Build-risk assessment for a solo developer (one paragraph)

Standing up the fork is **low-risk**: MIT, ~600 LOC vanilla core, a ready screen-space
renderer, no framework. The risk concentrates in exactly one place — **extending the Newtonian
material to viscoelastic**: adding a per-particle deformation gradient `F`, a Neo-Hookean/
corotated elastic stress with a plastic/viscoelastic return mapping, widening the particle
struct, and re-tuning the 1e7 fixed-point atomic scale so sticky material doesn't overflow.
That is the highest-skill task in the project, but it is well-documented (nialltl's MLS-MPM
guide, the MPM snow/jelly literature, EA pbmpm) and is the same constitutive work any particle
method would need — MPM just needs the least of it. The second risk is **maintaining two paths**
(WebGPU MPM core + a WebGL2 fallback blob); bound it by keeping the fallback a deliberately
simple 2D XPBD metaball, not a second fluid sim. The third is **iOS verification** — WKWebView
in-app-browser WebGPU and Lockdown Mode are asserted but not primary-source-confirmed, so
device-test before relying on iOS WebGPU reach. Net: feasible for a competent solo dev over a
few weeks; the binary risk is the viscoelastic constitutive model, and it's a known, bounded
problem rather than open research.

---

### Sources
- caniuse WebGPU — https://caniuse.com/webgpu · WebGL2 — https://caniuse.com/webgl2 (read 2026-06-22)
- WebKit WWDC25 (Safari 26 WebGPU) — https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- web.dev WebGPU browser status — https://web.dev/blog/webgpu-supported-major-browsers
- Chrome 113 ship — https://developer.chrome.com/blog/webgpu-release · Chrome 121 Android — https://developer.chrome.com/blog/new-in-webgpu-121
- Firefox 141 Windows — https://www.pcworld.com/article/2851602/firefox-is-finally-getting-webgpu-but-only-on-windows.html
- MDN GPUSupportedLimits — https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits · WWDC25 WebGPU/f16 — https://dev.to/arshtechpro/wwdc-2025-webgpu-on-apple-platforms-16pa
- matsuoka-601/WebGPU-Ocean — https://github.com/matsuoka-601/WebGPU-Ocean (MIT; MLS-MPM + SPH; cloned & read)
- jeantimex/fluid — https://github.com/jeantimex/fluid (MIT; SPH + PIC/FLIP; cloned & read)
- kishimisu/WebGPU-Fluid-Simulation — https://github.com/kishimisu/WebGPU-Fluid-Simulation (NO LICENSE; Stam dye sim)
- PavelDoGreat/WebGL-Fluid-Simulation — https://github.com/PavelDoGreat/WebGL-Fluid-Simulation (MIT; Stam dye sim; WebGL2+WebGL1)
