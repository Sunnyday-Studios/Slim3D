// pointerForce.wgsl — M2 interactive poke pass (NOT one of the 6 validated M1 shaders).
//
// Injects a bounded world-space velocity into particles near the pointer ray.
// Runs ONCE per frame, as its own compute pass, AFTER the 2-substep MLS-MPM loop
// (so the injected v is scattered through p2g next frame and actually moves mass,
// and is not clobbered until next frame's g2p re-zeroes v).
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
//   ray_dir    vec3f @16, strength f32 @28   (strength reserved; force is pre-scaled CPU-side)
//   force      vec3f @32, enabled f32 @44   ('active' is a WGSL reserved word)
struct PointerUniform {
    ray_origin: vec3f,
    radius: f32,
    ray_dir: vec3f,
    strength: f32,
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
    let d: f32 = length(p - closest);                 // perpendicular distance

    let r: f32 = max(pointer.radius, 1e-4);
    if (d >= r) { return; }

    // Smooth falloff: smoothstep-style (1 at center -> 0 at edge), squared for a
    // softer shoulder so the dent has a rounded profile instead of a hard disc.
    let x: f32 = 1.0 - d / r;        // 1 at axis, 0 at radius
    let falloff: f32 = x * x * (3.0 - 2.0 * x);  // C1 smoothstep on x in [0,1]

    // pointer.force is already the per-frame world delta-v (CPU clamps |force| to a
    // safe bound vs the 1e6 fixed-point atomic headroom). Apply scaled by falloff.
    particles[id.x].v += pointer.force * falloff;

    // Hard safety: cap post-injection speed. A vigorous or sustained poke injects a
    // coherent velocity across the falloff radius, which raises the velocity gradient
    // C and can drive a runaway F=(I+dt*C)*F deformation-gradient blowup. Capping the
    // speed bounds that feedback. VMAX is well above natural slime speeds (~1-2), so
    // it only ever touches poke-accelerated particles.
    let sp: f32 = length(particles[id.x].v);
    let VMAX: f32 = 4.0;
    if (sp > VMAX) { particles[id.x].v = particles[id.x].v * (VMAX / sp); }
}
