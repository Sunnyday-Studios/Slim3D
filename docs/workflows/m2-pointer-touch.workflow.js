export const meta = {
  name: 'slim3d-m2-pointer-touch',
  description: 'Design, reconcile, adversarially verify (incl. a dedicated mobile-touch lens), and finalize the Slim3D M2 interaction layer: unified Pointer-Events input (1-finger poke vs 2-finger orbit/pinch on touch; left-drag poke vs right-drag orbit on mouse), NDC->world-ray unprojection, and a new pointerForce compute pass that injects force into the slime without disturbing the validated M1 shaders. Emits ready-to-write file contents.',
  phases: [
    { title: 'Design', detail: '3 agents design the math+sim pass, the cross-device input state machine, and gather real-world references' },
    { title: 'Reconcile', detail: 'merge into one canonical set of full file contents' },
    { title: 'Verify', detail: '4 adversarial lenses incl. a mobile-touch lens' },
    { title: 'Finalize', detail: 'apply fixes, emit final files + headless-harness additions' },
  ],
}

const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D M2 — add interactive pointer/touch poke to a WebGPU MLS-MPM slime blob. READ THE REAL FILES at ${REPO} before proposing: index.html, main.ts, camera.ts, common.ts, mls-mpm/mls-mpm.ts, mls-mpm/g2p.wgsl, render/fluidRender.ts. Confirm every convention against the actual source.

