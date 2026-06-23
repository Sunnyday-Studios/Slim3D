@group(0) @binding(0) var texture_sampler: sampler;
@group(0) @binding(1) var texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: RenderUniforms;
@group(0) @binding(3) var thickness_texture: texture_2d<f32>;
@group(0) @binding(4) var envmap_texture: texture_cube<f32>;
@group(0) @binding(5) var<uniform> style: SlimeStyle;

struct RenderUniforms {
    texel_size: vec2f, 
    sphere_size: f32, 
    inv_projection_matrix: mat4x4f, 
    projection_matrix: mat4x4f, 
    view_matrix: mat4x4f, 
    inv_view_matrix: mat4x4f, 
}

// Runtime slime look (32B, std140). Must match fluidRender.ts styleViews:
//   color   : vec3f @0   (base diffuse / tint hue)
//   gloss   : f32   @12  (0 = matte butter, 1 = glassy clear: specular + Fresnel strength)
//   opacity : f32   @16  (Beer-Lambert tint depth: 0 = translucent jelly, 1 = opaque)
//   foam    : f32   @20  (0 = off, >0 = white surface speckle amount)
//   _pad0   : f32   @24
//   _pad1   : f32   @28
struct SlimeStyle {
    color: vec3f,
    gloss: f32,
    opacity: f32,
    foam: f32,
    _pad0: f32,
    _pad1: f32,
}

struct FragmentInput {
    @location(0) uv: vec2f, 
    @location(1) iuv: vec2f, 
}

fn computeViewPosFromUVDepth(tex_coord: vec2f, depth: f32) -> vec3f {
    var ndc: vec4f = vec4f(tex_coord.x * 2.0 - 1.0, 1.0 - 2.0 * tex_coord.y, 0.0, 1.0);
    // なんかこれで合う
    ndc.z = -uniforms.projection_matrix[2].z + uniforms.projection_matrix[3].z / depth;
    ndc.w = 1.0;

    var eye_pos: vec4f = uniforms.inv_projection_matrix * ndc;

    return eye_pos.xyz / eye_pos.w;
}

fn getViewPosFromTexCoord(tex_coord: vec2f, iuv: vec2f) -> vec3f {
    var depth: f32 = abs(textureLoad(texture, vec2u(iuv), 0).x);
    return computeViewPosFromUVDepth(tex_coord, depth);
}

// --- cheap value-noise hash for procedural foam/bead speckle (pure shading) ---
fn hash21(p: vec2f) -> f32 {
    var q = fract(p * vec2f(123.34, 345.45));
    q += dot(q, q + 34.345);
    return fract(q.x * q.y);
}

