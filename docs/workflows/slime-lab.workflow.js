export const meta = {
  name: 'slim3d-slime-lab',
  description: 'Research commercial slime taxonomy (top-5 types + top-5 variations for color/texture/foam/mix-ins, cited), then design + build an interactive "Slime Lab" control panel for Slim3D: type presets + color + finish + live physics sliders + foam toggle, wired to a refactor of the physics override-constants into a runtime material uniform and a new render style uniform. Emits ready-to-write file contents + headless-harness additions; stages sprinkles/charms as a designed v2.',
  phases: [
    { title: 'Research', detail: '3 agents: slime types, mix-ins/foam, color/texture — cited' },
    { title: 'Reconcile', detail: 'taxonomy + full v1 implementation code + v2 design' },
    { title: 'Verify', detail: '4 adversarial lenses incl physics-refactor + render + UI' },
    { title: 'Finalize', detail: 'final files + taxonomy + harness additions + v2 plan' },
  ],
}

const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D SLIME LAB — add an interactive control panel to a WebGPU MLS-MPM slime blob so the user can change COLOR and slime TYPE (and finish/foam) live via sliders/checkboxes/swatches, grounded in real commercial slime varieties. READ THE REAL FILES at ${REPO} before writing any code: index.html, main.ts, common.ts, input.ts, mls-mpm/mls-mpm.ts, mls-mpm/p2g_2.wgsl, mls-mpm/updateGrid.wgsl, render/fluidRender.ts, render/fluid.wgsl. Confirm every binding/struct/uniform against the actual source.

CURRENT STATE (validated + deployed):
- MLS-MPM sim (mls-mpm/mls-mpm.ts), particle struct 128B {position,v,C,F}. The material params are WGSL OVERRIDE CONSTANTS baked at pipeline creation: p2g_2.wgsl has 'override fixed_point_multiplier, dynamic_viscosity, dt, elastic_mu, elastic_lambda, p_vol'; updateGrid.wgsl has 'override fixed_point_multiplier, dt' and a HARDCODED gravity literal (vy += -0.3 * dt). These 2 shaders + the other 4 (clearGrid,p2g_1,g2p,copyPosition) + pointerForce.wgsl are headless-validated. Default material: elastic_mu=3, elastic_lambda=6, dynamic_viscosity=0.6, gravity=-0.3, dt=0.20, fixed_point_multiplier=1e6, p_vol=1.
- Renderer (render/fluidRender.ts + render/fluid.wgsl): screen-space fluid. fluid.wgsl reconstructs normals from depth and does Fresnel + Beer-Lambert refraction against a cubemap; the diffuse/base slime color is currently HARDCODED in fluid.wgsl. renderUniformsValues (common.ts) is a 272B buffer {texel_size,sphere_size,inv_projection,projection,view,inv_view}.
- M2 input: input.ts InputController owns canvas pointer events (1-finger poke / 2-finger orbit-pinch / mouse). The control panel is SEPARATE DOM (not a child of the canvas), so taps on sliders do NOT poke the slime — keep it that way.
- index.html has #brand, #stats, #controls (Reset blob + Show particles + hint), #status panels with a dark glass style. Mobile: the user tests on an iPhone, so the panel MUST be mobile-friendly: collapsible (a small gear/▣ toggle), scrollable, and must NOT cover the slime when collapsed.

V1 SCOPE TO IMPLEMENT NOW (ship this):
1. PHYSICS -> RUNTIME UNIFORM (so sliders/type work live without recreating pipelines):
   - Add a Material uniform, std140 16B: { mu: f32@0, lambda: f32@4, viscosity: f32@8, gravity: f32@12 }.
   - p2g_2.wgsl: REMOVE 'override elastic_mu/elastic_lambda/dynamic_viscosity'; add '@group(0) @binding(3) var<uniform> mat: Material;' and use mat.mu, mat.lambda, mat.viscosity. KEEP dt, p_vol, fixed_point_multiplier as overrides. MATH MUST BE IDENTICAL — only the source of mu/lambda/viscosity changes.
   - updateGrid.wgsl: add '@group(0) @binding(3) var<uniform> mat: Material;' and replace the hardcoded -0.3 with mat.gravity (vy += mat.gravity * dt). KEEP dt, fixed_point_multiplier overrides.
   - mls-mpm.ts: create materialUniformBuffer (16B, UNIFORM|COPY_DST), add it as binding 3 to p2g2BindGroup AND updateGridBindGroup, drop the moved overrides from those two pipelines' constants, add setMaterial(mu,lambda,viscosity,gravity) that writes the buffer, initialize to the defaults (3,6,0.6,-0.3) in the constructor + reset(). Pointer/poke pass + the other shaders UNCHANGED.
