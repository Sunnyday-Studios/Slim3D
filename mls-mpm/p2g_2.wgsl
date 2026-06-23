struct Particle {
    position: vec3f,
    v: vec3f,
    C: mat3x3f,
    F: mat3x3f,
}
struct Cell {
    vx: atomic<i32>,
    vy: atomic<i32>,
    vz: atomic<i32>,
    mass: i32,
}

// Runtime material params (live sliders / type presets). std140 32B.
// Layout MUST match mls-mpm.ts materialView Float32Array
//   ([mu, lambda, viscosity, gravity, plasticity, pad, pad, pad]).
// Shared buffer: p2g_2 + updateGrid bind it at binding 3, g2p at binding 4.
// p2g_2 does NOT read .plasticity (the return-mapping happens in g2p); the field
// is present only so all three shaders agree on the 32B byte layout.
struct Material {
    mu: f32,          // @0  shear modulus
    lambda: f32,      // @4  first Lame parameter
    viscosity: f32,   // @8  viscous damping
    gravity: f32,     // @12 (unused here; shared layout with updateGrid)
    plasticity: f32,  // @16 (unused here; read in g2p for SVD yield)
    _pad0: f32,       // @20
    _pad1: f32,       // @24
    _pad2: f32,       // @28  -> 32B, std140-aligned
}

override fixed_point_multiplier: f32;
override dt: f32;
override p_vol: f32;           // constant per-particle material volume (NOT 1/density)

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(2) var<uniform> init_box_size: vec3f;
@group(0) @binding(3) var<uniform> mat: Material;

fn encodeFixedPoint(floating_point: f32) -> i32 {
	return i32(floating_point * fixed_point_multiplier);
}
fn decodeFixedPoint(fixed_point: i32) -> f32 {
	return f32(fixed_point) / fixed_point_multiplier;
}

// ---- 3x3 helpers (WGSL mat3x3f is COLUMN-major; m[i] is column i) ----

fn det3(m: mat3x3f) -> f32 {
    // columns c0,c1,c2 ; m[c][r]
    return m[0].x * (m[1].y * m[2].z - m[2].y * m[1].z)
         - m[1].x * (m[0].y * m[2].z - m[2].y * m[0].z)
         + m[2].x * (m[0].y * m[1].z - m[1].y * m[0].z);
}

fn inverse3(m: mat3x3f) -> mat3x3f {
    let a = m[0].x; let b = m[1].x; let c = m[2].x; // row 0
    let d = m[0].y; let e = m[1].y; let f = m[2].y; // row 1
    let g = m[0].z; let h = m[1].z; let i = m[2].z; // row 2

    let A =  (e * i - f * h);
    let B = -(d * i - f * g);
    let C =  (d * h - e * g);
    let D = -(b * i - c * h);
    let E =  (a * i - c * g);
    let F = -(a * h - b * g);
    let G =  (b * f - c * e);
    let H = -(a * f - c * d);
    let I =  (a * e - b * d);

    let det = a * A + b * B + c * C;
    let inv_det = 1.0 / det;

    // inverse = (1/det) * adjugate ; adjugate = transpose of cofactor matrix.
    // Build as columns (col j = j-th column of inv).
    return mat3x3f(
        vec3f(A, B, C) * inv_det,   // column 0
        vec3f(D, E, F) * inv_det,   // column 1
        vec3f(G, H, I) * inv_det    // column 2
    );
}

// Iterative (Newton / Higham) polar decomposition of 3x3 F -> rotation R.
// R_{k+1} = 0.5 * (R_k + transpose(inverse(R_k))), R_0 = F.
// For elastic F near identity this converges to ~1e-6 in 3-4 iters; we run a
// fixed small count (no early-out) so all lanes stay in lockstep on the GPU.
fn polar_R(F: mat3x3f) -> mat3x3f {
    var R: mat3x3f = F;
    // Degenerate / inverted guard: if det is ~0 or negative the inverse is
    // unstable; fall back to identity (no elastic rotation this step).
    let d0 = det3(F);
    if (abs(d0) < 1e-6) {
        return mat3x3f(vec3f(1.,0.,0.), vec3f(0.,1.,0.), vec3f(0.,0.,1.));
    }
    for (var k = 0; k < 4; k++) {
        let Rit = transpose(inverse3(R));
        R = 0.5 * (R + Rit);
    }
    return R;
}

