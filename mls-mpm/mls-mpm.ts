import clearGrid from './clearGrid.wgsl';
import p2g_1 from './p2g_1.wgsl';
import p2g_2 from './p2g_2.wgsl';
import updateGrid from './updateGrid.wgsl';
import g2p from './g2p.wgsl';
import copyPosition from './copyPosition.wgsl'
import pointerForce from './pointerForce.wgsl'

import { numParticlesMax, renderUniformsViews } from '../common';

// Particle struct (std layout): position vec3f@0(16) + v vec3f@16(16)
// + C mat3x3f@32(48) + F mat3x3f@80(48) = 128 bytes.
export const mlsmpmParticleStructSize = 128

export class MLSMPMSimulator {
    max_x_grids = 64;
    max_y_grids = 64;
    max_z_grids = 64;
    cellStructSize = 16;
    realBoxSizeBuffer: GPUBuffer
    initBoxSizeBuffer: GPUBuffer
    numParticles = 0
    gridCount = 0

    clearGridPipeline: GPUComputePipeline
    p2g1Pipeline: GPUComputePipeline
    p2g2Pipeline: GPUComputePipeline
    updateGridPipeline: GPUComputePipeline
    g2pPipeline: GPUComputePipeline
    copyPositionPipeline: GPUComputePipeline
    pointerForcePipeline: GPUComputePipeline

    clearGridBindGroup: GPUBindGroup
    p2g1BindGroup: GPUBindGroup
    p2g2BindGroup: GPUBindGroup
    updateGridBindGroup: GPUBindGroup
    g2pBindGroup: GPUBindGroup
    copyPositionBindGroup: GPUBindGroup
    pointerForceBindGroup: GPUBindGroup

    particleBuffer: GPUBuffer
    pointerUniformBuffer: GPUBuffer

    // Runtime material uniform (32B, std140):
    //   { mu@0, lambda@4, viscosity@8, gravity@12, plasticity@16, _pad@20/24/28 }.
    // Bound at binding 3 of BOTH p2g_2 and updateGrid AND (new) binding 4 of g2p
    // (g2p reads .plasticity for the SVD return-mapping yield), so sliders / type
    // presets take effect live without recreating any pipeline. setMaterial() writes it.
    // The struct grew 16->32B because std140 rounds a struct with a vec-free tail up
    // to 16B alignment; 5 active f32 + 3 pad = 32B, the next 16B multiple.
    materialUniformBuffer: GPUBuffer
    private materialValues = new ArrayBuffer(32)
    // [mu, lambda, viscosity, gravity, plasticity, pad, pad, pad]
    private materialView = new Float32Array(this.materialValues)

    // Validated default material (Glossy baseline params: viscosity 0.6,
    // gravity -0.3 are the headless-validated values; mu/lambda 3/6 = M1 defaults).
    static readonly DEFAULT_MU = 3.0
    static readonly DEFAULT_LAMBDA = 6.0
    static readonly DEFAULT_VISCOSITY = 0.6
    static readonly DEFAULT_GRAVITY = -0.3
    // plasticity 0 = fully elastic (snaps back, original M1 behavior — the g2p
    // SVD clamp window opens so wide nothing is ever clamped); 1 = very plastic
    // (tight yield -> reshapes & holds). Default 0 preserves the validated baseline.
    static readonly DEFAULT_PLASTICITY = 0.0

    // CPU-side scratch for the 48-byte pointer uniform (see writePointerUniform).
    private pointerUniformValues = new ArrayBuffer(48)
    private pointerViews = {
        ray_origin: new Float32Array(this.pointerUniformValues, 0, 3),
        radius:     new Float32Array(this.pointerUniformValues, 12, 1),
        ray_dir:    new Float32Array(this.pointerUniformValues, 16, 3),
        press:      new Float32Array(this.pointerUniformValues, 28, 1), // 0..1 sustained-press ramp
        force:      new Float32Array(this.pointerUniformValues, 32, 3),
        active:     new Float32Array(this.pointerUniformValues, 44, 1),
    }

    // Bound on injected per-particle delta-v. Two limits apply: (1) the P2G atomics
    // (fixed_point_multiplier=1e6 over i32 => +/-~2147 magnitude/channel before silent
    // overflow), and — the binding one — (2) ELASTIC STABILITY: a coherent injection
    // across the poke radius raises the velocity gradient C, and F=(I+dt*C)*F can run
    // away. Headless poke tests blew up at sustained |v|=4 and are stable at 1.5, so we
    // cap here; pointerForce.wgsl also hard-clamps post-injection speed as a safety net.
    static readonly MAX_INJECT_V = 1.5

