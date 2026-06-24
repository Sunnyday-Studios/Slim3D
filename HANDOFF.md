# Slim3D — Session Hand-off

**Read this first.** Clean breaking point as of commit `8d2d841` (Press-flatten even platen).
Everything below "Done" is committed, headless-validated, and deployed live. Next session starts
at **Mix-ins** (§Remaining).

---

## 1. What this is

Interactive slime blob, **MLS-MPM on WebGPU**, zero-install browser game. Open-source
freeware. Kernel-selection rationale: [kernel-eval.md](kernel-eval.md).

- **Repo:** https://github.com/Sunnyday-Studios/Slim3D (public, MIT; fork of
  matsuoka-601/WebGPU-Ocean, attribution in `LICENSE.upstream`)
- **Live (Cloudflare Pages):** https://slim3d.pages.dev
- **Live (itch.io):** https://sunnydaytech.itch.io/slime-and-stuff (channel `html5`)
- **HEAD:** `main` @ `e952c35`. `git log --oneline` is the milestone history.

## 2. Done (committed + validated + live)

| Milestone | Commit | Notes |
|---|---|---|
| M0 scaffold + render | (initial) | Confirmed rendering on real iPhone @ 60fps / 70k particles |
| M1 viscoelastic material | `5ecbf40` | Fixed-corotated elastic, polar decomposition |
| Slime Lab | `8e8eb1d` | 6 type presets + color + finish + live physics sliders + foam; physics moved to a runtime **Material uniform** |
| M2 poke + touch | `ef842a0` | 1-finger poke / 2-finger orbit+pinch / mouse |
| itch.io + auto-update CI | `b02c6a1` | butler; GitHub Action auto-publishes on push to `main` |
| ViewCube | `86ab434` | CSS-3D gizmo: tap-face / drag / Home, mobile-first |
| Plasticity + extended-press | `bc0f7cd` | **3×3 SVD return mapping** (squish-flat that STAYS) + press/spread force |
| Audio | `e952c35` | Procedural per-type pop/crackle/squelch (Web Audio, zero assets), mute, mobile-unlock |
| Press-flatten v2 | `f480806` → `e5fc61d` → `8d2d841` | **Even downward platen** that flattens the blob as one coherent slab instead of tearing it into pieces. Iterated to its final form: `e5fc61d` killed fragmentation (low **PRESS_VMAX** speed cap so press particles can't outrun grid-kernel support; ray∩floor centering was ~tens of units off for the shallow camera). `8d2d841` made the squish **EVEN at any camera angle**: the CPU passes the **contact point** under the cursor and the press is a flat **horizontal disc** centered there (vs the old tilted perpendicular cylinder = lopsided). **Pointer uniform grew 48→64 B** (`contact` vec3 @48; camera.poke → input → setPointerForce → shader); 128 B struct untouched. Tuned for cohesion: PRESS_PLATEAU 0.3 (wide taper), PRESS_VMAX 0.9. Quick-tap dent unchanged. Harness: **representative wide-slab seed** (Y-outer) + **angled ray** + **connected-components cohesion gate** (≥90%) + per-axis evenness readout |

## 3. Architecture / file map

- **Sim (WebGPU compute), `mls-mpm/`:** 6 validated shaders `clearGrid`, `p2g_1`,
  `p2g_2` (elastic stress), `updateGrid` (gravity), `g2p` (F update + **SVD plasticity
  return mapping**), `copyPosition`; plus `pointerForce.wgsl` (poke DENT = round dimple on
  perpendicular distance to the ray; **PRESS-FLATTEN** = flat -Y horizontal disc centered on
  the CPU-supplied `contact` point under the cursor → EVEN squish at any camera angle, radius
  poke r × `PRESS_RADIUS_SCALE` 2.0 ≈ ½ blob, low `PRESS_VMAX` 0.9 speed cap = anti-fragmentation;
  tunable consts atop the file). **Pointer uniform is 64 B** (adds `contact` vec3 @48).
  `mls-mpm.ts` orchestrates pipelines/bind-groups + owns the **Material uniform**.
  - **Particle struct = 128 B** `{position@0, v@16, C@32 (mat3x3), F@80 (mat3x3)}`. **Do
    not change** without re-validating everything.
  - **Material uniform = 32 B std430**, bound at **binding 3** of `p2g_2` + `updateGrid`
    and **binding 4** of `g2p`: `{mu@0, lambda@4, viscosity@8, gravity@12, plasticity@16,
    _pad@20/24/28}`. Written by `setMaterial(mu,lambda,viscosity,gravity,plasticity)`.
  - **Integrator: dt=0.10, 4 substeps/frame** (`execute()` loop `i<4`). This is the
    stability floor — see §Invariants.
- **Render (WebGPU), `render/`:** screen-space fluid — `depthMap` → `bilateral` →
  `thickness`/`gaussian` → `fluid` composite (Fresnel + refraction + **SlimeStyle**
  uniform: color/gloss/opacity/foam, binding 5). `sphere.wgsl` = debug point-sprites.
  `fluidRender.ts` drives it.
- **Camera, `camera.ts`:** orbit (yaw=currentXtheta, pitch=currentYtheta, pitch clamp
  `[-0.99π/2, 0]`), `orbit()/zoom()`, `unproject()/poke()` (M2), `animateTo()/update()`
  (ViewCube tween). No internal listeners — `InputController` drives it.
- **Input, `input.ts`:** `InputController` owns all canvas Pointer Events. 1-finger=poke,
  2-finger=orbit+pinch, mouse buttons. Press-duration ramp feeds pointerForce. Audio hooks.
- **UI:** `index.html` (panels: brand/stats/controls/status/**Slime Lab**/**ViewCube**),
  `controls.ts` (Slime Lab logic + presets + sliders + mute), `viewcube.ts` (CSS-3D gizmo),
  `audio.ts` (Web Audio engine + 6 per-type profiles), `main.ts` (wires it all + frame loop).

## 4. ⚙️ Validation harness (CRITICAL — this is how we ship blind)

There is **no GPU/browser in the dev environment**, and **vite does not compile WGSL**
(it inlines shaders as strings). So shader/sim correctness is validated with **Deno's
headless WebGPU** (wgpu + the same `naga` validator) on the box's real NVIDIA GPU.

- **Harnesses (preserved in `tools/validate/`):** `slimelab_harness.js` (compiles all 14
  shaders, runs the sim with the 32 B material uniform, sweeps material×plasticity corners
  for stability, persistence test) and `press_harness.js` (press-flatten test).
- **`shot_harness.js` = headless GAMEPLAY SCREENSHOT + GIF generator.** Runs the sim + the
  FULL fluid render pipeline (mirrors `fluidRender.ts`, procedural env cubemap + a **wood/
  granite tabletop** patched into a copy of `fluid.wgsl`) to an offscreen texture, reads
  pixels back, writes a **PNG** (DEFLATE via `CompressionStream`) or an animated **GIF**
  (self-contained median-cut + LZW encoder — NO remote deps). No browser/canvas. Env knobs:
  `SHOT_COLOR/OPACITY/GLOSS/FOAM`, `SHOT_YAW/PITCH/DIST`, `SHOT_W/H`, `SHOT_PRESS=1`,
  `SHOT_MODE=sphere`, `SHOT_BG=marble|wood|granite|flat` (+`SHOT_BGCOLOR`), `SHOT_GIF=1`
  (+`GIF_FRAMES/EVERY/DELAY/TY/TZ`, the drop-jiggle). The GIF encoder does **frame
  differencing** (static bg encoded once; later frames = changed-bbox sub-rect + transparent
  + disposal=1) so a textured-bg GIF stays small (marble 600×450×40 ≈ 1.6 MB < 3 MB).
  `--allow-write`. Verify GIFs with PIL (`im.seek` each frame). Output in
  `media/` (cover/screenshots + `jiggle.gif`). The itch page gallery is dashboard-only —
  butler can't set it; the user uploads `media/*`. NOTE: itch CI auto-deploy needs a fresh
  `BUTLER_API_KEY` secret (old one 401/403s); live build pushed via LOCAL butler meanwhile.
- **Setup (one-time):** `cd <a temp dir>; npm init -y; npm install deno` →
  `./node_modules/.bin/deno run --unstable-webgpu --allow-read <harness>.js`. The harnesses
  read shaders by **absolute path** (`d:/SunnydayTech/Studio/Slim3D/mls-mpm`), so copy them
  next to a Deno install and run. (Original env: `d:/tmp/slim3d-validate/`.)
- **This caught real bugs the multi-agent reviews missed:** `active` is a WGSL reserved
  word; `MAX_INJECT_V=6` blew up F; the slider range was unstable at dt=0.20 (→ dt=0.10/4
  substeps). **Always re-run after any sim/shader change.** Web Audio + DOM/CSS features
  (audio, ViewCube, mix-in UI) are NOT headless-validatable → tsc/build + user device test.

## 5. 🔒 Invariants — don't break these

- **Stability:** dt=0.10 × 4 substeps. Material sliders clamp to `mu[1,6] λ[2,12]
  visc[0.1,1.5] gravity[-0.6,0] plasticity[0,1]` — validated stable across all corners
  (max|F|≈1–2). `fixed_point_multiplier=1e6` (P2G atomic headroom ±2147). Injected poke
  `|v|` clamped to `MAX_INJECT_V=1.5` + a `VMAX=4` post-injection speed cap.
- **Secure context:** WebGPU needs HTTPS or localhost. For mobile testing use a
  `cloudflared tunnel --url http://localhost:5173` (LAN IP over http will NOT expose WebGPU).
- **itch:** `base:'./'` (relative paths) in `vite.config.ts` is REQUIRED for the itch iframe.

## 6. 🛠️ Workflow pattern (how each feature was built)

Each milestone = a Workflow: **design (parallel) → reconcile (full code) → adversarial
verify (lenses incl. a domain-specific one) → finalize**. The agents write files to disk
+ self-report; **then I independently re-run the harness/tsc/build** before committing.
Scripts preserved in `docs/workflows/*.workflow.js` (re-runnable via the Workflow tool's
`{scriptPath}`). **`docs/workflows/mixins.workflow.js` is the unfinished mix-ins workflow —
re-run it to resume.**

## 7. 🚀 Deploy / publish

- **Pages (manual):** `npx vite build` → `CLOUDFLARE_ACCOUNT_ID=1d7e48a07988789267df44db8936c5d3
  npx wrangler pages deploy dist --project-name=slim3d --branch=main --commit-dirty=true`.
  (wrangler is OAuth-authed locally as nick@sunn3d.com.)
- **itch (auto):** every push to `main` triggers `.github/workflows/deploy-itch.yml`
  (repo secret `BUTLER_API_KEY` + variable `ITCH_USER=sunnydaytech` are set). butler also
  installed locally at `C:\Users\ngson\butler\butler.exe`. See [docs/ITCH_SETUP.md](docs/ITCH_SETUP.md).
- **Dev:** `npm install && npm run dev` (host+allowedHosts on for tunnels).

## 8. Remaining roadmap

1. **Mix-ins (NEXT)** — sprinkles/beads/glitter as a **separate inclusion buffer** (tag a
   small fraction of particles) + a new **billboard render pass** depth-integrated with the
   fluid + UI toggles. **128 B struct + 6 sim shaders stay untouched.** Workflow ready:
   `docs/workflows/mixins.workflow.js`. Highest blind-risk (new render pass) → expect a
   visual-iteration round with the user.
   *(NB: "broaden the press so it doesn't separate the slime" — sometimes called M4 in chat —
   is DONE; see Done table → Press-flatten v2 `f480806`. The "M4" below is the WebGL2 fallback.)*
2. **M4 — WebGL2 fallback** — LARGE. Per the kernel eval, WebGPU compute/atomics can't port
   to WebGL2 → this is a *reduced-fidelity* path (lighter 2D/metaball slime), not parity.
   **Scope it as a decision point with the user, don't auto-build blind.** Priority depends
   on the itch WebGPU-iframe test (§9).
3. **Cloudflare Pages auto-deploy** — small GitHub Action; **needs a Cloudflare API token**
   as a repo secret (`CLOUDFLARE_API_TOKEN`) — user-provided, like the itch key was. Or
   connect the repo in the CF Pages dashboard (Git integration).

## 9. ⏳ Open USER actions (not blocked on code)

- **itch dashboard finalize:** mark the `html5` build "This file will be played in the
  browser", set embed viewport (1280×720) + fullscreen, set page Public.
- **itch WebGPU-iframe test:** load the itch page — does the blob render? (Decides M4 priority.)
- **Device verification (accumulated):** ViewCube feel, squish-flat / **broad-platen press
  feel** (is the ~½-blob footprint + strength right? consts `PRESS_RADIUS_SCALE`/`PRESS_DOWN`/
  `PRESS_SPREAD` in `pointerForce.wgsl` are one tweak away), per-type **audio**, and **FPS**
  after the 2× substep change — all shipped but only tsc/build-validated, not seen/heard by a
  human yet. A device pass would de-risk the recent stack before piling on more.

## 10. Quick start for next session

1. `cd d:/SunnydayTech/Studio/Slim3D`, confirm `git log -1` = `e952c35`, `npm install`.
2. Set up Deno harness (§4) if continuing sim work.
3. Resume mix-ins: `Workflow({scriptPath: "docs/workflows/mixins.workflow.js"})` (or re-author
   from §8.1), then validate → commit → deploy as in §7.
