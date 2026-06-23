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

    // CPU-side scratch for the 48-byte pointer uniform (see writePointerUniform).
    private pointerUniformValues = new ArrayBuffer(48)
    private pointerViews = {
        ray_origin: new Float32Array(this.pointerUniformValues, 0, 3),
        radius:     new Float32Array(this.pointerUniformValues, 12, 1),
        ray_dir:    new Float32Array(this.pointerUniformValues, 16, 3),
        strength:   new Float32Array(this.pointerUniformValues, 28, 1),
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
            dynamic_viscosity: 0.6,   // viscous damping -> slime sags/settles (low)
            dt: 0.20,
            fixed_point_multiplier: 1e6,  // lowered from 1e7: elastic stresses are
                                          // larger -> +/-2147 headroom (vs +/-214.7 at
                                          // 1e7); still ~6 digits precision. Drop to
                                          // 1e5 only if you crank mu/lambda way up.
            // Fixed-corotated slime: stretchy/saggy/snappy, not stiff jelly.
            elastic_mu: 3.0,          // shear modulus
            elastic_lambda: 6.0,      // first Lame (bulk-ish)
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
                    'fixed_point_multiplier': constants.fixed_point_multiplier,
                    'dynamic_viscosity': constants.dynamic_viscosity,
                    'dt': constants.dt,
                    'elastic_mu': constants.elastic_mu,
                    'elastic_lambda': constants.elastic_lambda,
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

        // 48-byte pointer uniform (ray_origin, radius, ray_dir, strength, force, active).
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
            ]
        })
        this.updateGridBindGroup = device.createBindGroup({
            layout: this.updateGridPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cellBuffer }},
                { binding: 1, resource: { buffer: this.realBoxSizeBuffer }},
                { binding: 2, resource: { buffer: this.initBoxSizeBuffer }},
            ],
        })
        this.g2pBindGroup = device.createBindGroup({
            layout: this.g2pPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: particleBuffer }},
                { binding: 1, resource: { buffer: cellBuffer }},
                { binding: 2, resource: { buffer: this.realBoxSizeBuffer }},
                { binding: 3, resource: { buffer: this.initBoxSizeBuffer }},
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
        console.log(this.numParticles)
    }

    execute(commandEncoder: GPUCommandEncoder) {
        const computePass = commandEncoder.beginComputePass();
        for (let i = 0; i < 2; i++) { 
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
    setPointerForce(
        rayOrigin: number[], rayDir: number[], force: number[],
        radius: number, active: boolean
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
        this.pointerViews.strength[0] = 1.0 // reserved; force is pre-scaled CPU-side
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