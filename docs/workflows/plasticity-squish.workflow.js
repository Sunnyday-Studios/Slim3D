export const meta = {
  name: 'slim3d-plasticity-squish',
  description: 'Design, reconcile, adversarially verify, finalize PLASTICITY (SVD singular-value return mapping so the slime keeps its reshaped form) + EXTENDED-PRESS (a sustained press that spreads/squishes the blob flat) for Slim3D. Sim changes (g2p SVD return mapping, material-uniform plasticity param, per-type values, pointerForce press model, input press mode). Emits ready-to-write files + headless-harness validation steps.',
  phases: [
    { title: 'Design', detail: '3 agents: SVD+return-mapping, press/flatten force, integration+params+UI' },
    { title: 'Reconcile', detail: 'one coherent implementation as full files' },
    { title: 'Verify', detail: '4 lenses: SVD, plasticity-stability, press, integration' },
    { title: 'Finalize', detail: 'final files + harness additions' },
  ],
}
const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D PLASTICITY + EXTENDED-PRESS. Goal: the slime should (1) keep a reshaped/squished form instead of fully snapping back (PLASTICITY), and (2) under a SUSTAINED PRESS spread + squish FLAT (not just a transient dent). READ the real files at ${REPO} first: mls-mpm/mls-mpm.ts, mls-mpm/g2p.wgsl, mls-mpm/p2g_2.wgsl, mls-mpm/updateGrid.wgsl, mls-mpm/pointerForce.wgsl, input.ts, controls.ts, index.html, main.ts, camera.ts.

CURRENT SIM (validated + live):
- MLS-MPM, particle struct 128B {position vec3f@0, v vec3f@16, C mat3x3f@32, F mat3x3f@80}. dt=0.10, 4 substeps/frame (execute() loop i<4). fixed_point_multiplier=1e6, p_vol=1 are pipeline override consts.
- Material is a RUNTIME UNIFORM (16B, binding 3 of p2g_2 AND updateGrid): struct Material { mu@0, lambda@4, viscosity@8, gravity@12 }. mls-mpm.ts writes it via setMaterial(mu,lambda,viscosity,gravity) with clamps mu[1,6] lambda[2,12] visc[0.1,1.5] gravity[-0.6,0]. controls.ts holds 6 TYPE PRESETS + sliders (slMu/slLambda/slFlow/slGravity) that call setMaterial; index.html has the sliders.
- ELASTIC stress (p2g_2.wgsl): fixed-corotated tau = 2*mu*(F-R)*F^T + lambda*J*(J-1)*I + viscosity*(C+C^T), where R = polar_R(F) (iterative polar decomposition, rotation only — NO singular values). This is PURELY ELASTIC: F is updated in g2p as F=(I+dt*C)*F with a det<=1e-6/NaN -> identity guard, but nothing bounds the deformation, so the blob fully recovers (snaps back).
- POKE (M2): g2p re-zeros v each substep then recomputes from grid; once per frame after execute(), pointerForce.wgsl injects a bounded world-space velocity into particles within radius of the pointer ray (v += force*falloff, then a |v|<=4 speed clamp). camera.poke() builds the force = drag*(plane-delta)*0.15 + ray_dir*0.35; MLSMPMSimulator.setPointerForce clamps |force| to MAX_INJECT_V=1.5. input.ts InputController: 1-finger = poke (camera.poke -> sim.setPointerForce each frame while pressed), 2-finger orbit/pinch.
- HEADLESS HARNESS exists at d:/tmp/slim3d-validate/slimelab_harness.js (Deno+wgpu): compiles all shaders, binds the material uniform at binding 3, runs settle+poke, sweeps material corners for stability (every corner currently stable, max|F|~2 at dt0.1/4ss). poke_harness.js similar.

