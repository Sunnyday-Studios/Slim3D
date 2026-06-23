export const meta = {
  name: 'slim3d-mixins',
  description: 'Design, reconcile, adversarially verify, finalize MIX-INS for Slim3D: sprinkles/beads/glitter rendered as colored billboards at a tagged subset of the existing MLS-MPM particles (they advect with the slime), via a NEW render pass depth-integrated with the fluid surface, with UI toggles. A separate inclusion buffer — the validated 128B particle struct + 6 sim shaders stay untouched. Emits ready-to-write files + shader-compile validation.',
  phases: [
    { title: 'Design', detail: '3 agents: inclusion data+tagging, billboard render pass, UI+integration' },
    { title: 'Reconcile', detail: 'one coherent implementation as full files' },
    { title: 'Verify', detail: '3 lenses: render-correctness, sim/buffer-safety, integration' },
    { title: 'Finalize', detail: 'final files + harness compile-check steps' },
  ],
}
const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D MIX-INS — add slime mix-ins (sprinkles, beads/fishbowl beads, glitter) that sit IN the slime and move with it. Render them as small COLORED BILLBOARDS at a TAGGED SUBSET of the existing MLS-MPM particles (so they advect with the slime for free — they ARE slime particles, just drawn differently). READ the real files at ${REPO} first: render/fluidRender.ts (the whole renderer), render/sphere.wgsl (existing point-sprite/billboard reference), render/depthMap.wgsl + render/fluid.wgsl (depth + composite), common.ts (renderUniforms layout), mls-mpm/mls-mpm.ts (particle/posvel buffers, reset/initDambreak), controls.ts, index.html, main.ts.

HARD CONSTRAINTS (protect what works):
- DO NOT change the 128B particle struct, the 6 validated sim shaders (clearGrid/p2g_1/p2g_2/updateGrid/g2p/copyPosition), pointerForce.wgsl, or the elastic/plastic sim. Mix-ins are a SEPARATE inclusion buffer + a RENDER-ONLY pass.
- DO NOT break the existing fluid render (depth -> bilateral -> thickness -> fluid composite, + sphere debug pass) or M2 poke / ViewCube / Slime Lab / audio.

CURRENT RENDER (confirm by reading render/fluidRender.ts):
- FluidRenderer renders to the canvas: a DEPTH pass (particles as point-sprite billboards -> analytic-sphere depth into depthMapTextureView), bilateral blur, a THICKNESS pass, then the FLUID composite (reconstruct normals from depth, Fresnel + refraction + the new SlimeStyle color/gloss/opacity/foam). There is also a 'sphere' debug pass (render/sphere.wgsl) drawing point-sprite spheres (the "Show particles" toggle). It reads the posvel buffer (32B per particle: position vec3f@0, v vec3f@16) + renderUniformBuffer (inv_projection/projection/view/inv_view) + a depth-test texture. execute(context, encoder, numParticles, sphereRenderFl).

