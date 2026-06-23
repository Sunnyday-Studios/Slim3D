export const meta = {
  name: 'slim3d-audio',
  description: 'Design, reconcile, adversarially verify, finalize a procedural Web Audio layer for Slim3D: interaction-driven pop/crackle/squelch synthesized per slime type (Clear/Glossy/Butter/Cloud/Floam/Jelly), with mobile audio-unlock + a mute toggle. Pure JS/Web Audio, zero audio assets, no sim/shader changes. Emits ready-to-write files.',
  phases: [
    { title: 'Design', detail: '3 agents: synthesis+profiles, audio engine, interaction wiring' },
    { title: 'Reconcile', detail: 'one coherent implementation as full files' },
    { title: 'Verify', detail: '3 lenses: web-audio correctness, interaction wiring, integration' },
    { title: 'Finalize', detail: 'final files + per-type profiles + test steps' },
  ],
}
const REPO = 'd:/SunnydayTech/Studio/Slim3D'

const CONTEXT = `
SLIM3D AUDIO — add the popping/crackling/squelch sounds real slime makes, synthesized PROCEDURALLY (no audio files — zero-asset, fits a freeware browser game), driven by INTERACTION (poke/press/drag), and the sound CHANGES per slime TYPE. READ the real files at ${REPO} first: input.ts, controls.ts, main.ts, index.html, camera.ts (for poke), mls-mpm/mls-mpm.ts (setPointerForce / MAX_INJECT_V context). PURE JS/Web Audio — DO NOT touch the sim, shaders, or render.

CURRENT INTERACTION (the audio hooks):
- input.ts InputController owns canvas pointer events. 1-finger (or left-mouse) = POKE; 2-finger = orbit/pinch. While a poke pointer is held, each frame update() does camera.poke()->sim.setPointerForce(); there is a PRESS-DURATION ramp (press in [0,1], ramps over ~0.5-1.0s the longer held) feeding pointerForce (quick tap = dent, long press = flatten). onDown/onMove/onUp lifecycle; drag has per-frame pointer deltas (speed). So input.ts KNOWS, CPU-side: poke start (onDown), press strength (the ramp 0..1), drag speed (|delta|/frame), and release (onUp). Hook the audio here — NO GPU readback needed.
- controls.ts holds the 6 TYPE PRESETS (Clear/Glossy/Butter/Cloud/Floam/Jelly) and applyPreset()/bindSliders(); selecting a type calls setMaterial/setStyle. index.html has the Slime Lab panel + #controls (Reset blob + Show particles). main.ts constructs InputController(canvas, camera, sim) + Controls(sim, renderer) + ViewCube.
- The game runs on desktop + mobile (iPhone Safari 26). Browsers BLOCK audio until a user gesture: AudioContext starts 'suspended' and must be resume()d inside a real user gesture (the first pointerdown). iOS is strict.

MANDATED IMPLEMENTATION:
1. audio.ts NEW — class SlimeAudio:
   - Owns a single AudioContext (lazy-created), a master GainNode, and a small voice/node setup. unlock(): create+resume the context inside a user gesture; safe to call repeatedly (no-op once running). setMuted(bool) / toggleMuted(): ramp master gain (avoid clicks). All envelopes use setTargetAtTime/linearRampToValueAtTime so there are NO clicks/pops from the envelope itself.
   - PROCEDURAL SYNTHESIS (no files): a 'pop' = a short filtered-noise/impulse burst with a fast decay env (BufferSource of white noise OR an oscillator ping through a bandpass + gain env); a 'squelch' = filtered noise with a swept band-pass (wet sound) while dragging/pressing; a 'crackle' = a stream of randomly-timed tiny pops (Poisson-ish), used for Floam/crunchy. Provide working Web Audio code. Pool/limit voices so rapid pokes don't pile up (cap concurrent voices, e.g. <=8).
   - PER-TYPE PROFILES keyed by type name: each profile sets the pop pitch/decay/filter, squelch wetness/cutoff, crackle density, overall timbre. Concrete params per type: Clear/Glossy = wet big bubble pops (lower-mid, juicy); Butter = soft muted squish (low-pass, short); Cloud = airy/fizzy soft crackle (high, light); Floam = sharp dense crackle (bright, many small pops — the ASMR one); Jelly = gummy bouncy (mid, slightly pitched). setType(typeName) switches the active profile.
   - API for the interaction layer: onPokeStart(strength), onPress(press01, dragSpeed), onPokeEnd(), and setType(name), unlock(), setMuted(b). Keep it cheap (called per frame for onPress — throttle internally; don't spawn a voice every frame, e.g. schedule crackle pops at a rate, not per-frame).
2. input.ts — call the audio hooks: unlock() on the first pointerdown; onPokeStart when a poke begins; onPress(press, dragSpeed) while poking (throttled in audio.ts); onPokeEnd on release. Pass press strength (the existing ramp) + drag speed. Do NOT change the poke physics.
3. controls.ts — on type select (applyPreset), call audio.setType(typeName). 
4. index.html + controls.ts — a MUTE toggle button (🔊/🔇) in the panel (#controls or the Slime Lab panel); default UNMUTED but audio stays silent until the first gesture anyway. Touch-friendly.
5. main.ts — construct SlimeAudio; pass it to InputController + Controls; wire the mute button.

CONSTRAINTS: No sim/shader/render changes. Audio must be SILENT when idle (only sounds during interaction). No clicks (ramp envelopes). Mobile audio-unlock correct (resume inside the gesture). Cap voices (no runaway). Mute works + persists for the session. Don't break poke/orbit/ViewCube/SlimeLab. tsc-clean. NOTE: this is NOT headless-validatable (Web Audio needs a real context + human ears) — so be conservative + correct; the user verifies the actual sound. Make per-type differences clearly audible.

DELIVERABLE: COMPLETE contents for: audio.ts (new), input.ts, controls.ts, index.html, main.ts. Do NOT change the shaders, mls-mpm.ts, fluidRender.ts, fluid.wgsl, camera.ts, viewcube.ts.
`

