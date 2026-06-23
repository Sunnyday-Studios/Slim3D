export const meta = {
  name: 'slim3d-viewcube',
  description: 'Design, reconcile, adversarially verify (angle-math + mobile-touch lenses), and finalize a CSS-3D ViewCube/orientation gizmo ("rosette") for Slim3D: mirrors the live camera, tap a face to snap to that view, drag the cube to orbit, Home button to reset. Pure DOM/CSS overlay, decoupled from the WebGPU render. Emits ready-to-write file contents.',
  phases: [
    { title: 'Design', detail: '2 agents: camera-angle mapping + ViewCube UX/CSS-3D' },
    { title: 'Reconcile', detail: 'one coherent implementation as full files' },
    { title: 'Verify', detail: 'angle-math + mobile-touch/integration lenses' },
    { title: 'Finalize', detail: 'final files + verify steps' },
  ],
}
const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D VIEWCUBE ("rosette") — add a 3D orientation gizmo for mobile, because two-finger orbit is unreliable on touch. Like a CAD ViewCube: a small 3D cube in a corner showing TOP/FRONT/LEFT/etc, that MIRRORS the live camera; TAP a face to snap the camera to that view; DRAG the cube to orbit; a "Home" button resets. Implement it as a CSS-3D cube (pure DOM/CSS overlay) — do NOT touch the WebGPU render pipeline or the sim. READ the real files at ${REPO} first: camera.ts, input.ts, main.ts, index.html.

CAMERA API (camera.ts — confirm by reading):
- Orbit state: currentXtheta = YAW (used as mat4.rotateY(mat, currentXtheta)); currentYtheta = PITCH (mat4.rotateX(mat, currentYtheta)), CLAMPED to [minYTheta = -0.99*PI/2, maxYTheta = 0] (so pitch is between looking straight down and level — you CANNOT look from below). sensitivity = 0.005, currentDistance, target.
- reset() defaults: currentXtheta = PI/4, currentYtheta = -PI/12. This is the "Home" view.
- recalculateView(): mat = identity; translate(target); rotateY(currentXtheta); rotateX(currentYtheta); translate(0,0,currentDistance); position = mat*(0,0,0,1); view = lookAt(position, target, [0,1,0]); writes view + inv_view into renderUniforms. So increasing currentXtheta orbits around +Y; currentYtheta tilts.
- orbit(dxPixels, dyPixels): currentXtheta -= sensitivity*dxPixels; currentYtheta -= sensitivity*dyPixels; clamp pitch; recalculateView(). zoom/zoomBy exist. getTarget()/getDistance() exist. unproject()/poke() exist (M2 — do not disturb).
- main.ts frame loop: function frame(){ input.update(); ...writeBuffer...; sim.execute(); sim.applyPointerForce(); renderer.execute(...); requestAnimationFrame(frame) }. input = InputController(canvas, camera, sim) owns ALL canvas pointer events (1-finger poke / 2-finger orbit+pinch). The ViewCube must own its OWN pointer events on its OWN DOM element so tapping/dragging it does NOT poke the slime.
- index.html existing fixed panels (AVOID OVERLAP): #brand top-left (display:none on mobile <=600px), #stats top-right, #controls bottom-left, #status bottom-right (small), #slimeLab top-center (full-width on mobile). Free-ish: bottom-right area (above #status) and, on mobile, top-left (brand hidden). Pick a non-overlapping, thumb-reachable spot.

MANDATED IMPLEMENTATION:
1. camera.ts ADD (do not change existing orbit/poke/reset math):
   - getAngles(): { yaw: currentXtheta, pitch: currentYtheta }.
   - animateTo(yaw, pitch): start an eased tween of currentXtheta/currentYtheta toward (yaw, clamp(pitch)) over ~300ms; record target + start values + start time-less progress (NOTE: Date.now()/performance.now() ARE allowed in app code — only Workflow scripts forbid them; use performance.now()).
   - update(): called once per frame; if a tween is active, advance it (ease in-out), set currentXtheta/Ytheta, clamp pitch, recalculateView(); if user orbit() is called mid-tween it cancels the tween (set a flag in orbit()).
