// pointerForce.wgsl — M2 interactive poke pass (NOT one of the 6 validated M1 shaders).
//
// Injects a bounded world-space velocity into particles near the pointer ray.
// Runs ONCE per frame, as its own compute pass, AFTER the MLS-MPM substep loop
// (so the injected v is scattered through p2g next frame and actually moves mass,
// and is not clobbered until next frame's g2p re-zeroes v).
//
// Two modes layered in one pass, blended by `press` in [0,1] (the CPU ramps it up
// the longer a finger is held — see input.ts):
//   QUICK TAP  (press~0): just the inward push along the ray -> a centered DENT,
//                         falloff over the small contact radius `radius`.
//   LONG PRESS (press->1): a BROAD DOWNWARD PLATEN. Instead of a narrow disc around
//                         the ray, the press footprint is a wide VERTICAL COLUMN on
//                         the floor under the finger (radius = radius*PRESS_RADIUS_SCALE,
//                         sized to cover at least ~half the blob). Across that column
//                         particles are pushed DOWN (world -Y) with a near-UNIFORM
//                         "plateau" profile — full strength over the inner disc, tapered
//                         only at the rim. A uniform, low-gradient push pancakes the whole
//                         region together. (The OLD press used a narrow disc with a strong
//                         RADIAL-OUTWARD shove + a center-peaked down push, which evacuated
//                         the center and TORE the blob into pieces — exactly what this
//                         replaces.) A small rim-only outward nudge relieves the lip.
// With plasticity ON (g2p return-mapping) the flattened shape PERSISTS after release.
//
// Struct MUST be byte-identical to g2p.wgsl's Particle (128 B) so the storage
// binding aliases the same buffer correctly. We only read .position and write .v.
// The 48 B PointerUniform is UNCHANGED — the broad platen is derived in-shader from
// the existing ray (ray ∩ floor plane), so every CPU writer stays byte-identical.

struct Particle {
    position: vec3f,
    v: vec3f,
    C: mat3x3f,
    F: mat3x3f,
}

// std140 uniform, 48 bytes. Field offsets chosen so vec3 fields stay 16-aligned
// and the trailing scalars ride in the padding lanes (matches the TS writer):
//   ray_origin vec3f @0 , radius f32 @12
//   ray_dir    vec3f @16, press  f32 @28   (0..1 sustained-press ramp; CPU-driven)
//   force      vec3f @32, enabled f32 @44  ('active' is a WGSL reserved word)
struct PointerUniform {
    ray_origin: vec3f,
    radius: f32,
    ray_dir: vec3f,
    press: f32,
    force: vec3f,
    enabled: f32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> pointer: PointerUniform;

// --- Press-flatten tuning (broad platen). All gated by `press` so a quick tap is
// untouched. Tunable; see header for what each shapes. ---
const PRESS_RADIUS_SCALE: f32 = 2.5; // contact radius -> platen radius. With the live
                                     // poke radius (~6) this is ~15 world units, which
                                     // covers >= ~half the ~33x27 blob footprint.
const PRESS_PLATEAU: f32 = 0.6;      // inner fraction of the platen at FULL down strength
                                     // (uniform slab); the outer 1-PRESS_PLATEAU tapers.
const PRESS_DOWN: f32 = 0.6;         // -Y velocity gain at full press (matches the old
                                     // center peak, but now spread across the whole disc).
const PRESS_SPREAD: f32 = 0.25;      // gentle rim-ONLY outward relief (was 0.9 everywhere,
                                     // which is what separated the slime — now tiny + edge).

@compute @workgroup_size(64)
fn pointerForce(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= arrayLength(&particles)) { return; }
    if (pointer.enabled < 0.5) { return; }

    let p: vec3f = particles[id.x].position;

    // Perpendicular distance from particle P to the ray (O, D), D assumed normalized.
    let to_p: vec3f = p - pointer.ray_origin;
    let t: f32 = dot(to_p, pointer.ray_dir);          // projection along the ray
    let closest: vec3f = pointer.ray_origin + t * pointer.ray_dir;
    let radial_vec: vec3f = p - closest;              // points away from the ray axis
    let d: f32 = length(radial_vec);                  // perpendicular distance

    let r: f32 = max(pointer.radius, 1e-4);
    let press: f32 = clamp(pointer.press, 0.0, 1.0);

    // --- PRESS footprint membership (broad horizontal platen). ---
    // Platen center = where the pointer ray meets the FLOOR plane (y=0), so the press
    // is a wide vertical COLUMN under the finger (a true horizontal-plane press),
    // independent of camera tilt. Guard near-horizontal rays by falling back to the
    // ray's closest-approach point (keeps it centered on the contact disc we hit).
    var center_xz: vec2f = closest.xz;
    if (press > 0.001) {
        let dyr: f32 = pointer.ray_dir.y;
        if (dyr < -0.15) {
            let tf: f32 = -pointer.ray_origin.y / dyr;
            center_xz = pointer.ray_origin.xz + tf * pointer.ray_dir.xz;
        }
    }
    let R_press: f32 = r * PRESS_RADIUS_SCALE;
    let dh: f32 = length(p.xz - center_xz);           // horizontal dist from platen axis

    let in_dent: bool = d < r;
    let in_press: bool = (press > 0.001) && (dh < R_press);
    if (!in_dent && !in_press) { return; }            // untouched -> nothing to do

    var dv: vec3f = vec3f(0.0, 0.0, 0.0);

    // (1) DENT: pointer.force is the per-frame world delta-v along the ray (CPU clamps
    // |force| safe vs the 1e6 fixed-point atomic headroom). Smooth falloff (1 at the
    // axis -> 0 at the edge), squared for a rounded shoulder.
    if (in_dent) {
        let x: f32 = 1.0 - d / r;
        let falloff: f32 = x * x * (3.0 - 2.0 * x);   // C1 smoothstep on x in [0,1]
        dv += pointer.force * falloff;
    }

    // (2) PRESS-FLATTEN: broad downward platen. Full-strength -Y over the inner
    // plateau, smooth taper to the rim. Near-uniform => low velocity gradient =>
    // the whole footprint descends as ONE coherent slab (no center evacuation /
    // tearing). A tiny rim-only outward nudge lets the spreading lip flow out clean.
    if (in_press) {
        let down_w: f32 = 1.0 - smoothstep(R_press * PRESS_PLATEAU, R_press, dh);
        dv += vec3f(0.0, -1.0, 0.0) * (PRESS_DOWN * press * down_w);

        if (dh > 1e-4) {
            let rim_w: f32 = smoothstep(R_press * PRESS_PLATEAU, R_press, dh);
            let rdir: vec2f = (p.xz - center_xz) / dh; // unit outward in the floor plane
            let out: vec2f = rdir * (PRESS_SPREAD * press * rim_w);
            dv += vec3f(out.x, 0.0, out.y);
        }
    }

    particles[id.x].v += dv;

    // Hard safety: cap post-injection speed. A vigorous or sustained poke/press
    // injects a coherent velocity across the falloff radius, which raises the
    // velocity gradient C and can drive a runaway F=(I+dt*C)*F deformation-gradient
    // blowup. Capping the speed bounds that feedback. VMAX is well above natural
    // slime speeds (~1-2), so it only ever touches poke/press-accelerated particles.
    let sp: f32 = length(particles[id.x].v);
    let VMAX: f32 = 4.0;
    if (sp > VMAX) { particles[id.x].v = particles[id.x].v * (VMAX / sp); }
}
