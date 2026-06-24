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
//   LONG PRESS (press->1): an EVEN DOWNWARD PLATEN — a flat horizontal disc centered on
//                         the CONTACT POINT (where the cursor ray meets the blob, supplied
//                         by the CPU), radius ~half the blob, pushing particles DOWN
//                         (world -Y) with a near-UNIFORM "plateau" profile (full over the
//                         inner disc, tapered at the rim). Because the footprint is a
//                         horizontal disc about a fixed point, the squish is EVEN and the
//                         SAME at every camera angle. The push is deliberately gentle AND
//                         capped (PRESS_VMAX): a fast push lets particles outrun their grid
//                         neighbours and the blob fragments (MPM only couples via the grid).
//                         A tiny rim-only HORIZONTAL nudge relieves the spreading lip.
// With plasticity ON (g2p return-mapping) the flattened shape PERSISTS after release.
//
// Struct MUST be byte-identical to g2p.wgsl's Particle (128 B) so the storage binding
// aliases the same buffer correctly. We only read .position and write .v. The PointerUniform
// is 64 B: it now also carries the CPU-computed `contact` point (camera.poke's ray∩target
// hit) used as the platen center — keep every CPU writer (mls-mpm.ts + both harnesses) in sync.

struct Particle {
    position: vec3f,
    v: vec3f,
    C: mat3x3f,
    F: mat3x3f,
}

// std140 uniform, 64 bytes. Field offsets chosen so vec3 fields stay 16-aligned
// and the trailing scalars ride in the padding lanes (matches the TS writer):
//   ray_origin vec3f @0 , radius f32 @12
//   ray_dir    vec3f @16, press  f32 @28   (0..1 sustained-press ramp; CPU-driven)
//   force      vec3f @32, enabled f32 @44  ('active' is a WGSL reserved word)
//   contact    vec3f @48, _pad   f32 @60   (world point under the cursor on the blob;
//                                           we use .xz as the horizontal platen center)
struct PointerUniform {
    ray_origin: vec3f,
    radius: f32,
    ray_dir: vec3f,
    press: f32,
    force: vec3f,
    enabled: f32,
    contact: vec3f,
    _pad: f32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> pointer: PointerUniform;

// --- Press-flatten tuning (broad platen). All gated by `press` so a quick tap is
// untouched. Tunable; see header for what each shapes. ---
const PRESS_RADIUS_SCALE: f32 = 2.0; // contact radius -> platen radius. With the live
                                     // poke radius (~6) this is ~12 world units ≈ half the
                                     // ~33x27 blob footprint (a bounded disc, not the whole
                                     // blob), centered under the cursor -> even, local squish.
const PRESS_PLATEAU: f32 = 0.3;      // inner fraction at FULL down strength; the outer 0.7
                                     // tapers. A WIDE taper spreads the velocity gradient
                                     // across the disc instead of a sharp rim boundary —
                                     // a sharp boundary shears the slime and tears it.
const PRESS_DOWN: f32 = 0.3;         // -Y velocity gain at full press. Modest; the real
                                     // anti-tear safeguard is PRESS_VMAX below.
const PRESS_SPREAD: f32 = 0.05;      // gentle rim-ONLY outward relief (was 0.9 everywhere,
                                     // which separated the slime — now tiny + edge only).
const PRESS_VMAX: f32 = 0.9;         // SPEED CAP for press-affected particles. This is the
                                     // key fix for "splits into pieces": fragmentation
                                     // happens when particles outrun their grid neighbours
                                     // (>kernel support) and detach. Holding the whole
                                     // pressed region to a low, near-uniform speed keeps
                                     // relative motion tiny, so it flattens as one piece.
                                     // Well below the global VMAX=4 used for quick pokes.

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

    // --- Footprint membership. ---
    // DENT uses the PERPENDICULAR distance to the ray (`d`) — a round dimple under the
    // cursor. PRESS uses the HORIZONTAL distance to the CONTACT POINT (where the cursor
    // ray meets the blob, supplied by the CPU): a flat, EVEN, circular platen centered
    // under the finger, the SAME at every camera angle. (Earlier tries centered on
    // ray∩floor — tens of units off for a shallow camera — or on the tilted perpendicular
    // cylinder — an elongated, uneven squish. Both are replaced by this.)
    let R_press: f32 = r * PRESS_RADIUS_SCALE;
    let dh: f32 = length(p.xz - pointer.contact.xz);  // horizontal dist from platen center

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

    // (2) PRESS-FLATTEN: even DOWNWARD platen over a horizontal disc around the contact
    // point. Full-strength -Y over the inner plateau, smooth taper to the rim. Uniform
    // => low velocity gradient => the whole disc descends as ONE coherent slab, EVENLY
    // (no center evacuation / tearing, no directional bias). A tiny rim-only HORIZONTAL
    // outward nudge lets the spreading lip flow out clean.
    if (in_press) {
        let down_w: f32 = 1.0 - smoothstep(R_press * PRESS_PLATEAU, R_press, dh);
        dv += vec3f(0.0, -1.0, 0.0) * (PRESS_DOWN * press * down_w);

        // outward in the horizontal plane, away from the platen center.
        let rh: vec2f = p.xz - pointer.contact.xz;
        if (dh > 1e-4) {
            let rim_w: f32 = smoothstep(R_press * PRESS_PLATEAU, R_press, dh);
            let out: vec2f = (rh / dh) * (PRESS_SPREAD * press * rim_w);
            dv += vec3f(out.x, 0.0, out.y);
        }
    }

    particles[id.x].v += dv;

    // Hard safety: cap post-injection speed. A vigorous or sustained poke/press
    // injects a coherent velocity across the falloff radius, which raises the
    // velocity gradient C and can drive a runaway F=(I+dt*C)*F deformation-gradient
    // blowup. Capping the speed bounds that feedback. The global VMAX is well above
    // natural slime speeds (~1-2), so for a quick poke it only touches accelerated
    // particles. For the PRESS we cap MUCH lower (PRESS_VMAX): a sustained broad
    // press would otherwise build enough speed for particles to outrun their grid
    // neighbours and FRAGMENT — the low cap keeps the whole region slow + coherent.
    let sp: f32 = length(particles[id.x].v);
    var vmax: f32 = 4.0;
    if (in_press) { vmax = min(vmax, PRESS_VMAX); }
    if (sp > vmax) { particles[id.x].v = particles[id.x].v * (vmax / sp); }
}