2. viewcube.ts NEW (class ViewCube):
   - Builds/öwns the cube interaction. Reads camera.getAngles() each frame (via an update() the main loop calls, or its own rAF) and sets the cube container's CSS transform to MIRROR the camera so the face pointing at the screen matches the current view. DERIVE the exact transform: the cube is the world basis as seen by the camera, so container transform ~ rotateX(pitch-ish) rotateY(-yaw-ish) — work out the correct order + SIGNS so that e.g. orbiting right spins the cube left (toward showing the right face). State your derivation.
   - Face TAP -> camera.animateTo(targetYaw, targetPitch). Map faces to views respecting the pitch clamp: FRONT (level, pitch 0), BACK (yaw+PI, pitch 0), LEFT (yaw-PI/2), RIGHT (yaw+PI/2), TOP (pitch = minYTheta, looking down). BOTTOM is UNREACHABLE (pitch clamp >=... <=0) -> either omit the bottom face's tap, or clamp to level — pick and document. Choose absolute yaws relative to a sensible FRONT.
   - Cube DRAG (pointerdown+move on the cube) -> camera.orbit(dx, dy) using pointer deltas (a reliable orbit control). Use Pointer Events + setPointerCapture; the cube element has touch-action:none; preventDefault so the page doesn't scroll. Distinguish a tap (no/low movement) from a drag (moved > a few px) to decide snap-to-face vs orbit.
   - "Home" button -> camera.reset(...) OR animateTo(PI/4, -PI/12) (the default look). Match the screenshot: a labelled "Home view" button under the cube.