2. RENDER STYLE -> UNIFORM (color + finish + foam live):
   - Add a Style uniform for fluid.wgsl: { color: vec3f, gloss: f32 (specular/Fresnel strength 0..1), opacity: f32 (Beer-Lambert tint depth), foam: f32 (0=off, >0 = white surface speckle amount), ...pad to 16-align }. Design the exact fields/offsets; document them.
   - fluid.wgsl: replace the hardcoded base color with style.color; modulate the specular/Fresnel by style.gloss (low gloss = matte 'butter', high = glossy/clear); scale refraction/absorption tint by style.opacity; if style.foam>0 add a cheap procedural white speckle/foam on the surface (e.g. value-noise or hash on screen-space/world pos, thresholded, mixed toward white) — must be a pure-shading effect, no new geometry. Keep it toggleable (foam=0 -> identical to no-foam).
   - render/fluidRender.ts: create the style uniform buffer, add it to the fluid pipeline's bind group, expose setStyle(color,gloss,opacity,foam). common.ts: add the style buffer/layout if cleaner there, else keep in fluidRender.
3. CONTROL PANEL (controls.ts NEW + index.html + main.ts):
   - A collapsible 'Slime Lab' panel (gear toggle, default collapsed on small screens). Controls:
     * TYPE: 5 buttons/segmented control for the 5 researched types. Selecting one calls sim.setMaterial(preset.physics) + renderer.setStyle(preset.style).
     * COLOR: a row of researched popular color SWATCHES + an <input type=color> custom picker -> renderer.setStyle(color).
     * FINISH: a slider gloss (matte<->glossy) -> setStyle.
     * SQUISH (mu), STRETCH/HOLD (lambda), FLOW (viscosity), GRAVITY sliders -> sim.setMaterial. Give sensible min/max (stability-safe: keep mu in ~[1,6], lambda ~[2,12], viscosity ~[0.1,1.5], gravity ~[-0.6,0]).
     * FOAM: checkbox + amount slider -> setStyle(foam).
   - controls.ts holds the 5 TYPE PRESETS (from research): each = { name, physics:{mu,lambda,viscosity,gravity}, style:{color,gloss,opacity,foam} }. Wire all DOM controls; on type-select, also push the slider positions to match the preset.
   - index.html: add the panel markup + mobile-friendly CSS (collapsible, max-height + scroll, doesn't block canvas). main.ts: instantiate Controls(sim, renderer) after creating them; apply a default type on load.
   - Touch: the panel is normal DOM; ensure controls work on touch (range inputs, color input, buttons) and that interacting with them does not trigger canvas poke (separate element — confirm).

V2 (DESIGN ONLY — DO NOT IMPLEMENT NOW): MIX-INS — sprinkles (fimo/polymer-clay slices), fishbowl beads, foam beads (floam/crunchy), glitter, charms/trinkets. These need a NEW render pass (a tagged subset of particles drawn as small instanced colored sprites/shapes that advect with the slime) and visual iteration. Provide a concrete v2 design (data model: tag particles as inclusions; a new instanced render pass reading posvel; how to seed/color them per mix-in type) but DO NOT write its code.

CONSTRAINTS: Keep the M1 elastic MATH identical (only move param source to a uniform). Keep M2 poke working (don't disturb input.ts/pointerForce bindings; particle struct stays 128B). Keep stability — slider ranges must stay in the validated-stable regime (mu up to ~6 was stable; do NOT allow values that blow up F). tsc-clean. Mobile-first panel. Provide harness_additions to re-validate the material-uniform refactor (the sim harness must now bind the 16B material uniform at binding 3 of p2g_2 and updateGrid and write the defaults).

DELIVERABLE: COMPLETE final contents for every new/changed file: controls.ts (new), index.html, main.ts, common.ts (if changed), mls-mpm/mls-mpm.ts, mls-mpm/p2g_2.wgsl, mls-mpm/updateGrid.wgsl, render/fluidRender.ts, render/fluid.wgsl. Do NOT change the other 4 sim shaders, input.ts, or pointerForce.wgsl.
`

const RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    top5: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        characteristics: { type: 'string', description: 'physical feel and/or visual look in concrete terms' },
        slim3d_mapping: { type: 'string', description: 'how to express it with Slim3D params: physics {mu,lambda,viscosity,gravity} and/or render style {color,gloss,opacity,foam}' },
      }, required: ['name','description','characteristics','slim3d_mapping'],
    }},
    extra_variations: { type: 'string', description: 'beyond the top5, other notable variations worth a slider/checkbox' },
    citations: { type: 'array', items: { type: 'string' } },
  },
  required: ['area','top5','citations'],
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    bugs: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { severity: { type: 'string', enum: ['blocker','major','minor'] }, location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
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
      properties: { path: { type: 'string' }, contents: { type: 'string' } },
      required: ['path','contents'],
    }},
    taxonomy: { type: 'string', description: 'the cited research deliverable: the 5 types + top variations for color/texture/foam/mix-ins, with sources — written for the user to read' },
    type_presets: { type: 'string', description: 'the 5 chosen type presets with their exact physics + style param values' },
    v2_plan: { type: 'string', description: 'concrete design for the staged sprinkles/charms/beads inclusion-render layer' },
    apply_notes: { type: 'string' },
    residual_risks: { type: 'string' },
    tuning_knobs: { type: 'string' },
    harness_additions: { type: 'string', description: 'how to extend d:/tmp/slim3d-validate/sim_harness.js + poke_harness.js to bind the new 16B material uniform (binding 3 of p2g_2 and updateGrid) and re-validate stability across the slider ranges' },
  },
  required: ['files','taxonomy','type_presets','v2_plan','apply_notes','harness_additions'],
}

phase('Research')
const areas = [
  { key: 'types', desc: 'The top 5 most popular/best-selling COMMERCIAL slime TYPES. Survey real slime shops (Etsy slime stores, Amazon, big slime brands like Peachybbies/Aphmau/Mavin/Craft City, r/slime). For each: its defining TEXTURE/feel (e.g. clear/glass, glossy/thick, butter, cloud, fluffy, jelly, crunchy/floam, clay, metallic/chrome) and how to express it as Slim3D physics {mu,lambda,viscosity,gravity} + render {gloss,opacity,foam}. Cite real product pages.' },
  { key: 'mixins-foam', desc: 'The top 5 categories of slime MIX-INS / ADD-INS sold (foam beads/floam, fishbowl beads, glitter, sprinkles = fimo/polymer-clay slices, charms/trinkets, sequins, instant-snow/cloud). Plus how BUBBLES/FOAM appears in slime (air bubbles, crunchy foam-bead texture, fluffy foam). For each: what it looks like + how it would be represented (render speckle/foam vs discrete inclusion sprites). Cite real product pages.' },
  { key: 'color-texture', desc: 'The top 5 COLOR families/palettes popular in slime (pastels, neons/brights, metallic/chrome, glitter/holographic, clear-tinted/jelly, glow-in-the-dark, black) AND the top 5 FINISH/texture looks (glossy, matte/butter, cloud/fluffy-opaque, crunchy, clear/translucent). Give concrete hex palettes for swatches and how each finish maps to {gloss,opacity,foam}. Cite.' },
]
const research = (await parallel(areas.map(a => () =>
  agent(
    `${CONTEXT}\n\nYOU ARE RESEARCH AGENT '${a.key}'. Focus: ${a.desc}\n\nUse WebSearch/WebFetch (load via ToolSearch "select:WebSearch,WebFetch"). Ground in REAL commercial sources and CITE exact URLs. Fill the schema: a genuine TOP-5 with concrete characteristics and an explicit Slim3D param mapping for each. Be specific with numbers (hex colors, gloss/opacity 0..1, mu/lambda/viscosity/gravity).`,
    { label: `research:${a.key}`, phase: 'Research', schema: RESEARCH_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

log(`Research complete: ${research.length}/3. Reconciling into taxonomy + v1 code.`)

phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nYou are the RECONCILER. Here is the slime research (JSON):\n\n${JSON.stringify(research, null, 2)}\n\nREAD the real repo files at ${REPO}. Produce: (A) a clean cited TAXONOMY for the user (the 5 types + top variations for color/texture/foam/mix-ins). (B) the 5 chosen TYPE PRESETS with exact Slim3D params {mu,lambda,viscosity,gravity, color,gloss,opacity,foam}, stability-safe (mu<=6, lambda<=12, viscosity 0.1..1.5, gravity -0.6..0). (C) the COMPLETE v1 implementation as fenced blocks each headed '=== FILE: <repo-relative-path> ===' for: controls.ts, index.html, main.ts, common.ts (if changed), mls-mpm/mls-mpm.ts, mls-mpm/p2g_2.wgsl, mls-mpm/updateGrid.wgsl, render/fluidRender.ts, render/fluid.wgsl. (D) the v2 sprinkles/charms design (no code). Ensure: Material uniform 16B {mu@0,lambda@4,viscosity@8,gravity@12} bound at binding 3 of BOTH p2g_2 and updateGrid, written by setMaterial; the M1 elastic math is character-for-character the same except mu/lambda/viscosity now come from 'mat.*' and gravity from 'mat.gravity'; the Style uniform fields/offsets are consistent between fluidRender.ts and fluid.wgsl; the panel is mobile-collapsible and its DOM ids match controls.ts; tsc-clean; M2 poke untouched. List every decision + the exact uniform layouts.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' }
)

phase('Verify')
const lenses = [
  { key: 'physics-refactor', focus: "PHYSICS UNIFORM REFACTOR. Verify the M1 elastic math in p2g_2.wgsl is IDENTICAL except mu/lambda/viscosity now read from the Material uniform; updateGrid uses mat.gravity*dt in place of -0.3*dt; the 16B std140 layout {mu@0,lambda@4,viscosity@8,gravity@12} matches the TS writer byte-for-byte; binding 3 is added to BOTH p2g2 and updateGrid pipelines' bind groups AND the moved overrides are REMOVED from their constants (a leftover override for a now-uniform name, or a missing binding, fails pipeline creation); defaults (3,6,0.6,-0.3) set in ctor+reset; slider ranges stay in the stable regime. The other 4 sim shaders + pointerForce + input.ts UNTOUCHED." },
  { key: 'render-style', focus: "RENDER STYLE. Verify the Style uniform fields/offsets are byte-consistent between fluidRender.ts (writer) and fluid.wgsl (reader); the new uniform is added to the fluid pipeline bind group with correct binding index + visibility; fluid.wgsl uses style.color/gloss/opacity correctly and foam=0 reproduces the current look (no regression); the foam speckle is pure shading (no geometry) and bounded; no other render pass (depth/thickness/sphere) is broken by the bind-group change." },
  { key: 'ui-wiring', focus: "UI WIRING + MOBILE. Verify every DOM id/class referenced in controls.ts exists in index.html and vice-versa; range/color/checkbox/button handlers call the right sim.setMaterial/renderer.setStyle; selecting a TYPE updates BOTH the engine and the slider positions; the panel is collapsible and on a phone does not cover the canvas or block the poke (separate DOM, touch works on range/color inputs); tsc types are correct (Controls ctor args, no missing nulls); default type applied on load + after Reset." },
  { key: 'integration-stability', focus: "INTEGRATION + STABILITY. Verify main.ts frame order still works (input.update -> writeBuffer -> execute -> applyPointerForce -> render) and the new uniforms are written before use; setMaterial/setStyle are safe to call every change; no per-frame pipeline recreation; the material uniform is written at least once before first execute; slider min/max cannot push mu/lambda/gravity into the F-blowup regime found earlier (sustained); buffers sized right. Flag anything that could NaN or overflow the 1e6 atomics." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(
    `${CONTEXT}\n\nYou are an ADVERSARIAL REVIEWER. Lens: ${l.focus}\n\nReconciled taxonomy + implementation:\n\n${reconciled}\n\nREAD the real repo files at ${REPO}. Find CONCRETE bugs (file+expression, exact fix). Default to skepticism. If correct through your lens, verdict 'ship' with empty bugs.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

const blockers = verdicts.flatMap(v => (v.bugs||[]).filter(b => b.severity === 'blocker' || b.severity === 'major'))
log(`Verify complete. ${verdicts.length} lenses, ${blockers.length} blocker/major. Finalizing.`)

phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nYou are the FINALISER. Reconciled implementation:\n\n${reconciled}\n\nAdversarial verdicts (JSON) — incorporate every blocker/major + clear minors:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce FINAL complete contents for every new/changed file, ready to write verbatim. Re-verify: Material uniform layout/bindings consistent + overrides removed; Style uniform consistent; M1 math identical; M2 untouched; tsc-clean; mobile panel; foam=0 no-regression. Fill the schema — taxonomy (cited, user-facing), type_presets (exact values), v2_plan (sprinkles design), and harness_additions (exact steps to bind the 16B material uniform at binding 3 in both sim_harness.js and poke_harness.js and re-validate).`,
  { label: 'finalize', phase: 'Finalize', schema: FINAL_SCHEMA, effort: 'high' }
)
return final