MANDATED IMPLEMENTATION:
1. INCLUSION DATA (no particle-struct change): a NEW GPU buffer 'inclusionBuffer' indexed by particle id, one entry per particle: { kind: u32 (0=none/plain slime, 1=sprinkle, 2=bead, 3=glitter), color: packed rgba8 or vec3<f32>, size: f32 } (pick a tight std430 layout, e.g. 16B/particle: kind u32 + size f32 + color (2x f16 packed or rgba8 u32) — document it). mls-mpm.ts owns it (created in ctor sized numParticlesMax). A setMixins(config) method (called from controls.ts) re-tags: for each enabled mix-in type, deterministically mark a fraction (density) of particle ids with that kind + a per-kind color (sprinkles = random from a candy palette; beads = translucent pastel; glitter = bright random) + size; kind=0 for the rest. Re-tag on reset() too (so a fresh blob keeps the chosen mix-ins). Expose getInclusionBuffer().
2. RENDER PASS (render/sprinkles.wgsl NEW + a pipeline in fluidRender.ts): an INSTANCED billboard pass, one instance per particle, drawn AFTER the fluid composite. Vertex: read posvel[id].position + inclusionBuffer[id]; if kind==0 OR size==0 -> output a degenerate/clipped triangle (cheap skip); else emit a small camera-facing quad (billboard) sized by .size, projected via the renderUniforms matrices (same convention as sphere.wgsl). Fragment: draw the inclusion shape per kind — sprinkle = small rounded-rect/elongated colored mark, bead = round dot with a soft specular highlight, glitter = tiny bright speck with a sparkle — colored by .color; round alpha mask (discard outside the disc). DEPTH: test against the fluid surface depth (depthMapTextureView / the same depth used by the sphere pass) so inclusions are OCCLUDED by the front of the blob and only the ones near/at the surface show — i.e. embedded sprinkles, not floating. Blend over the composited fluid color. Keep it ONE extra pass.
3. UI (controls.ts + index.html): in the Slime Lab panel, a 'Mix-ins' group: checkboxes for Sprinkles / Beads / Glitter + a density slider (e.g. 0..1 -> fraction of particles tagged, capped low like <=0.08 so it reads as sprinkles not noise). Toggling calls sim.setMixins(config); renderer just reads the buffer. Optionally per-type default colors.
4. main.ts: pass the inclusion buffer to the FluidRenderer (ctor or a setter), draw the new pass in execute(), wire the controls.

CONSTRAINTS: validated sim + 128B struct + 6 sim shaders UNTOUCHED (mix-ins are a separate buffer + render pass). The new pass must depth-integrate so inclusions don't float in front of the blob. Bounded density. tsc-clean. NOTE: I can compile-check the WGSL headless (catches syntax/binding) but CANNOT see the render — so be robust + conservative; the user verifies the look + will likely iterate. Provide a fallback: if a mix-in toggle is off, zero tagged -> the pass is a no-op (no visual change vs now).

DELIVERABLE: COMPLETE contents for: render/sprinkles.wgsl (new), render/fluidRender.ts, mls-mpm/mls-mpm.ts (inclusion buffer + setMixins + reset tagging — NO struct/sim-shader change), controls.ts, index.html, main.ts. Do NOT change the 6 sim shaders, pointerForce.wgsl, p2g_2/updateGrid/g2p, fluid.wgsl, camera.ts, viewcube.ts, audio.ts, input.ts.
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
  apply_notes: { type: 'string' }, inclusion_layout: { type: 'string', description: 'the inclusion buffer byte layout + binding indices + pass placement' },
  residual_risks: { type: 'string' }, verify_steps: { type: 'string', description: 'what the user should look for (per mix-in) on desktop + phone' },
  harness_additions: { type: 'string', description: 'how to extend slimelab_harness.js to compile sprinkles.wgsl + (if feasible) create the render pipeline headless to catch binding mismatches' },
}, required: ['files','apply_notes','inclusion_layout','verify_steps'] }