@fragment
fn fs(input: FragmentInput) -> @location(0) vec4f {
    var depth: f32 = abs(textureLoad(texture, vec2u(input.iuv), 0).r);

    let bgColor: vec3f = vec3f(0.8, 0.8, 0.8);

    if (depth >= 1e4 || depth <= 0.) {
        return vec4f(bgColor, 1.);
    }

    var viewPos: vec3f = computeViewPosFromUVDepth(input.uv, depth); // z は負

    var ddx: vec3f = getViewPosFromTexCoord(input.uv + vec2f(uniforms.texel_size.x, 0.), input.iuv + vec2f(1.0, 0.0)) - viewPos; 
    var ddy: vec3f = getViewPosFromTexCoord(input.uv + vec2f(0., uniforms.texel_size.y), input.iuv + vec2f(0.0, 1.0)) - viewPos; 
    var ddx2: vec3f = viewPos - getViewPosFromTexCoord(input.uv + vec2f(-uniforms.texel_size.x, 0.), input.iuv + vec2f(-1.0, 0.0));
    var ddy2: vec3f = viewPos - getViewPosFromTexCoord(input.uv + vec2f(0., -uniforms.texel_size.y), input.iuv + vec2f(0.0, -1.0));

    if (abs(ddx.z) > abs(ddx2.z)) {
        ddx = ddx2; 
    }
    if (abs(ddy.z) > abs(ddy2.z)) {
        ddy = ddy2;
    }

    var normal: vec3f = -normalize(cross(ddx, ddy)); 
    var rayDir = normalize(viewPos);
    var lightDir = normalize((uniforms.view_matrix * vec4f(0, 0, -1, 0.)).xyz);
    var H: vec3f        = normalize(lightDir - rayDir);
    var specular: f32   = pow(max(0.0, dot(H, normal)), 250.);

    // --- Beer-Lambert tint, now scaled by style.opacity (translucent <-> opaque) ---
    // density was a fixed 1.5; opacity 0..1 maps to ~0 (clear) .. 3 (opaque) so a
    // low-opacity jelly lets the cubemap/refraction read through, high opacity buries it.
    // (opacity=0.5 reproduces the original density=1.5 look.)
    var density = 3.0 * style.opacity;

    var thickness = textureLoad(thickness_texture, vec2u(input.iuv), 0).r;
    var diffuseColor = style.color;
    var transmittance: vec3f = exp(-density * thickness * (1.0 - diffuseColor)); 
    var refractionColor: vec3f = bgColor * transmittance;

    // Fresnel, modulated by gloss: low gloss flattens the rim reflection (matte
    // butter), high gloss gives the full glassy Fresnel pop.
    let F0 = 0.02;
    var fresnelRaw: f32 = clamp(F0 + (1.0 - F0) * pow(1.0 - dot(normal, -rayDir), 5.0), 0., 1.0);
    var fresnel: f32 = fresnelRaw * style.gloss;

    var reflectionDir: vec3f = reflect(rayDir, normal);
    var reflectionDirWorld: vec3f = (uniforms.inv_view_matrix * vec4f(reflectionDir, 0.0)).xyz;
    var reflectionColor: vec3f = textureSampleLevel(envmap_texture, texture_sampler, reflectionDirWorld, 0.).rgb; 

    // Specular highlight scaled by gloss (matte kills the wet hotspot).
    var finalColor = style.gloss * specular + mix(refractionColor, reflectionColor, fresnel);

    // --- FOAM / bead speckle (pure shading, no geometry). foam=0 => no effect. ---
    if (style.foam > 0.0) {
        // World-space anchor so speckle "sticks" to the surface as the blob moves:
        // reconstruct world pos from the view-space hit, quantize to a bead grid.
        let worldPos: vec3f = (uniforms.inv_view_matrix * vec4f(viewPos, 1.0)).xyz;
        // foam amount widens coverage AND raises bead frequency a touch.
        let cell: vec2f = floor(worldPos.xy * 3.0) + floor(vec2f(worldPos.z * 3.0, worldPos.z * 1.7));
        let n: f32 = hash21(cell);
        // threshold: higher foam => lower threshold => more beads visible.
        let thresh: f32 = 1.0 - clamp(style.foam, 0.0, 1.0) * 0.9;
        if (n > thresh) {
            // sub-cell roundness so beads read as dots, not full cells.
            let f: vec2f = fract(worldPos.xy * 3.0) - 0.5;
            let r: f32 = 1.0 - smoothstep(0.18, 0.34, length(f));
            let beadColor: vec3f = vec3f(0.98, 0.98, 1.0); // foam-bead white
            // mix toward white where a bead sits; beads get their own wider highlight.
            finalColor = mix(finalColor, beadColor, r * clamp(style.foam, 0.0, 1.0));
            let beadSpec: f32 = pow(max(0.0, dot(H, normal)), 32.0);
            finalColor += vec3f(beadSpec) * r * 0.5;
        }
    }

    return vec4f(finalColor, 1.0);

    // return vec4f(viewPos.y * 100, 0, 0, 1.0);

    // 法線
    // return vec4f(0.5 * normal + 0.5, 1.);
    // 法線の y 成分    
    // return vec4f(vec3f(normal.x, 0, 0), 1);
    // return vec4f(vec3f(normal.y, 0, 0), 1);
    // return vec4f(vec3f(normal.z, 0, 0), 1);
    // specular だけ
    // return vec4f(vec3f(specular), 1);
    // reflection だけ
    // return vec4f(reflectionColor, 1.);
    // return vec4f(fresnel, 0., 0., 1.);
}