@compute @workgroup_size(64)
fn p2g_2(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < arrayLength(&particles)) {
        var weights: array<vec3f, 3>;

        let particle = particles[id.x];
        let cell_idx: vec3f = floor(particle.position);
        let cell_diff: vec3f = particle.position - (cell_idx + 0.5f);
        weights[0] = 0.5f * (0.5f - cell_diff) * (0.5f - cell_diff);
        weights[1] = 0.75f - cell_diff * cell_diff;
        weights[2] = 0.5f * (0.5f + cell_diff) * (0.5f + cell_diff);

        // ---- Fixed-corotated elastic stress (Kirchhoff form) ----
        // tau = 2*mu*(F - R)*transpose(F) + lambda*J*(J-1)*I
        // (Kirchhoff = J * Cauchy ; this absorbs the 1/J vs Cauchy form, so the
        //  repo's "-volume*4*stress*dt" wrapper with a CONSTANT p_vol is correct,
        //  matching mpm99's -4*inv_dx^2*dt*vol*(2*mu*(F-R)*F^T + lambda*(J-1)*J).)
        let F: mat3x3f = particle.F;
        let R: mat3x3f = polar_R(F);
        let J: f32 = det3(F);

        let Ft: mat3x3f = transpose(F);
        let F_minus_R: mat3x3f = F - R;
        // 2*mu*(F-R)*F^T
        var stress: mat3x3f = (2.0 * mat.mu) * (F_minus_R * Ft);
        // + lambda*J*(J-1)*I   (volumetric term; clamp J to avoid NaN from inverted F)
        let Jc: f32 = max(J, 0.1);
        let vol_coeff: f32 = mat.lambda * Jc * (Jc - 1.0);
        stress[0].x += vol_coeff;
        stress[1].y += vol_coeff;
        stress[2].z += vol_coeff;

        // + viscous damping term: viscosity * (C + C^T)
        // (energy loss -> slime sags and settles instead of ringing forever; keep low)
        let dudv: mat3x3f = particle.C;
        let strain: mat3x3f = dudv + transpose(dudv);
        stress += mat.viscosity * strain;

        // Constant material volume (NOT 1/density). Same factor-4 (1/(B-spline
        // 2nd moment)=1/4 with dx=1) and -..*dt as the upstream scatter.
        let volume: f32 = p_vol;
        let eq_16_term0 = -volume * 4 * stress * dt;

        for (var gx = 0; gx < 3; gx++) {
            for (var gy = 0; gy < 3; gy++) {
                for (var gz = 0; gz < 3; gz++) {
                    let weight: f32 = weights[gx].x * weights[gy].y * weights[gz].z;
                    let cell_x: vec3f = vec3f(
                            cell_idx.x + f32(gx) - 1.,
                            cell_idx.y + f32(gy) - 1.,
                            cell_idx.z + f32(gz) - 1.
                        );
                    let cell_dist = (cell_x + 0.5f) - particle.position;
                    let cell_index: i32 =
                        i32(cell_x.x) * i32(init_box_size.y) * i32(init_box_size.z) +
                        i32(cell_x.y) * i32(init_box_size.z) +
                        i32(cell_x.z);
                    let momentum: vec3f = eq_16_term0 * weight * cell_dist;
                    atomicAdd(&cells[cell_index].vx, encodeFixedPoint(momentum.x));
                    atomicAdd(&cells[cell_index].vy, encodeFixedPoint(momentum.y));
                    atomicAdd(&cells[cell_index].vz, encodeFixedPoint(momentum.z));
                }
            }
        }
    }
}