GOAL 1 — PLASTICITY (the canonical MPM elastoplastic / play-doh model):
- Add a 3x3 SVD (U,Σ,V) and a SINGULAR-VALUE RETURN MAPPING. In g2p, after F = (I+dt*C)*F: SVD(F)=U*diag(sig)*V^T; CLAMP each singular value sig_i to [1-theta_c, 1+theta_s]; reconstruct F = U*diag(sig_clamped)*V^T. The clamped-away deformation is the PLASTIC (permanent) part. This BOUNDS F (so it also improves stability). Ground the SVD in a vetted branchless 3x3 SVD (McAdams et al. 2011 "Computing the SVD of 3x3 matrices with minimal branching", as used in taichi mpm99 / many MPM codes) — provide WORKING WGSL, handle reflections (det<0) and degeneracy.
- Drive it from a per-particle/material PLASTICITY parameter in the Material uniform. Map a single 'plasticity' in [0,1]: 0 = fully elastic (theta_c,theta_s large -> no clamping -> snaps back, current behavior), 1 = very plastic (tight yield -> reshapes & holds easily). Pick the theta_c/theta_s(plasticity) mapping. Optional hardening: keep simple (no hardening or mild) for v1.
- EXTEND the Material uniform to 32B (std140): { mu@0, lambda@4, viscosity@8, gravity@12, plasticity@16, pad@20, pad@24, pad@28 }. Update the struct in p2g_2.wgsl AND updateGrid.wgsl AND add it to g2p.wgsl (g2p needs binding to read plasticity — add a uniform binding to g2p's bind group). Update mls-mpm.ts: buffer size 16->32, materialView length, setMaterial(mu,lambda,viscosity,gravity,plasticity), add the uniform to g2pBindGroup (new binding index — pick correctly vs g2p's existing bindings 0..3), and the g2p pipeline must declare the matching override/uniform.
- p2g_2 stress: keep using polar_R (cheap) on the now-plastically-corrected F — OR reuse the SVD's R=U*V^T. Decide; keep p2g_2 stable.