    device: GPUDevice

    renderDiameter: number

    constructor (particleBuffer: GPUBuffer, posvelBuffer: GPUBuffer, renderDiameter: number, device: GPUDevice) 
    {
        this.device = device
        this.renderDiameter = renderDiameter
        const clearGridModule = device.createShaderModule({ code: clearGrid });
        const p2g1Module = device.createShaderModule({ code: p2g_1 });
        const p2g2Module = device.createShaderModule({ code: p2g_2 });
        const updateGridModule = device.createShaderModule({ code: updateGrid });
        const g2pModule = device.createShaderModule({ code: g2p });
        const copyPositionModule = device.createShaderModule({ code: copyPosition });
        const pointerForceModule = device.createShaderModule({ code: pointerForce });

        const constants = {
            // Newtonian leftovers (stiffness/restDensity) are no longer used by the
            // elastic p2g_2, kept here only for reference / possible fluid presets.
            stiffness: 3.,
            restDensity: 4.,
            // NOTE: dynamic_viscosity / elastic_mu / elastic_lambda are NO LONGER
            // pipeline overrides — they now live in the runtime Material uniform
            // (binding 3) so sliders/presets change them live. See setMaterial().
            dt: 0.10,  // halved from 0.20: explicit viscosity (visc*dt) and elastic
                       // CFL (sqrt(stiffness)*dt) are only conditionally stable, and the
                       // full slider range (visc up to 1.5, mu/lambda up to 6/12) blew up
                       // at dt=0.20. Paired with 4 substeps below so animation speed is
                       // unchanged (0.10*4 == 0.20*2 sim-time/frame). Headless-validated
                       // stable across every slider corner at this dt.
            fixed_point_multiplier: 1e6,  // lowered from 1e7: elastic stresses are
                                          // larger -> +/-2147 headroom (vs +/-214.7 at
                                          // 1e7); still ~6 digits precision. Drop to
                                          // 1e5 only if you crank mu/lambda way up.
            p_vol: 1.0,               // constant per-particle material volume
        }

        this.clearGridPipeline = device.createComputePipeline({
            label: "clear grid pipeline", 
            layout: 'auto', 
            compute: {
                module: clearGridModule, 
            }
        })
        this.p2g1Pipeline = device.createComputePipeline({
            label: "p2g 1 pipeline", 
            layout: 'auto', 
            compute: {
                module: p2g1Module, 
                constants: {
                    'fixed_point_multiplier': constants.fixed_point_multiplier
                }, 
            }
        })
        this.p2g2Pipeline = device.createComputePipeline({
            label: "p2g 2 pipeline", 
            layout: 'auto', 
            compute: {
                module: p2g2Module,
                constants: {
                    // mu/lambda/viscosity moved to the Material uniform (binding 3).
                    'fixed_point_multiplier': constants.fixed_point_multiplier,
                    'dt': constants.dt,
                    'p_vol': constants.p_vol,
                },
            }
        })
        this.updateGridPipeline = device.createComputePipeline({
            label: "update grid pipeline", 
            layout: 'auto', 
            compute: {
                module: updateGridModule, 
                constants: {
                    'fixed_point_multiplier': constants.fixed_point_multiplier, 
                    'dt': constants.dt, 
                }, 
            }
        });
        this.g2pPipeline = device.createComputePipeline({
            label: "g2p pipeline", 
            layout: 'auto', 
            compute: {
                module: g2pModule, 
                constants: {
                    'fixed_point_multiplier': constants.fixed_point_multiplier, 
                    'dt': constants.dt, 
                }, 
            }
        });
        this.copyPositionPipeline = device.createComputePipeline({
            label: "copy position pipeline",
            layout: 'auto',
            compute: {
                module: copyPositionModule,
            }
        });
        // M2 poke pass — independent of the 6 validated pipelines above.
        this.pointerForcePipeline = device.createComputePipeline({
            label: "pointer force pipeline",
            layout: 'auto',
            compute: {
                module: pointerForceModule,
            }
        });

        const maxGridCount = this.max_x_grids * this.max_y_grids * this.max_z_grids;
        const realBoxSizeValues = new ArrayBuffer(12);
        const initBoxSizeValues = new ArrayBuffer(12);

        const cellBuffer = device.createBuffer({ 
            label: 'cells buffer', 
            size: this.cellStructSize * maxGridCount,  
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        this.realBoxSizeBuffer = device.createBuffer({
            label: 'real box size buffer', 
            size: realBoxSizeValues.byteLength, 
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.initBoxSizeBuffer = device.createBuffer({
            label: 'init box size buffer', 
            size: initBoxSizeValues.byteLength, 
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(this.initBoxSizeBuffer, 0, initBoxSizeValues);
        device.queue.writeBuffer(this.realBoxSizeBuffer, 0, realBoxSizeValues);

        // 32-byte runtime Material uniform. Initialized to validated defaults.
        this.materialUniformBuffer = device.createBuffer({
            label: 'material uniform buffer',
            size: this.materialValues.byteLength, // 32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.setMaterial(
            MLSMPMSimulator.DEFAULT_MU,
            MLSMPMSimulator.DEFAULT_LAMBDA,
            MLSMPMSimulator.DEFAULT_VISCOSITY,
            MLSMPMSimulator.DEFAULT_GRAVITY,
            MLSMPMSimulator.DEFAULT_PLASTICITY,
        )

        // 48-byte pointer uniform (ray_origin, radius, ray_dir, press, force, active).
        this.pointerUniformBuffer = device.createBuffer({
            label: 'pointer force uniform buffer',
            size: this.pointerUniformValues.byteLength, // 48
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        // start inactive
        this.pointerViews.active[0] = 0
        device.queue.writeBuffer(this.pointerUniformBuffer, 0, this.pointerUniformValues)

        // BindGroup
        this.clearGridBindGroup = device.createBindGroup({
            layout: this.clearGridPipeline.getBindGroupLayout(0), 
            entries: [
              { binding: 0, resource: { buffer: cellBuffer }}, 
            ],  
        })
        this.p2g1BindGroup = device.createBindGroup({
            layout: this.p2g1Pipeline.getBindGroupLayout(0), 
            entries: [
                { binding: 0, resource: { buffer: particleBuffer }}, 
                { binding: 1, resource: { buffer: cellBuffer }}, 
                { binding: 2, resource: { buffer: this.initBoxSizeBuffer }}, 
            ],  
        })
        this.p2g2BindGroup = device.createBindGroup({
            layout: this.p2g2Pipeline.getBindGroupLayout(0), 
            entries: [
                { binding: 0, resource: { buffer: particleBuffer }}, 
                { binding: 1, resource: { buffer: cellBuffer }}, 
                { binding: 2, resource: { buffer: this.initBoxSizeBuffer }}, 
                { binding: 3, resource: { buffer: this.materialUniformBuffer }}, 
            ]
        })
        this.updateGridBindGroup = device.createBindGroup({
            layout: this.updateGridPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cellBuffer }},
                { binding: 1, resource: { buffer: this.realBoxSizeBuffer }},
                { binding: 2, resource: { buffer: this.initBoxSizeBuffer }},
                { binding: 3, resource: { buffer: this.materialUniformBuffer }},
            ],
        })
        this.g2pBindGroup = device.createBindGroup({
            layout: this.g2pPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: particleBuffer }},
                { binding: 1, resource: { buffer: cellBuffer }},
                { binding: 2, resource: { buffer: this.realBoxSizeBuffer }},
                { binding: 3, resource: { buffer: this.initBoxSizeBuffer }},
                // NEW: g2p reads .plasticity here for the SVD return-mapping. Bound at
                // binding 4 (the first free index after g2p's existing 0..3) — SAME
                // materialUniformBuffer that p2g_2 / updateGrid bind at their binding 3.
                { binding: 4, resource: { buffer: this.materialUniformBuffer }},
            ],
        })
        this.copyPositionBindGroup = device.createBindGroup({
            layout: this.copyPositionPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: particleBuffer }},
                { binding: 1, resource: { buffer: posvelBuffer }},
            ]
        })
        this.pointerForceBindGroup = device.createBindGroup({
            layout: this.pointerForcePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: particleBuffer }},
                { binding: 1, resource: { buffer: this.pointerUniformBuffer }},
            ]
        })

        this.particleBuffer = particleBuffer
    }

    initDambreak(initBoxSize: number[], numParticles: number) {
        let particlesBuf = new ArrayBuffer(mlsmpmParticleStructSize * numParticlesMax);
        const spacing = 0.65;

        this.numParticles = 0;
        
        for (let j = 0; j < initBoxSize[1] * 0.80 && this.numParticles < numParticles; j += spacing) {
            for (let i = 3; i < initBoxSize[0] - 4 && this.numParticles < numParticles; i += spacing) {
                for (let k = 3; k < initBoxSize[2] / 2 && this.numParticles < numParticles; k += spacing) {
                    const offset = mlsmpmParticleStructSize * this.numParticles;
                    const particleViews = {
                        position: new Float32Array(particlesBuf, offset + 0, 3),
                        v: new Float32Array(particlesBuf, offset + 16, 3),
                        C: new Float32Array(particlesBuf, offset + 32, 12),
                        F: new Float32Array(particlesBuf, offset + 80, 12),
                    };
                    const jitter = 2.0 * Math.random();
                    particleViews.position.set([i + jitter, j + jitter, k + jitter]);
                    // F = identity (column-major, each column padded to vec4 in std layout):
                    // floats 0..2 = col0, 4..6 = col1, 8..10 = col2.
                    particleViews.F.set([1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0]);
                    this.numParticles++;
                }
            }
        }
        
        let particles = new ArrayBuffer(mlsmpmParticleStructSize * this.numParticles);
        const oldView = new Uint8Array(particlesBuf);
        const newView = new Uint8Array(particles);
        newView.set(oldView.subarray(0, newView.length));
        
        return particles;
    }

    reset(numParticles: number, initBoxSize: number[]) {
        renderUniformsViews.sphere_size.set([this.renderDiameter])
        const particleData = this.initDambreak(initBoxSize, numParticles);
        const maxGridCount = this.max_x_grids * this.max_y_grids * this.max_z_grids;
        this.gridCount = Math.ceil(initBoxSize[0]) * Math.ceil(initBoxSize[1]) * Math.ceil(initBoxSize[2]);
        if (this.gridCount > maxGridCount) {
            throw new Error("gridCount should be equal to or less than maxGridCount")
        }
        const realBoxSizeValues = new ArrayBuffer(12);
        const realBoxSizeViews = new Float32Array(realBoxSizeValues);
        const initBoxSizeValues = new ArrayBuffer(12);
        const initBoxSizeViews = new Float32Array(initBoxSizeValues);
        initBoxSizeViews.set(initBoxSize);    
        realBoxSizeViews.set(initBoxSize); 
        this.device.queue.writeBuffer(this.initBoxSizeBuffer, 0, initBoxSizeValues);
        this.device.queue.writeBuffer(this.realBoxSizeBuffer, 0, realBoxSizeValues);
        this.device.queue.writeBuffer(this.particleBuffer, 0, particleData)
        // Re-assert the default material on reset so a blob reset starts from the
        // validated baseline (the Controls panel re-pushes the active preset after).
        this.setMaterial(
            MLSMPMSimulator.DEFAULT_MU,
            MLSMPMSimulator.DEFAULT_LAMBDA,
            MLSMPMSimulator.DEFAULT_VISCOSITY,
            MLSMPMSimulator.DEFAULT_GRAVITY,
            MLSMPMSimulator.DEFAULT_PLASTICITY,
        )
        console.log(this.numParticles)
    }

    // Write the 32B runtime Material uniform. Values are clamped to the validated
    // stable regime so a slider/preset can never feed F into a blow-up:
    //   mu in [1,6], lambda in [2,12], viscosity in [0.1,1.5], gravity in [-0.6,0],
    //   plasticity in [0,1] (0 = fully elastic/snap-back; 1 = very plastic/holds shape).
    // `plasticity` is OPTIONAL so any older caller (and headless harness writing only
    // 4 floats) keeps working at full-elastic; it defaults to the elastic baseline.
    setMaterial(
        mu: number, lambda: number, viscosity: number, gravity: number,
        plasticity: number = MLSMPMSimulator.DEFAULT_PLASTICITY,
    ) {
        const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
        this.materialView[0] = clamp(mu, 1.0, 6.0)
        this.materialView[1] = clamp(lambda, 2.0, 12.0)
        this.materialView[2] = clamp(viscosity, 0.1, 1.5)
        this.materialView[3] = clamp(gravity, -0.6, 0.0)
        this.materialView[4] = clamp(plasticity, 0.0, 1.0)
        // [5],[6],[7] are std140 tail padding — leave 0.
        this.device.queue.writeBuffer(this.materialUniformBuffer, 0, this.materialValues)
    }

    execute(commandEncoder: GPUCommandEncoder) {
        const computePass = commandEncoder.beginComputePass();
        // 4 substeps at dt=0.10 (was 2 at 0.20) — same sim-time/frame, 2x finer steps
        // for stability across the full material-slider range. ~2x sim compute.
        for (let i = 0; i < 4; i++) {
            computePass.setBindGroup(0, this.clearGridBindGroup);
            computePass.setPipeline(this.clearGridPipeline);
            computePass.dispatchWorkgroups(Math.ceil(this.gridCount / 64)) // これは gridCount だよな？
            computePass.setBindGroup(0, this.p2g1BindGroup)
            computePass.setPipeline(this.p2g1Pipeline)
            computePass.dispatchWorkgroups(Math.ceil(this.numParticles / 64))
            computePass.setBindGroup(0, this.p2g2BindGroup)
            computePass.setPipeline(this.p2g2Pipeline)
            computePass.dispatchWorkgroups(Math.ceil(this.numParticles / 64)) 
            computePass.setBindGroup(0, this.updateGridBindGroup)
            computePass.setPipeline(this.updateGridPipeline)
            computePass.dispatchWorkgroups(Math.ceil(this.gridCount / 64)) 
            computePass.setBindGroup(0, this.g2pBindGroup)
            computePass.setPipeline(this.g2pPipeline)
            computePass.dispatchWorkgroups(Math.ceil(this.numParticles / 64)) 
            computePass.setBindGroup(0, this.copyPositionBindGroup)
            computePass.setPipeline(this.copyPositionPipeline)
            computePass.dispatchWorkgroups(Math.ceil(this.numParticles / 64))             
        }
        computePass.end()
    }

    // Write the pointer uniform. `force` is the world-space per-frame delta-v to add
    // to nearby particles; we CLAMP its magnitude to MAX_INJECT_V so we never feed
    // the 1e6 fixed-point atomics past their ~+/-2147 ceiling (p2g sums per cell).
    // `press` in [0,1] is the sustained-press ramp (0 = quick tap -> just a dent;
    // 1 = long hold -> pointerForce.wgsl adds radial-outward + downward spread so the
    // blob flattens). The shader-side spread velocities are also bounded by its
    // internal |v|<=4 cap, so press never breaks elastic stability.
    setPointerForce(
        rayOrigin: number[], rayDir: number[], force: number[],
        radius: number, active: boolean, press: number = 0
    ) {
        // normalize ray_dir defensively (the WGSL distance-to-ray math assumes |D|=1)
        let dx = rayDir[0], dy = rayDir[1], dz = rayDir[2]
        const dl = Math.hypot(dx, dy, dz) || 1
        dx /= dl; dy /= dl; dz /= dl

        // clamp injected delta-v magnitude
        let fx = force[0], fy = force[1], fz = force[2]
        const fl = Math.hypot(fx, fy, fz)
        const cap = MLSMPMSimulator.MAX_INJECT_V
        if (fl > cap) { const s = cap / fl; fx *= s; fy *= s; fz *= s }

        this.pointerViews.ray_origin.set([rayOrigin[0], rayOrigin[1], rayOrigin[2]])
        this.pointerViews.radius[0] = radius
        this.pointerViews.ray_dir.set([dx, dy, dz])
        this.pointerViews.press[0] = Math.min(1, Math.max(0, press)) // 0..1 ramp
        this.pointerViews.force.set([fx, fy, fz])
        this.pointerViews.active[0] = active ? 1.0 : 0.0

        this.device.queue.writeBuffer(this.pointerUniformBuffer, 0, this.pointerUniformValues)
    }

    // Dispatch the poke pass ONCE per frame. Call right after execute(). It is a
    // separate compute pass so the 6 validated passes stay byte-untouched. When the
    // uniform's `active` is 0 the shader early-returns, so this is cheap when idle.
    applyPointerForce(commandEncoder: GPUCommandEncoder) {
        const pass = commandEncoder.beginComputePass()
        pass.setBindGroup(0, this.pointerForceBindGroup)
        pass.setPipeline(this.pointerForcePipeline)
        pass.dispatchWorkgroups(Math.ceil(this.numParticles / 64))
        pass.end()
    }

    changeBoxSize(realBoxSize: number[]) {
        const realBoxSizeValues = new ArrayBuffer(12);
        const realBoxSizeViews = new Float32Array(realBoxSizeValues);
        realBoxSizeViews.set(realBoxSize)
        this.device.queue.writeBuffer(this.realBoxSizeBuffer, 0, realBoxSizeViews)
    }
}
