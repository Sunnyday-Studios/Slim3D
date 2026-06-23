struct Particle {
    position: vec3f,
    v: vec3f,
    C: mat3x3f,
    F: mat3x3f,
}
struct Cell {
    vx: i32,
    vy: i32,
    vz: i32,
    mass: i32,
}

// Runtime material params (shared 32B layout with p2g_2's + updateGrid's Material).
// g2p reads .plasticity to drive the SVD singular-value return mapping. Layout MUST
// match mls-mpm.ts materialView ([mu, lambda, viscosity, gravity, plasticity, pad*3]).
struct Material {
    mu: f32,          // @0  (unused here)
    lambda: f32,      // @4  (unused here)
    viscosity: f32,   // @8  (unused here)
    gravity: f32,     // @12 (unused here)
    plasticity: f32,  // @16 0 = elastic / snap-back, 1 = very plastic / holds shape
    _pad0: f32,       // @20
    _pad1: f32,       // @24
    _pad2: f32,       // @28 -> 32B, std140-aligned
}

override fixed_point_multiplier: f32;
override dt: f32;

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var<uniform> real_box_size: vec3f;
@group(0) @binding(3) var<uniform> init_box_size: vec3f;
// NEW binding 4 (first free index after g2p's existing 0..3). Same buffer p2g_2 /
// updateGrid bind at their binding 3 — mls-mpm.ts wires it into g2pBindGroup.
@group(0) @binding(4) var<uniform> mat: Material;

fn decodeFixedPoint(fixed_point: i32) -> f32 {
	return f32(fixed_point) / fixed_point_multiplier;
}

// ============================================================================
// 3x3 SVD — Jacobi-eigenvalue method (McAdams et al. 2011, "Computing the SVD
// of 3x3 matrices with minimal branching", as used in taichi/mpm99 and many MPM
// codes). We use the robust scalar-Jacobi variant (no AVX quaternion trick):
//
//   1. Symmetric eigendecomposition of S = A^T A via cyclic Jacobi rotations
//      -> V (orthonormal) and the squared singular values on the diagonal.
//   2. B = A V ; the singular values are the column norms of B, and U is B with
//      each column normalized (U = B * diag(1/sigma)).
//   3. Sign / reflection fix: sort sigma descending, and if det(U)*det(V) < 0
//      (an odd number of reflections), flip the sign of the SMALLEST singular
//      value AND the matching column of U so U,V become proper rotations
//      (det = +1) with a single possibly-negative sigma folded away. Because the
//      return-mapping clamps sigma into a strictly-positive window, the final F
//      reconstruction is well-defined for any input including det(A) <= 0.
//
// WGSL mat3x3f is COLUMN-major: m[c] is column c, m[c][r] is row r of column c.
// ============================================================================

fn det3_local(m: mat3x3f) -> f32 {
    return m[0].x * (m[1].y * m[2].z - m[2].y * m[1].z)
         - m[1].x * (m[0].y * m[2].z - m[2].y * m[0].z)
         + m[2].x * (m[0].y * m[1].z - m[1].y * m[0].z);
}