phase('Design')
const areas = [
  { key: 'inclusion-data', desc: 'The inclusion buffer (tight std430 layout per particle: kind/color/size), the deterministic tagging in mls-mpm.ts setMixins(config)+reset() (fraction per enabled type, per-kind palette, NO particle-struct change), and how the renderer gets it. Keep the 128B struct + 6 sim shaders untouched.' },
  { key: 'render-pass', desc: 'The render/sprinkles.wgsl instanced billboard pass + its pipeline in fluidRender.ts: per-particle billboard from posvel + inclusion buffer, degenerate-skip for kind==0, per-kind fragment shapes (sprinkle/bead/glitter) with round alpha, DEPTH-tested against the fluid surface depth so inclusions are occluded by the blob front (embedded look), blended after the fluid composite. Match sphere.wgsl billboard/projection conventions. Provide working WGSL + the pipeline/bindgroup/depth-state code.' },
  { key: 'ui-integration', desc: 'controls.ts + index.html Mix-ins UI (Sprinkles/Beads/Glitter checkboxes + density slider, capped low) -> sim.setMixins; main.ts wiring (pass inclusion buffer to renderer, draw the pass in execute); ensure off = no-op (no visual change). Keep SlimeLab/audio/ViewCube intact.' },
]
const designs = (await parallel(areas.map(a => () =>
  agent(`${CONTEXT}\n\nYOU ARE DESIGN AGENT '${a.key}'. Focus: ${a.desc}\n\nREAD the real repo files (esp. render/fluidRender.ts + render/sphere.wgsl for the billboard/depth conventions). Produce WORKING code (fill schema), exact about buffer layout, bindings, depth state, and projection.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Designs: ${designs.length}/3. Reconciling.`)
phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nRECONCILER. Designs (JSON):\n\n${JSON.stringify(designs, null, 2)}\n\nREAD the real repo files. Produce ONE coherent implementation as fenced blocks headed '=== FILE: <repo-relative-path> ===' for: render/sprinkles.wgsl, render/fluidRender.ts, mls-mpm/mls-mpm.ts, controls.ts, index.html, main.ts. Ensure: inclusion buffer layout consistent (WGSL struct == TS writer); the new pass is added correctly to FluidRenderer.execute (after the fluid composite, correct depth state, correct bind groups vs the auto layout); 128B struct + 6 sim shaders + pointerForce + fluid.wgsl + camera/viewcube/audio/input UNCHANGED; off = no-op; tsc-clean. List bindings + decisions.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' })

phase('Verify')
const lenses = [
  { key: 'render-correctness', focus: "RENDER CORRECTNESS. Verify the billboard projection matches sphere.wgsl's convention (same renderUniforms matrices, camera-facing quad, correct clip-space); kind==0/size==0 truly degenerates (no stray pixels); per-kind fragment round-alpha/discard correct; the DEPTH state + texture make inclusions occluded by the blob front (not floating) and not z-fighting; blend state composites over the fluid; the pipeline/bindgroup indices match the WGSL @group/@binding; render targets/formats match the existing passes. A binding/format mismatch = runtime pipeline error (black/crash) — check rigorously." },
  { key: 'sim-buffer-safety', focus: "SIM + BUFFER SAFETY. Verify the 128B particle struct + 6 sim shaders + pointerForce are byte-UNCHANGED; the inclusion buffer is a SEPARATE buffer (size numParticlesMax * stride, usage STORAGE|COPY_DST) and its std430 layout matches the WGSL struct byte-for-byte; setMixins writes within bounds; reset re-tags; density is capped; tagging is deterministic (no Math.random pitfalls causing per-frame churn). No sim regression." },
  { key: 'integration', focus: "INTEGRATION + TS. tsc-clean; controls.ts/index.html mix-in ids match; setMixins called on toggle + density change; off = no-op (zero tagged -> pass draws nothing, identical to current); FluidRenderer ctor/execute signature changes threaded through main.ts; SlimeLab/audio/ViewCube/poke untouched; the extra pass doesn't tank perf (instanced over numParticles is OK, most degenerate). No console errors." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(`${CONTEXT}\n\nADVERSARIAL REVIEWER. Lens: ${l.focus}\n\nImplementation:\n\n${reconciled}\n\nREAD the real repo files. Concrete bugs (file+expression, exact fix). Skeptical; no rubber-stamp. If correct, verdict 'ship' empty bugs.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Verify: ${verdicts.flatMap(v=>(v.bugs||[]).filter(b=>b.severity!=='minor')).length} blocker/major. Finalizing.`)
phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nFINALISER. Reconciled:\n\n${reconciled}\n\nVerdicts (JSON), incorporate every blocker/major + clear minors:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce FINAL complete contents for render/sprinkles.wgsl, render/fluidRender.ts, mls-mpm/mls-mpm.ts, controls.ts, index.html, main.ts ready to write verbatim. Re-verify: inclusion layout consistent; depth-integrated billboards; off=no-op; 128B struct + 6 sim shaders + pointerForce + fluid.wgsl + camera/viewcube/audio/input UNCHANGED; tsc-clean. Fill the schema incl inclusion_layout, verify_steps, harness_additions (compile sprinkles.wgsl headless).`,
  { label: 'finalize', phase: 'Finalize', effort: 'high' })
return final