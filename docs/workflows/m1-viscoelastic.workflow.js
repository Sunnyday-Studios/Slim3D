export const meta = {
  name: 'slim3d-viscoelastic-kernel',
  description: 'Derive, reconcile, adversarially verify, and finalize the MLS-MPM viscoelastic slime material (per-particle deformation gradient F + fixed-corotated elastic stress via polar decomposition + viscous damping + gravity) as concrete, ready-to-write WGSL/TS file contents for the Slim3D repo',
  phases: [
    { title: 'Derive', detail: '4 agents derive the elastic MLS-MPM formulation from distinct authoritative sources' },
    { title: 'Reconcile', detail: 'merge derivations into one canonical set of file edits' },
    { title: 'Verify', detail: '5 adversarial lenses hunt for concrete bugs' },
    { title: 'Finalize', detail: 'apply fixes, emit final complete file contents' },
  ],
}

const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D MLS-MPM CONVENTIONS — READ THE REAL FILES at ${REPO}/mls-mpm/*.wgsl and ${REPO}/mls-mpm/mls-mpm.ts and ${REPO}/main.ts BEFORE proposing anything. Confirm every claim against the actual source.

- Grid spacing dx = 1 (positions are in grid-cell units; cell index = floor(position)). Quadratic B-spline weights (the weights[0..2] arrays).
- Particle struct (WGSL storage buffer, std layout), CURRENTLY 80 bytes:
    position: vec3f  @0   (padded to 16)
    v:        vec3f  @16  (padded to 32)
    C:        mat3x3f @32 (48 bytes, ends @80)   // APIC affine velocity matrix
  The SAME struct is declared in p2g_1.wgsl, p2g_2.wgsl, g2p.wgsl AND copyPosition.wgsl. ANY layout change must be applied to ALL FOUR shaders AND to mlsmpmParticleStructSize (=80) in mls-mpm.ts AND the JS init views in initDambreak() AND the local copy in main.ts.
- P2G uses INTEGER ATOMICS with fixed-point: encodeFixedPoint(f)=i32(f*fixed_point_multiplier); fixed_point_multiplier=1e7 (override constant). i32 saturates at +/-2.147e9 -> only +/-~214.7 of accumulated magnitude per channel before SILENT overflow/wrap. Elastic stresses can exceed the tuned fluid's magnitudes -> overflow risk MUST be assessed and the multiplier re-chosen if needed.
- p2g_2 grid-momentum scatter: eq_16_term0 = -volume * 4 * stress * dt; then momentum = eq_16_term0 * weight * cell_dist; atomicAdd to cells[].v{x,y,z}. (factor 4 = 1/(quadratic B-spline 2nd moment = 1/4) with dx=1.)
- g2p computes B = sum(weighted_velocity outer cell_dist), sets C = B*4, integrates position += v*dt, clamps to box, applies a wall penalty. dt=0.20; only 2 substeps/frame (the for i<2 loop in execute()).
- updateGrid divides momentum by mass, adds gravity (vy += -0.3*dt), zeros boundary-cell velocity components.
- CURRENT material (p2g_2) is NEWTONIAN: pressure = max(0, stiffness*((density/rest_density)^5 - 1)); stress = -pressure*I + dynamic_viscosity*(C + transpose(C)). NO deformation gradient F is carried -> no elastic memory -> behaves like water/honey, NOT slime.

M1 IMPLEMENTATION TARGET (ship this now):
  Add per-particle deformation gradient F: mat3x3f (initialised to IDENTITY). Update F each step in g2p: F_new = (I + dt*C)*F. Replace the Newtonian stress in p2g_2 with FIXED-COROTATED ELASTIC stress computed via POLAR DECOMPOSITION (rotation R only — NO full SVD), PLUS a viscous damping term and the existing gravity, to get viscoelastic slime (stretch, sag, snap-back, jiggle).
  - Use the iterative 3x3 polar decomposition R_{k+1} = 0.5*(R_k + transpose(inverse(R_k))) starting from R_0 = F (~3-6 iters) — provide working WGSL incl. a 3x3 determinant and inverse helper. Handle near-singular / inverted (det<=0) F gracefully.
  - Fixed-corotated Kirchhoff stress consistent with the repo's eq_16_term0 scatter: the mpm99/MLS-MPM grid stress is  -dt * p_vol * 4 * inv_dx^2 * ( 2*mu*(F - R)*transpose(F) + lambda*J*(J-1)*Identity ),  with inv_dx^2 = 1 here and J = det(F). Reconcile this with the repo's existing "-volume*4*stress*dt" so the final code is dimensionally/numerically consistent (decide stress = 2*mu*(F-R)*Ft + lambda*J*(J-1)*I and keep the -volume*4*..*dt wrapper, with volume = a CONSTANT p_vol, NOT 1/density).
  - Viscous damping: keep a dynamic_viscosity*(C + transpose(C)) term added to the elastic stress so the slime loses energy and sags (tune low). Gravity stays in updateGrid (may be retuned for a slow sag).
  PLASTICITY / SVD singular-value return-mapping (reshapeable putty) is DEFERRED to M1.5 — briefly SPEC it but DO NOT require it in the shipped M1 code.

Deliverable must be COMPLETE FILE CONTENTS (not diffs) ready to write to disk, for every file that changes: mls-mpm/p2g_1.wgsl, mls-mpm/p2g_2.wgsl, mls-mpm/g2p.wgsl, mls-mpm/copyPosition.wgsl, mls-mpm/mls-mpm.ts, and main.ts (fix the duplicated struct-size constant). clearGrid.wgsl and updateGrid.wgsl use the Cell struct (not Particle) and likely do NOT change — confirm.
`

const DERIVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    source: { type: 'string', description: 'which reference you grounded in, with what you actually fetched/read' },
    F_update: { type: 'string', description: 'exact deformation-gradient update formula + exactly where in g2p it goes (WGSL)' },
    elastic_stress: { type: 'string', description: 'exact fixed-corotated stress expression (with R, J=det F) and which tensor form (Kirchhoff/Cauchy/PK1) it is, reconciled with the repo eq_16_term0 = -volume*4*stress*dt wrapper' },
    polar_decomposition_wgsl: { type: 'string', description: 'WORKING WGSL for 3x3 determinant, inverse, and iterative polar decomposition returning R; incl. iteration count and degenerate/inverted-F handling' },
    viscous_and_gravity: { type: 'string', description: 'how the viscous damping term and gravity combine with the elastic stress for slime feel' },
    p_vol_and_volume: { type: 'string', description: 'decision: constant p_vol vs 1/density; the value to use and why; whether the existing density loop in p2g_2 stays or is removed' },
    atomic_overflow: { type: 'string', description: 'assessment of fixed_point_multiplier=1e7 (+/-214 headroom) under elastic stresses; recommended multiplier value and any stress clamp' },
    struct_changes: { type: 'string', description: 'exact byte layout after adding F: offsets, new struct size, the four shader struct blocks, mls-mpm.ts size constant, initDambreak F=identity init code, main.ts fix' },
    slime_parameters: { type: 'string', description: 'concrete numeric values: mu (shear modulus), lambda (first Lame), dynamic_viscosity, gravity, dt, substeps, p_vol — tuned for a stretchy/saggy/snappy slime, not stiff jelly nor runny water' },
    m15_plasticity_spec: { type: 'string', description: 'brief spec of the deferred SVD singular-value return-mapping for reshapeable slime' },
    stability_notes: { type: 'string', description: 'will it stay stable at dt=0.2 / 2 substeps? CFL/timestep concerns; what to reduce if it explodes' },
    citations: { type: 'array', items: { type: 'string' }, description: 'URLs actually fetched' },
  },
  required: ['source','F_update','elastic_stress','polar_decomposition_wgsl','viscous_and_gravity','p_vol_and_volume','atomic_overflow','struct_changes','slime_parameters','stability_notes','citations'],
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    bugs: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        severity: { type: 'string', enum: ['blocker','major','minor'] },
        location: { type: 'string', description: 'file + which line/expression' },
        problem: { type: 'string' },
        fix: { type: 'string', description: 'the concrete corrected code/value' },
      },
      required: ['severity','problem','fix'],
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
      properties: {
        path: { type: 'string', description: 'repo-relative path, e.g. mls-mpm/p2g_2.wgsl' },
        contents: { type: 'string', description: 'COMPLETE final file contents, ready to write verbatim' },
      },
      required: ['path','contents'],
    }},
    apply_notes: { type: 'string', description: 'order to apply, anything the human must double-check' },
    residual_risks: { type: 'string', description: 'what could still be wrong / look off on first run, and the first knob to turn' },
    tuning_knobs: { type: 'string', description: 'the 3-5 constants to tune live and which direction does what' },
  },
  required: ['files','apply_notes','residual_risks','tuning_knobs'],
}

phase('Derive')
const sources = [
  { key: 'nialltl', desc: "nialltl's 'incremental MPM' / MLS-MPM writeup (github.com/nialltl/incremental_mpm and the nialltl.neocities / blog explainer) — the very guide WebGPU-Ocean's README cites. Focus: neo-Hookean vs fixed-corotated elastic, the F update, APIC C, the WGSL/compute-friendly form." },
  { key: 'taichi-mpm99', desc: "The Taichi 'mpm99'/'mpm88' reference (github.com/taichi-dev/taichi, examples mpm99.py) and Hu et al. 2018 'A Moving Least Squares Material Point Method' (MLS-MPM, SIGGRAPH 2018). Focus: the exact stress = 2*mu*(F-R)*F^T + lambda*J*(J-1)*I and the -dt*p_vol*4*inv_dx^2 grid term, fixed-corotated, and where SVD plasticity plugs in." },
  { key: 'jiang-course', desc: "Jiang, Schroeder, Gast, Teran 'The Material Point Method for Simulating Continuum Mechanics' (SIGGRAPH 2016 course notes) + Stomakhin et al. 2013 snow. Focus: rigorous continuum derivation, polar decomposition, fixed-corotated energy density, return mapping; verify sign/transpose conventions." },
  { key: 'webgpu-impls', desc: "Practical real-time WebGPU/WebGL/Unity MPM jelly/slime/snow implementations (search: 'WebGPU MPM jelly', 'mls-mpm wgsl elastic', matsuoka-601 other repos, nialltl Unity, grant kot mpm). Focus: a battle-tested 3x3 polar decomposition by Newton iteration in shader code, 3x3 det/inverse helpers, and how they handle the fixed-point atomic precision/overflow." },
]
const derivations = (await parallel(sources.map(s => () =>
  agent(
    `${CONTEXT}\n\nYOU ARE DERIVATION AGENT '${s.key}'. Ground your derivation in: ${s.desc}\n\nUse WebSearch/WebFetch (load via ToolSearch query "select:WebSearch,WebFetch" first) to fetch the real source material and CITE exact URLs. Also READ the actual Slim3D repo files listed in the conventions block so your formulas match the real code's variable names and scatter convention. Then fill the schema with a concrete, implementable derivation for the M1 target (fixed-corotated elastic via polar decomposition + viscous + gravity; NO full SVD in M1). Give WORKING WGSL for the polar decomposition and stress, not pseudocode. Be exact about signs, transposes, the factor of 4, det(F), and the struct byte layout.`,
    { label: `derive:${s.key}`, phase: 'Derive', schema: DERIVE_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

log(`Derivations complete: ${derivations.length}/4. Reconciling.`)

phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nYou are the RECONCILER. Here are ${derivations.length} independent derivations of the Slim3D M1 viscoelastic kernel (JSON):\n\n${JSON.stringify(derivations, null, 2)}\n\nREAD the actual repo files at ${REPO} first. Then produce ONE canonical, internally-consistent implementation of the M1 target. Where the derivations disagree (e.g. Kirchhoff vs Cauchy stress, p_vol value, polar iteration count, fixed_point_multiplier, gravity, mu/lambda), DECIDE explicitly and state why. \n\nOutput, as clearly fenced code blocks each preceded by '=== FILE: <repo-relative-path> ===', the COMPLETE proposed contents of every file that changes: mls-mpm/p2g_1.wgsl, mls-mpm/p2g_2.wgsl, mls-mpm/g2p.wgsl, mls-mpm/copyPosition.wgsl, mls-mpm/mls-mpm.ts, main.ts. Keep clearGrid.wgsl and updateGrid.wgsl unchanged unless you justify a change. The struct (with F) must be byte-identical across all four shaders; mlsmpmParticleStructSize and the JS init must match; the p2g_2 override constants in mls-mpm.ts must exactly match the override declarations in p2g_2.wgsl. Include a short rationale section listing every decision and the chosen constant values. Make it ready to hand to adversarial reviewers.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' }
)

phase('Verify')
const lenses = [
  { key: 'struct-byte-layout', focus: "STRUCT/BYTE-LAYOUT consistency. Verify the Particle struct with F is byte-identical and std140/std430-correct in ALL FOUR shaders (p2g_1, p2g_2, g2p, copyPosition); that mat3x3f is 48 bytes (3x vec3 padded to 16) and F sits at @80 making struct size 128; that mlsmpmParticleStructSize is updated to 128; that initDambreak writes F=identity at the right float offsets (col-major, padded: floats at +80,+81,+82 / +84,+85,+86 / +88,+89,+90 i.e. Float32Array(buf, off+80, 12) = [1,0,0,0, 0,1,0,0, 0,0,1,0]); that main.ts no longer hardcodes 80; that posvel struct (32 bytes) is unaffected." },
  { key: 'numerical-stability-atomics', focus: "NUMERICAL STABILITY + FIXED-POINT ATOMIC OVERFLOW. Estimate worst-case magnitude of momentum = (-volume*4*dt) * stress * weight * cell_dist for the chosen mu/lambda/p_vol, and check it against the +/-214.7 headroom at fixed_point_multiplier=1e7. If it can overflow, the multiplier MUST be lowered (and precision impact stated) or stress clamped. Check dt=0.2 with 2 substeps for fixed-corotated stability (CFL); check det(F)/J guards for inverted or near-zero F; check the polar iteration converges and inverse() never divides by ~0." },
  { key: 'physical-correctness', focus: "PHYSICAL/DERIVATION CORRECTNESS. Verify F_update = (I + dt*C)*F (order, dt), C = B*4 still set in g2p, and the stress = 2*mu*(F-R)*transpose(F) + lambda*J*(J-1)*I is the correct fixed-corotated Kirchhoff stress matching the -volume*4*..*dt scatter (no double-counting of dt or volume; sign such that it RESTORES shape, i.e. stretched F pulls back). Confirm viscous term sign damps (removes energy). Confirm gravity unchanged in updateGrid. Cross-check against mpm99." },
  { key: 'wgsl-language', focus: "WGSL LANGUAGE + OVERRIDE WIRING. Verify mat3x3f construction is column-major and consistent; matrix*matrix, matrix*vector, transpose(), determinant() (WGSL has built-in determinant() for mat3x3f — confirm, else custom), and any inverse() is custom (WGSL has NO inverse builtin). Verify every `override X: f32;` in each shader is actually supplied by the matching pipeline `constants:{}` in mls-mpm.ts (names EXACTLY equal), and removed overrides aren't still passed. No reserved words, no missing semicolons, loop bounds valid." },
  { key: 'init-degenerate-boundary', focus: "INITIALISATION, DEGENERATE-F, BOUNDARY. Verify F starts as identity for EVERY spawned particle (not zero — zero F => det 0 => singular => NaN blowup). Verify particles spawned but beyond numParticles are not simulated with garbage F. Verify the density loop removal (if removed) doesn't break the volume term. Verify wall penalty + position clamp in g2p still apply. Verify reset() re-initialises F. Check first-frame behaviour (F=I => R=I => F-R=0 => zero elastic stress => only gravity/viscous act => blob should fall and then resist — sane)." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(
    `${CONTEXT}\n\nYou are an ADVERSARIAL REVIEWER. Your single lens: ${l.focus}\n\nHere is the reconciled implementation to attack:\n\n${reconciled}\n\nAlso READ the actual repo files at ${REPO} to confirm context. Hunt for CONCRETE bugs through your lens only — be specific (file + expression), default to skepticism, and for each bug give the exact corrected code/value. If through your lens it is correct, say verdict 'ship' with an empty bugs list. Do NOT rubber-stamp.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

const blockers = verdicts.flatMap(v => (v.bugs||[]).filter(b => b.severity === 'blocker' || b.severity === 'major'))
log(`Verify complete. ${verdicts.length} lenses, ${blockers.length} blocker/major findings. Finalizing.`)

phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nYou are the FINALISER. Here is the reconciled implementation:\n\n${reconciled}\n\nHere are the adversarial review verdicts (JSON) — incorporate EVERY 'blocker' and 'major' fix, and any 'minor' fix that is clearly correct:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce the FINAL, COMPLETE contents of every file that changes, ready to write to disk verbatim. Re-verify before returning: struct byte-identical across the 4 shaders + size 128 + JS init identity; override names match pipeline constants exactly; chosen fixed_point_multiplier safe vs overflow; stress/F-update signs correct; no WGSL inverse() builtin used (provide custom); first frame sane. Fill the schema. In tuning_knobs name the exact constants (mu, lambda, dynamic_viscosity, gravity, fixed_point_multiplier) and which way to turn each for 'softer/saggier' vs 'firmer/snappier'.`,
  { label: 'finalize', phase: 'Finalize', schema: FINAL_SCHEMA, effort: 'high' }
)

return final