CURRENT STATE (M1, validated + deployed):
- MLS-MPM sim in mls-mpm/mls-mpm.ts: particle struct 128 bytes {position vec3f@0, v vec3f@16, C mat3x3f@32, F mat3x3f@80}. execute() runs 2 substeps of (clearGrid, p2g_1, p2g_2, updateGrid, g2p, copyPosition). These 6 shaders are VALIDATED (headless: compile + 300 steps stable) and MUST NOT be modified.
- g2p.wgsl is where particle velocity v is (re)computed from the grid each substep, then position += v*dt, then a wall penalty. dt=0.20. fixed_point_multiplier=1e6 (P2G atomics: i32 -> ±2147 magnitude headroom per channel before silent overflow — so any velocity we inject must stay well-bounded, because next substep's p2g scatters v through those atomics).
- camera.ts: an orbit camera that CURRENTLY binds its own mousedown/mousemove/mouseup/wheel listeners in its constructor (NO touch support at all). It writes view/projection/inv_projection/inv_view into renderUniformsViews via reset()/recalculateView() using wgpu-matrix (column-major mat4). reset() builds projection from fov/aspect; recalculateView() builds an orbit transform from currentXtheta/currentYtheta/currentDistance about target.
- common.ts renderUniformsValues is a 272-byte ArrayBuffer; renderUniformsViews = { texel_size: f32x2 @0, sphere_size: f32x2 @8, inv_projection_matrix: f32x16 @16, projection_matrix: f32x16 @80, view_matrix: f32x16 @144, inv_view_matrix: f32x16 @208 }. All mat4 are COLUMN-MAJOR Float32Array(16).
- main.ts: creates device/context, particleBuffer/posvelBuffer/renderUniformBuffer, MLSMPMSimulator, FluidRenderer, Camera. Frame loop writes renderUniformBuffer then sim.execute() then renderer.execute(). RENDER_SCALE=0.7: canvas.width = floor(0.7*clientWidth) (backing store), but CSS size = clientWidth (full). index.html canvas has style touch-action:none already.

MANDATED M2 ARCHITECTURE (converge on this; refine only with explicit justification):
1. NEW unified input controller input.ts (class InputController) using POINTER EVENTS (pointerdown/move/up/cancel) — the single cross-device path for mouse + touch + pen. It OWNS all canvas pointer handling.
   GESTURES:
   - Touch: 1 active finger = POKE the slime; 2 active fingers = ORBIT (average of the two fingers' movement) + PINCH-ZOOM (change in inter-finger distance). Going 1->2 or 2->1 fingers must re-baseline without a jump.
   - Mouse: LEFT-button drag = POKE; RIGHT-button (or middle) drag = ORBIT; wheel = ZOOM. Suppress the context menu on right-drag (contextmenu preventDefault).
   - Pen: treat as touch 1-finger poke.
   - Use setPointerCapture on down; handle pointercancel/pointerleave/lostpointercapture to end gestures cleanly. touch-action:none is set; still preventDefault where you consume the gesture. Track active pointers in a Map<pointerId,{x,y}>.
   - Coordinate mapping: use canvas.getBoundingClientRect(); NDC x=(px-rect.left)/rect.width*2-1, y=-( (py-rect.top)/rect.height*2-1 ). NDC is resolution-independent so RENDER_SCALE/backing-store size does NOT enter the NDC math (confirm this reasoning).
2. REFACTOR camera.ts: REMOVE the internal mouse/wheel listeners from the constructor. Expose imperative methods the InputController calls: orbit(dxPixels, dyPixels), zoom(stepsOrDelta), reset(...), plus keep writing renderUniforms. Keep the existing orbit math/limits. The constructor should no longer need the canvas for listeners (still fine to keep signature; just don't bind).
3. UNPROJECTION: a function ndcToWorldRay(ndcX, ndcY) reading renderUniformsViews.inv_projection_matrix + inv_view_matrix. Do MANUAL column-major mat4*vec4 (don't rely on ambiguous lib helpers): unproject (ndcX,ndcY,-1,1)->near and (ndcX,ndcY,1,1)->far in clip space, divide by w after inv_projection (view space), transform both by inv_view (world), ray origin = camera world pos = inv_view * (0,0,0,1) translation, dir = normalize(farWorld - nearWorld). Provide the explicit math.
4. FORCE MODEL (the poke feel): while poking, each frame compute a world-space force to inject. Distance-to-RAY model (no depth readback): a particle at P with ray (O, D normalized) has perpendicular distance d = length((P-O) - dot(P-O,D)*D); if d < radius apply force with smooth falloff. Force vector = drag component (world-space delta of the interaction point between frames, i.e. map the screen drag to world at the blob's depth via two rays at the camera-to-target distance) scaled by a drag strength, PLUS a small inward push along D while pressed so a stationary tap still dents. BOUND the force so injected v stays within the atomic headroom (clamp magnitude).
5. NEW WGSL pass mls-mpm/pointerForce.wgsl (DO NOT touch the 6 validated shaders): @compute @workgroup_size(64); bindings: @binding(0) particles: array<Particle> (read_write, SAME 128B struct {position,v,C,F}), @binding(1) pointer uniform. For id<arrayLength: if active>0.5 and distToRay<radius: particles[id].v += force * falloff(d). Nothing else.
6. mls-mpm.ts: add pointerForcePipeline + a pointerUniformBuffer + bind group + a method setPointerForce(rayOrigin:number[3], rayDir:number[3], force:number[3], radius:number, active:boolean) that writes the uniform, and dispatch the pointerForce pass ONCE PER FRAME after the 2-substep loop inside execute() (or a new applyPointerForce(encoder) called right after execute()). Particle struct/layout UNCHANGED. Pointer uniform std140 layout suggestion (48B): { ray_origin vec3f@0, radius f32@12, ray_dir vec3f@16, strength f32@28, force vec3f@32, active f32@44 }.
7. main.ts: construct InputController(canvas, camera, simulator); each frame call input.update() (computes + pushes setPointerForce) BEFORE sim.execute(); keep writing renderUniformBuffer. Remove reliance on camera's old internal listeners.
8. index.html: update the #hint text to: '1 finger poke · 2 fingers orbit/zoom' (and a desktop line: 'Left-drag poke · Right-drag orbit · Scroll zoom'). Optional small on-screen mode hint.

DELIVERABLE: COMPLETE final contents (not diffs) for every new/changed file: input.ts (new), mls-mpm/pointerForce.wgsl (new), camera.ts (changed), mls-mpm/mls-mpm.ts (changed), main.ts (changed), index.html (changed). Keep the 6 validated M1 shaders byte-untouched.

CONSTRAINTS / TRAPS to respect: mobile WebGPU is secure-context only (already handled). Don't break M1. Bound poke force vs the 1e6 atomic headroom. Don't let 1-finger poke also orbit. Re-baseline on finger-count change. iOS Safari 26 pointer-events quirks. Don't apply force when the ray misses the blob entirely (it just won't be near any particle — fine). The sim has no per-particle picking of 'the surface under the finger' (we use distance-to-ray), so the nearest particles ALONG the whole ray get poked — acceptable for v1; note it.
`

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    repo_findings: { type: 'string', description: 'exact conventions confirmed by reading the real files (matrix layout, struct, execute flow, canvas sizing)' },
    design: { type: 'string', description: 'the concrete design decisions for this area' },
    code: { type: 'string', description: 'WORKING code (TS and/or WGSL) for this area, ready to drop in — not pseudocode' },
    pitfalls: { type: 'string', description: 'mobile/touch/math/sim pitfalls and how this design avoids them' },
    citations: { type: 'array', items: { type: 'string' } },
  },
  required: ['area','repo_findings','design','code','pitfalls'],
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    bugs: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        severity: { type: 'string', enum: ['blocker','major','minor'] },
        location: { type: 'string' },
        problem: { type: 'string' },
        fix: { type: 'string' },
      }, required: ['severity','problem','fix'],
    }},
    verdict: { type: 'string', enum: ['ship','fix-then-ship','reject'] },
    notes: { type: 'string' },
  },
  required: ['lens','bugs','verdict'],
}
const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    files: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, contents: { type: 'string' } },
      required: ['path','contents'],
    }},
    apply_notes: { type: 'string' },
    residual_risks: { type: 'string' },
    tuning_knobs: { type: 'string', description: 'poke radius / drag strength / inward push / camera sensitivity — names + which way to turn' },
    harness_additions: { type: 'string', description: 'how to extend d:/tmp/slim3d-validate/sim_harness.js to headless-test the pointerForce pass: compile it, dispatch with a synthetic active poke ray through the blob, assert (a) stays finite/bounded and (b) some particles actually changed velocity/position vs a no-poke run' },
  },
  required: ['files','apply_notes','residual_risks','tuning_knobs','harness_additions'],
}

phase('Design')
const areas = [
  { key: 'math-and-sim-pass', desc: 'Unprojection (NDC->world ray, manual column-major mat4*vec4 against the renderUniforms layout), the distance-to-ray force model with falloff + world-space drag mapping, the new pointerForce.wgsl compute pass, and the mls-mpm.ts wiring (pipeline, 48B uniform buffer, bind group, setPointerForce, dispatch after the substep loop). Force-magnitude bounding vs the 1e6 atomic headroom.' },
  { key: 'input-state-machine', desc: 'The InputController (input.ts) Pointer-Events state machine: 1-finger poke vs 2-finger orbit/pinch (touch), left/right-button modes (mouse), pen; pointer capture + pointercancel/leave; re-baselining on finger-count change; getBoundingClientRect NDC mapping (resolution-independent of RENDER_SCALE); touch-action/preventDefault; and the camera.ts refactor to imperative orbit(dx,dy)/zoom() with the internal listeners removed.' },
  { key: 'references', desc: 'Real-world proven patterns: how PavelDoGreat WebGL-Fluid-Simulation and three.js OrbitControls / map libraries handle multi-touch (1 vs 2 finger) + pinch + Pointer Events + touch-action; WebGPU/iOS Safari pointer quirks; canvas NDC picking. Fetch and CITE. Ground the other two designs in these.' },
]
const designs = (await parallel(areas.map(a => () =>
  agent(
    `${CONTEXT}\n\nYOU ARE DESIGN AGENT '${a.key}'. Focus: ${a.desc}\n\nUse WebSearch/WebFetch (load via ToolSearch "select:WebSearch,WebFetch") for the references area and to confirm Pointer-Events / touch-action / iOS specifics; CITE URLs. READ the real repo files. Produce WORKING code for your area (fill the schema). Be exact about coordinate math, gesture transitions, and not breaking the M1 shaders.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

log(`Designs complete: ${designs.length}/3. Reconciling.`)

phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nYou are the RECONCILER. Here are ${designs.length} area designs (JSON):\n\n${JSON.stringify(designs, null, 2)}\n\nREAD the real repo files at ${REPO}. Produce ONE coherent implementation. Resolve any conflicts explicitly (gesture mapping, force scale, dispatch placement, uniform layout). Output, as fenced blocks each headed by '=== FILE: <repo-relative-path> ===', the COMPLETE contents of: input.ts, mls-mpm/pointerForce.wgsl, camera.ts, mls-mpm/mls-mpm.ts, main.ts, index.html. The 6 validated M1 shaders must NOT appear (untouched). Ensure: pointerForce bindings match the bind group in mls-mpm.ts; setPointerForce writes the exact uniform layout the shader reads; struct stays 128B; camera's removed listeners don't leave dangling references in main.ts; the frame loop pushes the pointer force before execute(). Add a brief decisions list.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' }
)

phase('Verify')
const lenses = [
  { key: 'mobile-touch', focus: "MOBILE TOUCH CORRECTNESS (the priority). Verify: 1 finger genuinely pokes and does NOT orbit; 2 fingers orbit + pinch-zoom with correct math; 1<->2 finger transitions re-baseline with no jump; pointercancel/pointerleave/lostpointercapture end gestures so a stuck poke can't persist; touch-action:none + preventDefault actually stop page scroll/zoom on iOS Safari & Android Chrome; getBoundingClientRect mapping is correct and independent of RENDER_SCALE; setPointerCapture used correctly; no reliance on mouse-only events; pen handled. Find concrete breakages a real phone would hit." },
  { key: 'unprojection-math', focus: "MATH CORRECTNESS. Verify the NDC computation (y flip), the manual column-major mat4*vec4 (indexing m[col*4+row]), the w-divide after inv_projection, the inv_view transform, ray origin = camera world position, dir normalization, and the world-space drag mapping. Verify the distance-to-ray formula and falloff. A sign/transpose/column-major error here makes the poke land in the wrong place or direction — check rigorously." },
  { key: 'sim-integration', focus: "SIM INTEGRATION SAFETY. Verify the 6 M1 shaders are byte-untouched; pointerForce.wgsl uses the identical 128B Particle struct; the new pipeline/bindgroup/uniform-buffer in mls-mpm.ts are wired correctly (bindings, sizes, std140 offsets of the 48B uniform); dispatch count = ceil(numParticles/64); the pass runs at the right point (after substeps); injected force is magnitude-bounded so next p2g doesn't overflow the 1e6 i32 atomics (±2147) -> blowup; setPointerForce writes correct byte offsets." },
  { key: 'lang-and-ux', focus: "TS/WGSL LANGUAGE + UX. tsc-clean TS (types, no missing fields, camera refactor leaves no broken refs in main.ts); valid WGSL (override/binding usage, mat/vec ops); index.html ids referenced by input.ts exist; gesture UX sane (does a 1-finger drag on EMPTY space do nothing weird? right-drag context menu suppressed? does poke strength feel plausible vs the documented bounds?); no memory leak from un-removed listeners on reset." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(
    `${CONTEXT}\n\nYou are an ADVERSARIAL REVIEWER. Lens: ${l.focus}\n\nReconciled implementation to attack:\n\n${reconciled}\n\nAlso READ the real repo files at ${REPO}. Find CONCRETE bugs through your lens (file+expression, exact fix). Default to skepticism; do not rubber-stamp. If correct through your lens, verdict 'ship' with empty bugs.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

const blockers = verdicts.flatMap(v => (v.bugs||[]).filter(b => b.severity === 'blocker' || b.severity === 'major'))
log(`Verify complete. ${verdicts.length} lenses, ${blockers.length} blocker/major findings. Finalizing.`)

phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nYou are the FINALISER. Reconciled implementation:\n\n${reconciled}\n\nAdversarial verdicts (JSON) — incorporate every blocker/major and any clearly-correct minor:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce FINAL complete contents for every new/changed file (input.ts, mls-mpm/pointerForce.wgsl, camera.ts, mls-mpm/mls-mpm.ts, main.ts, index.html), ready to write verbatim. Re-verify: M1 shaders untouched; bindings/uniform offsets consistent; tsc-clean; gestures correct; force bounded. Fill the schema, including harness_additions describing exactly how to extend the Deno harness to headless-test pointerForce.`,
  { label: 'finalize', phase: 'Finalize', schema: FINAL_SCHEMA, effort: 'high' }
)
return final