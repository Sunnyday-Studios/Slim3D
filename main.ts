/// <reference types="@webgpu/types" />
//
// Slim3D — interactive slime blob, MLS-MPM on WebGPU.
// Forked from matsuoka-601/WebGPU-Ocean (MIT) — see LICENSE.upstream / README.md.
//
// Milestone 1 (this file): viscoelastic ("slime") material — per-particle
// deformation gradient F + fixed-corotated elastic stress (polar decomposition,
// no SVD) + viscous damping, replacing the upstream Newtonian model. Pointer-poke
// interaction and plasticity (M1.5) land in later milestones.

import { MLSMPMSimulator } from './mls-mpm/mls-mpm'
import { renderUniformsViews, renderUniformsValues, numParticlesMax } from './common'
import { FluidRenderer } from './render/fluidRender'
import { Camera } from './camera'
import { InputController } from './input'

const statusEl = document.getElementById('status') as HTMLDivElement
function setStatus(msg: string, isError = false) {
  statusEl.textContent = msg
  statusEl.classList.toggle('error', isError)
}

// Particle struct is 128 bytes (position, v, C, F) — see mls-mpm.ts.
const mlsmpmParticleStructSize = 128
// posvel buffer the renderer reads: 2 x vec3f + padding = 32 bytes.
const posvelStructSize = 32

// --- Single-blob configuration (medium preset; safe on integrated GPUs) ---
const NUM_PARTICLES = 70000
const INIT_BOX = [40, 30, 60]
const INIT_DISTANCE = 70
const FOV = (45 * Math.PI) / 180
const RENDER_RADIUS = 0.6
const ZOOM_RATE = 1.5
const RENDER_SCALE = 0.7 // backing-store scale; lower = faster, blurrier

async function init() {
  const canvas = document.getElementById('fluidCanvas') as HTMLCanvasElement

  if (!navigator.gpu) {
    setStatus('WebGPU not available in this browser. Use Chrome/Edge (desktop) or Safari 26+. WebGL2 fallback comes later.', true)
    throw new Error('navigator.gpu missing')
  }
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) {
    setStatus('No WebGPU adapter (GPU blocked or unavailable). Try a different browser / enable hardware acceleration.', true)
    throw new Error('no adapter')
  }
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu') as GPUCanvasContext
  if (!context) throw new Error('no webgpu context')

  canvas.width = Math.floor(RENDER_SCALE * canvas.clientWidth)
  canvas.height = Math.floor(RENDER_SCALE * canvas.clientHeight)

  const presentationFormat = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format: presentationFormat })

  return { canvas, device, presentationFormat, context }
}

async function loadCubemap(device: GPUDevice): Promise<GPUTextureView> {
  // order: [+X, -X, +Y, -Y, +Z, -Z]
  const imgSrcs = [
    'cubemap/posx.png', 'cubemap/negx.png',
    'cubemap/posy.png', 'cubemap/negy.png',
    'cubemap/posz.png', 'cubemap/negz.png',
  ]
  const bitmaps = await Promise.all(
    imgSrcs.map(async (src) => createImageBitmap(await (await fetch(src)).blob()))
  )
  const tex = device.createTexture({
    dimension: '2d',
    size: [bitmaps[0].width, bitmaps[0].height, 6],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  bitmaps.forEach((bm, i) => {
    device.queue.copyExternalImageToTexture(
      { source: bm }, { texture: tex, origin: [0, 0, i] }, [bm.width, bm.height]
    )
  })
  return tex.createView({ dimension: 'cube' })
}

async function main() {
  const { canvas, device, presentationFormat, context } = await init()
  const cubemapView = await loadCubemap(device)

  renderUniformsViews.texel_size.set([1.0 / canvas.width, 1.0 / canvas.height])

  // --- GPU buffers ---
  const particleBuffer = device.createBuffer({
    label: 'particles',
    size: mlsmpmParticleStructSize * numParticlesMax,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const posvelBuffer = device.createBuffer({
    label: 'posvel',
    size: posvelStructSize * numParticlesMax,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const renderUniformBuffer = device.createBuffer({
    label: 'render uniforms',
    size: renderUniformsValues.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const simulator = new MLSMPMSimulator(particleBuffer, posvelBuffer, 2 * RENDER_RADIUS, device)
  const renderer = new FluidRenderer(
    device, canvas, presentationFormat, RENDER_RADIUS, FOV,
    posvelBuffer, renderUniformBuffer, cubemapView
  )
  const camera = new Camera(canvas)
  // M2: unified pointer input (mouse/touch/pen). Owns all canvas pointer events;
  // the camera no longer binds its own listeners. update() pushes the poke force.
  const input = new InputController(canvas, camera, simulator)

  function resetBlob() {
    simulator.reset(NUM_PARTICLES, INIT_BOX)
    camera.reset(canvas, INIT_DISTANCE, [INIT_BOX[0] / 2, INIT_BOX[1] / 4, INIT_BOX[2] / 2], FOV, ZOOM_RATE)
    ;(document.getElementById('count') as HTMLElement).textContent = simulator.numParticles.toLocaleString()
  }
  resetBlob()

  // --- UI ---
  document.getElementById('reset')!.addEventListener('click', resetBlob)
  const showParticles = document.getElementById('showParticles') as HTMLInputElement
  const fpsEl = document.getElementById('fps') as HTMLElement

  device.lost.then((info) => setStatus(`GPU device lost: ${info.reason ?? 'unknown'}`, true))
  setStatus('running — viscoelastic slime (MLS-MPM). If you see black, tick “Show particles”.')

  // --- Loop ---
  let frames = 0
  let lastFpsT = performance.now()
  function frame() {
    // M2: compute the pointer poke and write the pointer uniform BEFORE the sim
    // runs, so this frame's force is live for the next p2g scatter.
    input.update()

    device.queue.writeBuffer(renderUniformBuffer, 0, renderUniformsValues)

    const encoder = device.createCommandEncoder()
    simulator.execute(encoder)
    // Inject the poke once, AFTER the 2-substep loop (keeps the 6 validated
    // shaders byte-untouched; next frame's p2g scatters the kick through the grid).
    simulator.applyPointerForce(encoder)
    renderer.execute(context, encoder, simulator.numParticles, showParticles.checked)
    device.queue.submit([encoder.finish()])

    frames++
    const now = performance.now()
    if (now - lastFpsT >= 500) {
      fpsEl.textContent = String(Math.round((frames * 1000) / (now - lastFpsT)))
      frames = 0
      lastFpsT = now
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

main().catch((e) => {
  console.error(e)
  if (!statusEl.classList.contains('error')) setStatus('Failed to start — see console.', true)
})
