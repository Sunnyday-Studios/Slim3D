// pointerForce.wgsl — M2 interactive poke pass (NOT one of the 6 validated M1 shaders).
//
// Injects a bounded world-space velocity into particles near the pointer ray.
// Runs ONCE per frame, as its own compute pass, AFTER the MLS-MPM substep loop
// (so the injected v is scattered through p2g next frame and actually moves mass,
// and is not clobbered until next frame's g2p re-zeroes v).
//
// Two modes layered in one pass, blended by `press` in [0,1] (the CPU ramps it up
// the longer a finger is held — see input.ts):
//   QUICK TAP  (press~0): just the inward push along the ray -> a centered DENT.
//   LONG PRESS (press->1): ALSO spread particles RADIALLY OUTWARD (perpendicular to
//                          the ray, away from the closest point on the ray axis) and
//                          push them DOWN (world -Y) -> the blob PANCAKES / flattens.
// With plasticity ON (g2p return-mapping) the flattened shape PERSISTS after release.
//
// Struct MUST be byte-identical to g2p.wgsl's Particle (128 B) so the storage
// binding aliases the same buffer correctly. We only read .position and write .v.

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
    if (d >= r) { return; }

    // Smooth falloff: smoothstep-style (1 at center -> 0 at edge), squared for a
    // softer shoulder so the dent has a rounded profile instead of a hard disc.
    let x: f32 = 1.0 - d / r;        // 1 at axis, 0 at radius
    let falloff: f32 = x * x * (3.0 - 2.0 * x);  // C1 smoothstep on x in [0,1]

    // (1) DENT: pointer.force is already the per-frame world delta-v along the ray
    // (CPU clamps |force| to a safe bound vs the 1e6 fixed-point atomic headroom).
    var dv: vec3f = pointer.force * falloff;

    // (2) PRESS-FLATTEN: only kicks in as the finger is held (press -> 1). Add a
    // RADIAL-OUTWARD component (perpendicular to the ray, away from the axis) so
    // mass spreads sideways, and a DOWNWARD component so the blob pancakes rather
    // than just denting. Both are gated by `press` and the same radial falloff.
    let press: f32 = clamp(pointer.press, 0.0, 1.0);
    if (press > 0.001) {
        // Unit radial direction (guard the axis singularity where d ~ 0).
        var radial_dir: vec3f = vec3f(0.0, 0.0, 0.0);
        if (d > 1e-4) { radial_dir = radial_vec / d; }

        // The outward push is STRONGER toward the rim of the contact disc (where the
        // material wants to flow out) and the down push is stronger at the center
        // (under the finger). Tuned magnitudes stay well inside the |v|<=4 cap.
        let SPREAD: f32 = 0.9;   // radial-outward gain at full press
        let DOWN: f32   = 0.6;   // -Y gain at full press

        // rim weight: 0 at axis, peaks near the edge -> pushes the spreading lip out.
        let rim: f32 = falloff * (1.0 - x);            // ~bump in the mid/outer ring
        dv += radial_dir * (SPREAD * press * (rim + 0.25 * falloff));
        dv += vec3f(0.0, -1.0, 0.0) * (DOWN * press * falloff);
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