3. index.html: cube markup (a perspective container + preserve-3d cube + 6 labelled faces TOP/BOTTOM/FRONT/BACK/LEFT/RIGHT) + "Home view" button + CSS. Style like a CAD viewcube (blue faces, lighter edges/labels, subtle highlight on the front-facing face if cheap). Mobile-first: touch targets, ~84-96px cube, positioned to avoid the panels above, hidden or repositioned sensibly at <=600px. z-index above the canvas, below modal panels.
4. main.ts: construct the ViewCube(camera) after the camera; call camera.update() AND viewcube.update() each frame in frame() (before or after input.update() — pick correctly so a tween + a live orbit don't conflict). Wire the Home button.

CONSTRAINTS: Pure DOM/CSS — no WebGPU/sim changes. Don't disturb input.ts/poke (the cube must not poke the slime). tsc-clean. Mobile-first. Keep the existing orbit/poke working. performance.now() is fine in app code.

DELIVERABLE: COMPLETE contents for: viewcube.ts (new), camera.ts (with the additions), index.html, main.ts. Do NOT change input.ts, the shaders, fluidRender.ts, controls.ts, mls-mpm.ts.
`

const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    repo_findings: { type: 'string' },
    design: { type: 'string' },
    code: { type: 'string', description: 'working TS/HTML/CSS for this area' },
    pitfalls: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
  },
  required: ['area','repo_findings','design','code','pitfalls'],
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    bugs: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { severity: { type: 'string', enum: ['blocker','major','minor'] }, location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
      required: ['severity','problem','fix'] } },
    verdict: { type: 'string', enum: ['ship','fix-then-ship','reject'] },
    notes: { type: 'string' },
  },
  required: ['lens','bugs','verdict'],
}
const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    files: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path','contents'] } },
    apply_notes: { type: 'string' },
    angle_mapping: { type: 'string', description: 'the derived cube<->camera transform + face->view table, for the human to sanity-check' },
    residual_risks: { type: 'string' },
    verify_steps: { type: 'string', description: 'what the user should check on a phone' },
  },
  required: ['files','apply_notes','angle_mapping','verify_steps'],
}

phase('Design')
const areas = [
  { key: 'camera-mapping', desc: 'The math: (a) the CSS-3D container transform that mirrors the camera each frame (correct rotateX/rotateY order + SIGNS vs the camera rotateY(yaw)*rotateX(pitch) convention); (b) the per-face target (yaw,pitch) snap views respecting the pitch clamp [-0.99*PI/2, 0]; (c) the camera.ts animateTo/update/getAngles tween (eased, cancel-on-user-input, performance.now()). Provide working code + an explicit derivation.' },
  { key: 'ux-css-touch', desc: 'The ViewCube UX + CSS-3D cube structure (perspective, preserve-3d, 6 labelled faces, Home button, CAD-like styling) + mobile placement avoiding the existing panels + the Pointer-Events handling on the cube (tap-vs-drag discrimination, setPointerCapture, touch-action:none, NOT poking the canvas). Research real web ViewCube/GizmoHelper implementations (three.js ViewHelper/GizmoHelper, CSS 3D cube tutorials, CAD ViewCube UX) and CITE.' },
]
const designs = (await parallel(areas.map(a => () =>
  agent(`${CONTEXT}\n\nYOU ARE DESIGN AGENT '${a.key}'. Focus: ${a.desc}\n\nREAD the real repo files. For the ux-css-touch agent, use WebSearch/WebFetch (load via ToolSearch "select:WebSearch,WebFetch") and CITE. Produce WORKING code (fill schema), exact about signs/order and touch handling.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Designs: ${designs.length}/2. Reconciling.`)
phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nYou are the RECONCILER. Designs (JSON):\n\n${JSON.stringify(designs, null, 2)}\n\nREAD the real repo files. Produce ONE coherent implementation as fenced blocks headed '=== FILE: <repo-relative-path> ===' for: viewcube.ts, camera.ts, index.html, main.ts. Resolve the cube<->camera transform sign/order definitively and STATE it. Ensure tap-vs-drag works, the tween cancels on user orbit, the cube doesn't poke the slime, faces map to correct views (pitch clamp handled), Home resets, mobile placement avoids panels. List decisions.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' })

phase('Verify')
const lenses = [
  { key: 'angle-math', focus: "ANGLE MATH. Verify: the container CSS transform actually MIRRORS the camera (orbiting the scene spins the cube the right way; the screen-facing cube face matches the current view) given camera rotateY(yaw)*rotateX(pitch); each face TAP maps to the correct (yaw,pitch) and produces that view; the pitch clamp [-0.99*PI/2,0] is respected (BOTTOM handled, not NaN/stuck); animateTo eases + clamps + cancels on user orbit; getAngles correct. Sign/order errors are the likely bug — check rigorously." },
  { key: 'touch-integration', focus: "MOBILE-TOUCH + INTEGRATION. Verify: the cube's Pointer Events are on its own element (tapping/dragging it does NOT reach the canvas InputController / does NOT poke the slime); tap-vs-drag discrimination is sane; setPointerCapture + touch-action:none + preventDefault stop page scroll; the cube + Home button are real touch targets and don't overlap #stats/#slimeLab/#status (incl. the <=600px mobile layout); main.ts calls camera.update()+viewcube.update() each frame without fighting input.update(); tsc-clean; CSS 3D is valid (perspective/preserve-3d/backface); DOM ids match between html and viewcube.ts. M2 poke + existing orbit still work." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(`${CONTEXT}\n\nADVERSARIAL REVIEWER. Lens: ${l.focus}\n\nImplementation:\n\n${reconciled}\n\nREAD the real repo files. Find concrete bugs (file+expression, exact fix). Skeptical; no rubber-stamp. If correct, verdict 'ship' empty bugs.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Verify: ${verdicts.flatMap(v=>(v.bugs||[]).filter(b=>b.severity!=='minor')).length} blocker/major. Finalizing.`)
phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nFINALISER. Reconciled:\n\n${reconciled}\n\nVerdicts (JSON), incorporate every blocker/major + clear minors:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce FINAL complete contents for viewcube.ts, camera.ts, index.html, main.ts ready to write verbatim. Re-verify angle math + touch isolation + tsc-clean + mobile placement. Fill the schema incl angle_mapping (the cube<->camera transform + face->view table) and verify_steps (phone checklist).`,
  { label: 'finalize', phase: 'Finalize', effort: 'high' })
return final