GOAL 2 — EXTENDED-PRESS (squish flat):
- A SUSTAINED press should SPREAD particles outward + push them DOWN so the blob pancakes (not just a centered dent). Extend pointerForce.wgsl: in addition to the inward push along the ray, add a RADIAL-OUTWARD component (perpendicular to the ray, away from the closest-point on the ray) and a DOWNWARD (-Y) component, scaled by a 'press strength' that the CPU ramps up the longer the finger is held (so a quick tap = small dent, a long press = flatten). Keep all injected |v| bounded (the existing |v|<=4 clamp + MAX_INJECT_V) so it stays stable.
- input.ts: track press DURATION while a poke pointer is held; pass a press/spread strength (0..1 ramp over ~0.5-1.0s) into the force. A quick poke stays a dent; a long press flattens. Keep it bounded.
- With plasticity ON, the flattened shape PERSISTS (that's the payoff). Make sure the press + plasticity together stay stable.

GOAL 3 — UI: add a 'Squish / Plasticity' slider (0..1) to the Slime Lab panel (index.html + controls.ts) -> setMaterial plasticity. Give each of the 6 TYPE PRESETS a plasticity value (e.g. Butter/Cloud high ~0.6-0.8 reshapeable; Glossy/Jelly/Clear low ~0.1-0.25 snappy; Floam mid). Keep within the validated-stable approach.

CONSTRAINTS: dt=0.10/4 substeps stays. Keep the elastic math otherwise intact; plasticity is an ADDED return-mapping step. All injected/elastic forces bounded vs the 1e6 atomics. The change MUST be headless-validatable: stability across the material+plasticity range, a dent PERSISTS after release when plasticity>0 (and snaps back when plasticity=0), and a sustained press flattens. Keep M2 poke + ViewCube + Slime Lab working. tsc-clean.

DELIVERABLE: COMPLETE contents for every changed/new file: mls-mpm/g2p.wgsl (SVD + return mapping + read plasticity), mls-mpm/p2g_2.wgsl (Material struct 32B), mls-mpm/updateGrid.wgsl (Material struct 32B), mls-mpm/mls-mpm.ts (32B uniform, setMaterial(+plasticity), g2p bind group + pipeline), mls-mpm/pointerForce.wgsl (press spread/flatten), input.ts (press-duration ramp), controls.ts (plasticity slider + per-type values), index.html (plasticity slider). Do NOT change clearGrid/p2g_1/copyPosition, fluidRender.ts, fluid.wgsl, camera.ts, viewcube.ts.
`

const DESIGN_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  area: { type: 'string' }, repo_findings: { type: 'string' }, design: { type: 'string' },
  code: { type: 'string', description: 'working WGSL/TS for this area' }, pitfalls: { type: 'string' },
  citations: { type: 'array', items: { type: 'string' } },
}, required: ['area','repo_findings','design','code','pitfalls'] }
const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  lens: { type: 'string' },
  bugs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    severity: { type: 'string', enum: ['blocker','major','minor'] }, location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
    required: ['severity','problem','fix'] } },
  verdict: { type: 'string', enum: ['ship','fix-then-ship','reject'] }, notes: { type: 'string' },
}, required: ['lens','bugs','verdict'] }
const FINAL_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string' }, contents: { type: 'string' } }, required: ['path','contents'] } },
  apply_notes: { type: 'string' }, material_layout: { type: 'string', description: 'the 32B Material uniform layout + all bind-group/binding changes' },
  preset_plasticity: { type: 'string', description: 'the plasticity value chosen per type preset + the theta mapping' },
  residual_risks: { type: 'string' },
  harness_additions: { type: 'string', description: 'exact steps to extend slimelab_harness.js: bind the 32B material uniform (now also on g2p), sweep stability incl plasticity, a PERSISTENCE test (strong poke -> release -> dent remains when plasticity>0, snaps back when 0), and a PRESS-FLATTEN test (sustained downward+outward press lowers max-Y / spreads footprint, stays finite).' },
}, required: ['files','apply_notes','material_layout','preset_plasticity','harness_additions'] }

phase('Design')
const areas = [
  { key: 'svd-return-mapping', desc: 'The plasticity sim math: a vetted branchless 3x3 SVD in WGSL (McAdams 2011 / taichi mpm99 style — provide the FULL working WGSL), the singular-value clamp/return-mapping in g2p after the F update, the plasticity->theta_c/theta_s mapping, reflection (det<0) + degeneracy handling, and whether p2g_2 reuses R=U*V^T or keeps polar_R. CITE the SVD source.' },
  { key: 'press-flatten', desc: 'The extended-press force model: extend pointerForce.wgsl with a radial-outward (perpendicular to ray) + downward component scaled by a press-strength, and input.ts press-DURATION ramp (quick tap = dent, long hold = flatten). All bounded (|v|<=4, MAX_INJECT_V). Keep M2 quick-poke behavior intact for short presses.' },
  { key: 'integration-params-ui', desc: 'The 32B Material uniform extension (layout + every bind-group/binding/pipeline change in mls-mpm.ts incl. ADDING the uniform to g2p), setMaterial(+plasticity), per-type plasticity preset values, the Squish/Plasticity slider in index.html + controls.ts, and the headless-harness changes needed. Ensure M2/ViewCube/SlimeLab keep working.' },
]
const designs = (await parallel(areas.map(a => () =>
  agent(`${CONTEXT}\n\nYOU ARE DESIGN AGENT '${a.key}'. Focus: ${a.desc}\n\nREAD the real repo files. For svd-return-mapping use WebSearch/WebFetch (ToolSearch "select:WebSearch,WebFetch") for the SVD reference and CITE. Produce WORKING code (fill schema), exact about the uniform layout, bindings, signs, and bounds.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Designs: ${designs.length}/3. Reconciling.`)
phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nRECONCILER. Designs (JSON):\n\n${JSON.stringify(designs, null, 2)}\n\nREAD the real repo files. Produce ONE coherent implementation as fenced blocks headed '=== FILE: <repo-relative-path> ===' for: mls-mpm/g2p.wgsl, mls-mpm/p2g_2.wgsl, mls-mpm/updateGrid.wgsl, mls-mpm/mls-mpm.ts, mls-mpm/pointerForce.wgsl, input.ts, controls.ts, index.html. Ensure: the 32B Material uniform layout is byte-identical across p2g_2/updateGrid/g2p and the TS writer; g2p gets the uniform at a correct new binding + bind group + pipeline; SVD/return-mapping correct + bounded; press model bounded; plasticity=0 reproduces current elastic behavior; tsc-clean; M2/ViewCube/SlimeLab intact. List every binding + decision.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' })

phase('Verify')
const lenses = [
  { key: 'svd-correctness', focus: "3x3 SVD CORRECTNESS. Verify the SVD reconstructs F (U*diag(sig)*V^T == F within tol), U and V are orthonormal, handles det<0 (reflection -> negate a column + singular value), degenerate/repeated singular values don't NaN, and the clamp+reconstruct is right. A wrong SVD silently corrupts every particle. Check signs/transposes/column-major." },
  { key: 'plasticity-stability', focus: "PLASTICITY STABILITY + BEHAVIOR. Verify the return mapping BOUNDS F (singular values clamped) so it can't blow up; plasticity=0 (no/É wide clamp) reproduces the current elastic snap-back; plasticity>0 makes deformation persist; no NaN at the material+plasticity extremes; the det<=0/NaN guard still present; interaction with dt0.1/4 substeps is stable. Flag any path that overflows the 1e6 atomics." },
  { key: 'press-model', focus: "PRESS/FLATTEN MODEL. Verify the radial-outward + downward press force is computed correctly (outward = perpendicular component of (particle - closest-point-on-ray), normalized; down = -Y), bounded by the |v|<=4 clamp + MAX_INJECT_V; the input.ts duration ramp is correct (quick tap unaffected, long press ramps); a sustained press lowers the blob (flattens) rather than launching it; no instability from the combined inward+outward+down injection." },
  { key: 'integration', focus: "INTEGRATION. Verify the 32B uniform layout matches across all 3 shaders + TS (offsets mu@0,lambda@4,visc@8,gravity@12,plasticity@16); g2p's new uniform binding index doesn't collide with its existing bindings (0 particles,1 cells,2 real_box,3 init_box -> plasticity at 4) and mls-mpm.ts adds it to g2pBindGroup + the g2p pipeline; setMaterial writes all 5; controls.ts + index.html slider id matches + per-type plasticity applied; M2 poke + ViewCube + SlimeLab untouched/working; tsc-clean; clearGrid/p2g_1/copyPosition/fluid* unchanged." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(`${CONTEXT}\n\nADVERSARIAL REVIEWER. Lens: ${l.focus}\n\nImplementation:\n\n${reconciled}\n\nREAD the real repo files. Concrete bugs (file+expression, exact fix). Skeptical; no rubber-stamp. If correct, verdict 'ship' empty bugs.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Verify: ${verdicts.flatMap(v=>(v.bugs||[]).filter(b=>b.severity!=='minor')).length} blocker/major. Finalizing.`)
phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nFINALISER. Reconciled:\n\n${reconciled}\n\nVerdicts (JSON), incorporate every blocker/major + clear minors:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce FINAL complete contents for every changed/new file ready to write verbatim. Re-verify: SVD correct; return mapping bounds F; plasticity=0==elastic; press bounded+flattens; 32B uniform consistent incl g2p binding; tsc-clean; M2/ViewCube/SlimeLab intact. Fill the schema incl material_layout, preset_plasticity, and harness_additions (persistence + press-flatten tests).`,
  { label: 'finalize', phase: 'Finalize', effort: 'high' })
return final