const DESIGN_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  area: { type: 'string' }, repo_findings: { type: 'string' }, design: { type: 'string' },
  code: { type: 'string', description: 'working TS/Web-Audio for this area' }, pitfalls: { type: 'string' },
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
  apply_notes: { type: 'string' }, type_profiles: { type: 'string', description: 'the per-type audio profile params' },
  residual_risks: { type: 'string' }, verify_steps: { type: 'string', description: 'what the user should listen for (per type) on desktop + phone' },
}, required: ['files','apply_notes','type_profiles','verify_steps'] }

phase('Design')
const areas = [
  { key: 'synthesis-profiles', desc: 'The procedural synthesis (pop/squelch/crackle via Web Audio noise buffers, oscillators, biquad filters, gain envelopes) + the concrete per-type profile parameters for Clear/Glossy/Butter/Cloud/Floam/Jelly. Research procedural bubble/pop/ASMR-slime sound synthesis + click-free Web Audio envelopes. CITE. Provide working node-graph code.' },
  { key: 'audio-engine', desc: 'The SlimeAudio class architecture: AudioContext lifecycle + iOS/mobile UNLOCK (resume inside gesture), master gain + mute (click-free ramp), voice pooling/limit, per-frame throttling (schedule crackle at a rate, never a voice per frame), and a clean API (unlock/setType/onPokeStart/onPress/onPokeEnd/setMuted). Handle no-WebAudio gracefully.' },
  { key: 'interaction-wiring', desc: 'Wiring into input.ts (unlock on first pointerdown; onPokeStart/onPress(press,dragSpeed)/onPokeEnd — without changing poke physics), controls.ts (setType on preset select), the MUTE button in index.html + controls.ts, and main.ts construction/wiring. Map press strength + drag speed to loudness/intensity sensibly.' },
]
const designs = (await parallel(areas.map(a => () =>
  agent(`${CONTEXT}\n\nYOU ARE DESIGN AGENT '${a.key}'. Focus: ${a.desc}\n\nREAD the real repo files. For synthesis-profiles use WebSearch/WebFetch (ToolSearch "select:WebSearch,WebFetch") and CITE. Produce WORKING code (fill schema), exact about the Web Audio graph + mobile unlock + per-type params.`,
    { label: `design:${a.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Designs: ${designs.length}/3. Reconciling.`)
phase('Reconcile')
const reconciled = await agent(
  `${CONTEXT}\n\nRECONCILER. Designs (JSON):\n\n${JSON.stringify(designs, null, 2)}\n\nREAD the real repo files. Produce ONE coherent implementation as fenced blocks headed '=== FILE: <repo-relative-path> ===' for: audio.ts, input.ts, controls.ts, index.html, main.ts. Ensure: AudioContext unlocks on first gesture; silent when idle; click-free; voices capped; per-frame onPress throttled; mute works; setType switches profile on preset select; tsc-clean; poke/orbit/ViewCube/SlimeLab intact. List decisions + the per-type profile table.`,
  { label: 'reconcile', phase: 'Reconcile', effort: 'high' })

phase('Verify')
const lenses = [
  { key: 'web-audio', focus: "WEB AUDIO CORRECTNESS. Verify: AudioContext is created + resume()d INSIDE a user gesture (works on iOS Safari); envelopes use ramps (no clicks/zipper noise); no node leaks (one-shot voices disconnect/stop after their envelope; nodes aren't accumulated); voice cap enforced; works (degrades gracefully) if AudioContext is unavailable; master gain mute is click-free + correct; sample-accurate scheduling uses ctx.currentTime not setTimeout where it matters; no per-frame node creation storm." },
  { key: 'interaction-audio', focus: "INTERACTION WIRING. Verify: onPokeStart fires once per poke (not every frame); onPress is throttled so crackle is scheduled at a rate (not a voice/frame); onPokeEnd fires on release/cancel; unlock() on first pointerdown; press strength + drag speed map to loudness sensibly; idle = silence; switching type changes the sound; mute persists; it does NOT alter poke physics or fire during 2-finger orbit / ViewCube drag (only on actual pokes)." },
  { key: 'integration', focus: "INTEGRATION + TS. Verify tsc-clean (types, null-safety on AudioContext); DOM ids for the mute button match between index.html and controls.ts; SlimeAudio is constructed once and shared; no change to the shaders/mls-mpm.ts/render/camera/viewcube; main.ts frame loop + input/controls still work; the mute button is touch-friendly + doesn't overlap panels; no console errors on load before first gesture." },
]
const verdicts = (await parallel(lenses.map(l => () =>
  agent(`${CONTEXT}\n\nADVERSARIAL REVIEWER. Lens: ${l.focus}\n\nImplementation:\n\n${reconciled}\n\nREAD the real repo files. Concrete bugs (file+expression, exact fix). Skeptical; no rubber-stamp. If correct, verdict 'ship' empty bugs.`,
    { label: `verify:${l.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high' })
))).filter(Boolean)

log(`Verify: ${verdicts.flatMap(v=>(v.bugs||[]).filter(b=>b.severity!=='minor')).length} blocker/major. Finalizing.`)
phase('Finalize')
const final = await agent(
  `${CONTEXT}\n\nFINALISER. Reconciled:\n\n${reconciled}\n\nVerdicts (JSON), incorporate every blocker/major + clear minors:\n\n${JSON.stringify(verdicts, null, 2)}\n\nProduce FINAL complete contents for audio.ts, input.ts, controls.ts, index.html, main.ts ready to write verbatim. Re-verify: gesture-unlock, click-free, voice-capped, throttled, mute, per-type distinct, tsc-clean, nothing else touched. Fill the schema incl type_profiles + verify_steps (what to listen for per type, desktop + phone).`,
  { label: 'finalize', phase: 'Finalize', effort: 'high' })
return final