// One symmetric Jacobi rotation that zeroes the (p,q) off-diagonal of S, applied
// as S <- J^T S J and accumulated into V <- V J. p<q in {0,1,2}. Computes the
// rotation (c,s) from the 2x2 sub-block. Branch on app/aqq via a tolerance.
fn jacobi_rotate(S: ptr<function, mat3x3f>, V: ptr<function, mat3x3f>, p: i32, q: i32) {
    let spq: f32 = (*S)[p][q];
    if (abs(spq) < 1e-20) { return; }  // already (numerically) zero -> skip
    let spp: f32 = (*S)[p][p];
    let sqq: f32 = (*S)[q][q];
    // theta = (sqq - spp) / (2*spq) ; t = sign(theta)/(|theta|+sqrt(theta^2+1))
    let theta: f32 = (sqq - spp) / (2.0 * spq);
    let sgn: f32 = select(-1.0, 1.0, theta >= 0.0);
    let t: f32 = sgn / (abs(theta) + sqrt(theta * theta + 1.0));
    let c: f32 = 1.0 / sqrt(t * t + 1.0);
    let s: f32 = t * c;

    // Apply to the THREE columns of S: S <- J^T S J. Update rows/cols p,q.
    // Work on a copy to avoid read-after-write within the rotation.
    var Sn: mat3x3f = *S;
    // Update columns p and q (each is a vec3 over rows 0..2):
    for (var r = 0; r < 3; r++) {
        let sp = (*S)[p][r];
        let sq = (*S)[q][r];
        Sn[p][r] = c * sp - s * sq;
        Sn[q][r] = s * sp + c * sq;
    }
    // Now update rows p and q of the column-updated matrix (symmetric apply):
    var Sn2: mat3x3f = Sn;
    for (var col = 0; col < 3; col++) {
        let sp = Sn[col][p];
        let sq = Sn[col][q];
        Sn2[col][p] = c * sp - s * sq;
        Sn2[col][q] = s * sp + c * sq;
    }
    *S = Sn2;

    // Accumulate V <- V J (rotate columns p,q of V).
    var Vn: mat3x3f = *V;
    for (var r = 0; r < 3; r++) {
        let vp = (*V)[p][r];
        let vq = (*V)[q][r];
        Vn[p][r] = c * vp - s * vq;
        Vn[q][r] = s * vp + c * vq;
    }
    *V = Vn;
}

// Full signed 3x3 SVD. Returns U,V (orthonormal; folded to det=+1 rotations) and
// sig (vec3f singular values, may carry one negative entry folded from a
// reflection — by construction only sig.z can be negative). A = U * diag(sig) * V^T.
struct SVD { U: mat3x3f, sig: vec3f, V: mat3x3f, }

fn svd3(A: mat3x3f) -> SVD {
    let I3: mat3x3f = mat3x3f(vec3f(1.,0.,0.), vec3f(0.,1.,0.), vec3f(0.,0.,1.));

    // S = A^T A  (symmetric, positive semidefinite).
    var S: mat3x3f = transpose(A) * A;
    var V: mat3x3f = I3;

    // Cyclic Jacobi sweeps. 3x3 symmetric converges fast; ~6 sweeps (18 rotations)
    // drives off-diagonals to ~machine-zero for the magnitudes seen here.
    for (var sweep = 0; sweep < 6; sweep++) {
        jacobi_rotate(&S, &V, 0, 1);
        jacobi_rotate(&S, &V, 0, 2);
        jacobi_rotate(&S, &V, 1, 2);
    }

    // Squared singular values are the diagonal of the (now ~diagonal) S; clamp at
    // 0 against tiny negative round-off before sqrt.
    var sig: vec3f = vec3f(
        sqrt(max(S[0].x, 0.0)),
        sqrt(max(S[1].y, 0.0)),
        sqrt(max(S[2].z, 0.0)),
    );

    // B = A V ; columns of B are sigma_i * u_i. Recover U by normalizing.
    var B: mat3x3f = A * V;

    // ---- sort singular values DESCENDING (sig.x >= sig.y >= sig.z), permuting
    // the matching columns of B and V together. Simple 3-element sort network. ----
    if (sig.x < sig.y) {
        let ts = sig.x; sig.x = sig.y; sig.y = ts;
        let tb = B[0]; B[0] = B[1]; B[1] = tb;
        let tv = V[0]; V[0] = V[1]; V[1] = tv;
    }
    if (sig.y < sig.z) {
        let ts = sig.y; sig.y = sig.z; sig.z = ts;
        let tb = B[1]; B[1] = B[2]; B[2] = tb;
        let tv = V[1]; V[1] = V[2]; V[2] = tv;
    }
    if (sig.x < sig.y) {
        let ts = sig.x; sig.x = sig.y; sig.y = ts;
        let tb = B[0]; B[0] = B[1]; B[1] = tb;
        let tv = V[0]; V[0] = V[1]; V[1] = tv;
    }

    // ---- build U from B columns (B = A V, so column j of B = sig_j * u_j).
    // Normalize each column to recover u_j. For a (near-)zero singular value the
    // direction is undefined, so synthesize an orthonormal basis vector via
    // Gram-Schmidt to keep U a valid orthonormal frame (degeneracy guard -> no
    // NaN). sig stays >= 0 here (it came from a sqrt); the single sign needed to
    // reproduce det(A) is folded in AFTER, below. ----
    var U: mat3x3f = I3;
    let EPS: f32 = 1e-6;
    // column 0
    let n0: f32 = length(B[0]);
    if (n0 > EPS) { U[0] = B[0] / n0; } else { U[0] = vec3f(1., 0., 0.); }
    // column 1: normalize, else pick something orthogonal to U0.
    let n1: f32 = length(B[1]);
    if (n1 > EPS) {
        U[1] = B[1] / n1;
    } else {
        var t: vec3f = vec3f(0., 1., 0.);
        if (abs(U[0].y) > 0.9) { t = vec3f(1., 0., 0.); }
        U[1] = normalize(t - U[0] * dot(t, U[0]));
    }
    // re-orthogonalize U[1] against U[0] to fight Jacobi/round-off drift.
    U[1] = normalize(U[1] - U[0] * dot(U[1], U[0]));
    // column 2: normalize B[2] if it's well-defined AND already roughly orthogonal;
    // otherwise (degenerate / drifted) rebuild it from the cross product. Either way
    // we re-derive its SIGN below so the handedness matches A.
    let n2: f32 = length(B[2]);
    let perp: vec3f = cross(U[0], U[1]);
    if (n2 > EPS) {
        var u2: vec3f = B[2] / n2;
        // project out U0,U1 components (Gram-Schmidt) then renormalize
        u2 = u2 - U[0] * dot(u2, U[0]) - U[1] * dot(u2, U[1]);
        if (length(u2) > EPS) { U[2] = normalize(u2); } else { U[2] = perp; }
    } else {
        U[2] = perp;
    }

    // ---- single reflection fold. U and V are now orthonormal but each may be a
    // reflection (det = -1). All sig are >= 0, so:
    //     sign(det A) = sign(det U) * sign(det V).
    // We want U,V to be PROPER ROTATIONS (det = +1) with at most one negative
    // singular value carrying the reflection. Force det(U)=+1 by flipping U[2] (and
    // negating sig.z, the smallest) if det(U)<0; same for V. After that both are
    // rotations; if the ORIGINAL A was a reflection (det A < 0) fold that one
    // remaining reflection into the smallest singular value (negate sig.z + U[2]).
    if (det3_local(U) < 0.0) { U[2] = -U[2]; sig.z = -sig.z; }
    if (det3_local(V) < 0.0) { V[2] = -V[2]; sig.z = -sig.z; }
    if (det3_local(A) < 0.0) { U[2] = -U[2]; sig.z = -sig.z; }

    return SVD(U, sig, V);
}

// Reconstruct a 3x3 from U * diag(s) * V^T (column-major).
fn reconstruct(U: mat3x3f, s: vec3f, V: mat3x3f) -> mat3x3f {
    // U * diag(s): scale each column j of U by s[j].
    let US: mat3x3f = mat3x3f(U[0] * s.x, U[1] * s.y, U[2] * s.z);
    return US * transpose(V);
}


@compute @workgroup_size(64)
fn g2p(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < arrayLength(&particles)) {
        particles[id.x].v = vec3f(0.);
        var weights: array<vec3f, 3>;

        let particle = particles[id.x];
        let cell_idx: vec3f = floor(particle.position);
        let cell_diff: vec3f = particle.position - (cell_idx + 0.5f);
        weights[0] = 0.5f * (0.5f - cell_diff) * (0.5f - cell_diff);
        weights[1] = 0.75f - cell_diff * cell_diff;
        weights[2] = 0.5f * (0.5f + cell_diff) * (0.5f + cell_diff);

        var B: mat3x3f = mat3x3f(vec3f(0.), vec3f(0.), vec3f(0.));
        for (var gx = 0; gx < 3; gx++) {
            for (var gy = 0; gy < 3; gy++) {
                for (var gz = 0; gz < 3; gz++) {
                    let weight: f32 = weights[gx].x * weights[gy].y * weights[gz].z;
                    let cell_x: vec3f = vec3f(
                        cell_idx.x + f32(gx) - 1.,
                        cell_idx.y + f32(gy) - 1.,
                        cell_idx.z + f32(gz) - 1.
                    );
                    let cell_dist: vec3f = (cell_x + 0.5f) - particle.position;
                    let cell_index: i32 =
                        i32(cell_x.x) * i32(init_box_size.y) * i32(init_box_size.z) +
                        i32(cell_x.y) * i32(init_box_size.z) +
                        i32(cell_x.z);
                    let weighted_velocity: vec3f = vec3f(
                        decodeFixedPoint(cells[cell_index].vx),
                        decodeFixedPoint(cells[cell_index].vy),
                        decodeFixedPoint(cells[cell_index].vz)
                    ) * weight;
                    let term: mat3x3f = mat3x3f(
                        weighted_velocity * cell_dist.x,
                        weighted_velocity * cell_dist.y,
                        weighted_velocity * cell_dist.z
                    );

                    B += term;

                    particles[id.x].v += weighted_velocity;
                }
            }
        }

        let newC: mat3x3f = B * 4.0f;
        particles[id.x].C = newC;

        // ---- Deformation gradient update: F_new = (I + dt*C) * F ----
        // (left-multiply the OLD F by the incremental velocity-gradient map.)
        let I3: mat3x3f = mat3x3f(vec3f(1.,0.,0.), vec3f(0.,1.,0.), vec3f(0.,0.,1.));
        var F_new: mat3x3f = (I3 + dt * newC) * particle.F;

        // ---- PLASTICITY: singular-value return mapping (the elastoplastic /
        // play-doh model). SVD(F)=U diag(sig) V^T; clamp each singular value into a
        // yield window [1-theta_c, 1+theta_s]; reconstruct F from the CLAMPED
        // singular values. Whatever was clamped away is the PERMANENT (plastic)
        // part — it does NOT spring back, so a squished shape HOLDS. This also
        // BOUNDS F (stability): no singular value can exceed 1+theta_s or fall
        // below 1-theta_c, so F=(I+dt*C)*F can't run away under sustained press.
        //
        // plasticity p in [0,1] maps to the yield window:
        //   p=0  -> window so wide nothing is ever clamped -> identical to the
        //           original pure-elastic snap-back (validated M1 behavior).
        //   p=1  -> tight window (~+/-2.5% compression / 0.75% stretch) -> yields
        //           almost immediately -> reshapes & holds like play-doh.
        // theta_c (compression slack, sig<1) is larger than theta_s (stretch slack,
        // sig>1): slimes squish-and-hold more readily than they permanently stretch.
        let p: f32 = clamp(mat.plasticity, 0.0, 1.0);
        // Map plasticity -> yield half-widths. The window must actually CLAMP the
        // singular values seen in practice: a firm poke drives sigma to ~0.7..1.3
        // (|F-I| ~ 0.3), so the engaged window has to be WELL under 0.3 to bite.
        // p == 0 is the special "pure elastic" case (handled by the if below: the
        // SVD is skipped entirely, so F is bit-for-bit the elastic update -> exact
        // snap-back, the validated M1 behavior). For p in (0,1] we map to a USEFUL
        // clamping window that starts moderately loose and tightens to play-doh:
        //   theta_c(p) = mix(THC_LOOSE, THC_TIGHT, p)   (compression slack, sig<1)
        //   theta_s(p) = mix(THS_LOOSE, THS_TIGHT, p)   (stretch slack,     sig>1)
        // p->0+  : theta_c ~0.22 (only a hard press leaves a faint set).
        // p~0.4  : theta_c ~0.14 (Floam: smooshes & mostly holds).
        // p~0.75 : theta_c ~0.07 (Butter: moldable, holds a press).
        // p=1    : theta_c ~0.025 (play-doh: yields almost immediately).
        // theta_c (compression) > theta_s (stretch): slimes squish-and-hold far more
        // readily than they take a permanent STRETCH (matches real slime/clay).
        let THC_LOOSE: f32 = 0.25;  let THC_TIGHT: f32 = 0.025;
        let THS_LOOSE: f32 = 0.18;  let THS_TIGHT: f32 = 0.0075;
        let theta_c: f32 = mix(THC_LOOSE, THC_TIGHT, p);  // compression yield (1-theta_c)
        let theta_s: f32 = mix(THS_LOOSE, THS_TIGHT, p);  // stretch yield     (1+theta_s)

        // Only pay for the SVD when plasticity is actually engaged; at p=0 the
        // window is skipped so we keep the cheap elastic path bit-for-bit.
        if (p > 0.0001) {
            let svd: SVD = svd3(F_new);
            let lo: f32 = 1.0 - theta_c;
            let hi: f32 = 1.0 + theta_s;
            let sig_c: vec3f = vec3f(
                clamp(svd.sig.x, lo, hi),
                clamp(svd.sig.y, lo, hi),
                clamp(svd.sig.z, lo, hi),
            );
            F_new = reconstruct(svd.U, sig_c, svd.V);
        }

        // Robustness: if F has inverted (det<=0) or gone non-finite, reset it to
        // identity. This is the ONLY place a bad F can persist frame-to-frame, and
        // it also scrubs any pathological SVD output (NaN comparisons are false, so
        // !(dF > 1e-6) resets on NaN too). det3 is inlined to avoid a cross-file
        // dependency (g2p does not import the p2g_2 helpers).
        let dF: f32 =
              F_new[0].x * (F_new[1].y * F_new[2].z - F_new[2].y * F_new[1].z)
            - F_new[1].x * (F_new[0].y * F_new[2].z - F_new[2].y * F_new[0].z)
            + F_new[2].x * (F_new[0].y * F_new[1].z - F_new[1].y * F_new[0].z);
        if (!(dF > 1e-6)) {   // false for NaN, 0, and negative dets -> reset
            F_new = I3;
        }
        particles[id.x].F = F_new;

        particles[id.x].position += particles[id.x].v * dt;
        particles[id.x].position = vec3f(
            clamp(particles[id.x].position.x, 1., real_box_size.x - 2.),
            clamp(particles[id.x].position.y, 1., real_box_size.y - 2.),
            clamp(particles[id.x].position.z, 1., real_box_size.z - 2.)
        );

        let k = 3.0;
        let wall_stiffness = 0.3;
        let x_n: vec3f = particles[id.x].position + particles[id.x].v * dt * k;
        let wall_min: vec3f = vec3f(3.);
        let wall_max: vec3f = real_box_size - 4.;
        if (x_n.x < wall_min.x) { particles[id.x].v.x += wall_stiffness * (wall_min.x - x_n.x); }
        if (x_n.x > wall_max.x) { particles[id.x].v.x += wall_stiffness * (wall_max.x - x_n.x); }
        if (x_n.y < wall_min.y) { particles[id.x].v.y += wall_stiffness * (wall_min.y - x_n.y); }
        if (x_n.y > wall_max.y) { particles[id.x].v.y += wall_stiffness * (wall_max.y - x_n.y); }
        if (x_n.z < wall_min.z) { particles[id.x].v.z += wall_stiffness * (wall_min.z - x_n.z); }
        if (x_n.z > wall_max.z) { particles[id.x].v.z += wall_stiffness * (wall_max.z - x_n.z); }
    }
}
