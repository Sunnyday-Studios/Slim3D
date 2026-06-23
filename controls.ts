// ============================================================================
// controls.ts — Slim3D "Slime Lab" control panel.
//
// Owns the DOM controls in #slimeLab (declared in index.html). Wires:
//   TYPE  -> sim.setMaterial(preset.physics) + renderer.setStyle(preset.style)
//   COLOR -> renderer.setStyle (swatches + <input type=color>)
//   FINISH (gloss) / SQUISH (mu) / STRETCH (lambda) / FLOW (viscosity) /
//   GRAVITY sliders -> sim.setMaterial / renderer.setStyle
//   FOAM (checkbox + amount) -> renderer.setStyle
//
// The panel is plain DOM, SEPARATE from the canvas, so interacting with it does
// NOT trigger the canvas poke (InputController only listens on the canvas).
// Slider ranges are kept inside the validated-stable regime; mls-mpm.setMaterial
// and fluidRender.setStyle also clamp defensively.
// ============================================================================

import { MLSMPMSimulator } from './mls-mpm/mls-mpm'
import { FluidRenderer } from './render/fluidRender'

export type Physics = { mu: number; lambda: number; viscosity: number; gravity: number; plasticity: number }
export type Style = { color: [number, number, number]; gloss: number; opacity: number; foam: number }
export type Preset = { name: string; physics: Physics; style: Style }

// hex "#rrggbb" -> [r,g,b] in 0..1
function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}
// [r,g,b] 0..1 -> "#rrggbb"
function rgb01ToHex(c: [number, number, number]): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`
}

// --- The 6 researched TYPE presets (Sloomoo glossary + Peachybbies/Dope Slimes).
//     All params are inside the stability-safe regime (mu<=6, lambda<=12,
//     viscosity 0.1..1.5, gravity -0.6..0, plasticity 0..1). ---
//
// plasticity guide: 0 = pure-elastic snap-back (original M1 feel), 1 = play-doh that
// holds any reshape. Snappy/glossy slimes (Clear/Glossy/Jelly) keep it LOW so they
// still bounce back; Butter & Cloud are deformable/spreadable so they hold a press;
// Floam sits mid (beads give it some structure but it still smooshes).
export const PRESETS: Preset[] = [
  {
    name: 'Clear',
    physics: { mu: 2.0, lambda: 5.0, viscosity: 0.9, gravity: -0.35, plasticity: 0.15 },
    style: { color: hexToRgb01('#1A8CD9'), gloss: 1.0, opacity: 0.25, foam: 0.0 },
  },
  {
    name: 'Glossy',
    physics: { mu: 4.0, lambda: 8.0, viscosity: 0.6, gravity: -0.30, plasticity: 0.10 },
    style: { color: hexToRgb01('#F24C8C'), gloss: 0.95, opacity: 0.85, foam: 0.0 },
  },
  {
    name: 'Butter',
    physics: { mu: 3.0, lambda: 4.0, viscosity: 1.2, gravity: -0.25, plasticity: 0.75 },
    style: { color: hexToRgb01('#F7DB8C'), gloss: 0.15, opacity: 0.95, foam: 0.0 },
  },
  {
    name: 'Cloud',
    physics: { mu: 2.5, lambda: 5.0, viscosity: 0.7, gravity: -0.45, plasticity: 0.65 },
    style: { color: hexToRgb01('#D9CCEB'), gloss: 0.35, opacity: 0.90, foam: 0.25 },
  },
  {
    name: 'Floam',
    physics: { mu: 3.5, lambda: 7.0, viscosity: 0.8, gravity: -0.30, plasticity: 0.40 },
    style: { color: hexToRgb01('#59D9A6'), gloss: 0.50, opacity: 0.60, foam: 0.90 },
  },
  {
    name: 'Jelly',
    physics: { mu: 3.5, lambda: 9.0, viscosity: 0.5, gravity: -0.30, plasticity: 0.20 },
    style: { color: hexToRgb01('#F27333'), gloss: 0.85, opacity: 0.55, foam: 0.0 },
  },
]

// Researched popular slime color swatches (real commercial palette anchors).
const SWATCHES: string[] = [
  '#9FE6C8', // floam mint
  '#FF8FB1', // bubblegum pink
  '#CFEFFF', // clear cyan
  '#F4D63A', // lemon butter
  '#C9B6F2', // lavender cloud
  '#68EA34', // neon slime green
  '#B58CD6', // taro purple
  '#F27333', // amber jelly
  '#1A1A1A', // obsidian black
  '#FFFFFF', // classic white
]

const DEFAULT_PRESET_INDEX = 1 // Glossy (validated default visc/gravity)

export class Controls {
  private sim: MLSMPMSimulator
  private renderer: FluidRenderer

  // live working copies (so a color/finish/foam tweak doesn't clobber the rest)
  private phys: Physics = { ...PRESETS[DEFAULT_PRESET_INDEX].physics }
  private style: Style = {
    color: [...PRESETS[DEFAULT_PRESET_INDEX].style.color] as [number, number, number],
    gloss: PRESETS[DEFAULT_PRESET_INDEX].style.gloss,
    opacity: PRESETS[DEFAULT_PRESET_INDEX].style.opacity,
    foam: PRESETS[DEFAULT_PRESET_INDEX].style.foam,
  }

  // DOM refs
  private typeButtons: HTMLButtonElement[] = []
  private muEl!: HTMLInputElement
  private lambdaEl!: HTMLInputElement
  private flowEl!: HTMLInputElement
  private gravityEl!: HTMLInputElement
  private plasticityEl!: HTMLInputElement
  private glossEl!: HTMLInputElement
  private colorEl!: HTMLInputElement
  private foamChkEl!: HTMLInputElement
  private foamAmtEl!: HTMLInputElement

  constructor(sim: MLSMPMSimulator, renderer: FluidRenderer) {
    this.sim = sim
    this.renderer = renderer
    this.buildTypeButtons()
    this.buildSwatches()
    this.bindSliders()
    this.bindColor()
    this.bindFoam()
    this.bindToggle()
    // apply default type on load
    this.applyPreset(DEFAULT_PRESET_INDEX)
  }

  // ---- TYPE segmented buttons ----
  private buildTypeButtons() {
    const host = document.getElementById('slType') as HTMLDivElement
    host.innerHTML = ''
    PRESETS.forEach((p, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = p.name
      b.dataset.idx = String(i)
      b.addEventListener('click', () => this.applyPreset(i))
      this.typeButtons.push(b)
      host.appendChild(b)
    })
  }

  private buildSwatches() {
    const host = document.getElementById('slSwatches') as HTMLDivElement
    host.innerHTML = ''
    SWATCHES.forEach((hex) => {
      const s = document.createElement('button')
      s.type = 'button'
      s.className = 'sl-swatch'
      s.style.background = hex
      s.title = hex
      s.addEventListener('click', () => {
        const rgb = hexToRgb01(hex)
        this.style.color = rgb
        this.colorEl.value = hex
        this.pushStyle()
      })
      host.appendChild(s)
    })
  }

  private bindSliders() {
    this.muEl = document.getElementById('slMu') as HTMLInputElement
    this.lambdaEl = document.getElementById('slLambda') as HTMLInputElement
    this.flowEl = document.getElementById('slFlow') as HTMLInputElement
    this.gravityEl = document.getElementById('slGravity') as HTMLInputElement
    this.plasticityEl = document.getElementById('slPlasticity') as HTMLInputElement
    this.glossEl = document.getElementById('slGloss') as HTMLInputElement

    this.muEl.addEventListener('input', () => { this.phys.mu = parseFloat(this.muEl.value); this.pushMaterial() })
    this.lambdaEl.addEventListener('input', () => { this.phys.lambda = parseFloat(this.lambdaEl.value); this.pushMaterial() })
    this.flowEl.addEventListener('input', () => { this.phys.viscosity = parseFloat(this.flowEl.value); this.pushMaterial() })
    this.gravityEl.addEventListener('input', () => { this.phys.gravity = parseFloat(this.gravityEl.value); this.pushMaterial() })
    this.plasticityEl.addEventListener('input', () => { this.phys.plasticity = parseFloat(this.plasticityEl.value); this.pushMaterial() })
    this.glossEl.addEventListener('input', () => { this.style.gloss = parseFloat(this.glossEl.value); this.pushStyle() })
  }

  private bindColor() {
    this.colorEl = document.getElementById('slColor') as HTMLInputElement
    this.colorEl.addEventListener('input', () => {
      this.style.color = hexToRgb01(this.colorEl.value)
      this.pushStyle()
    })
  }

  private bindFoam() {
    this.foamChkEl = document.getElementById('slFoamOn') as HTMLInputElement
    this.foamAmtEl = document.getElementById('slFoamAmt') as HTMLInputElement
    const apply = () => {
      this.style.foam = this.foamChkEl.checked ? parseFloat(this.foamAmtEl.value) : 0.0
      this.foamAmtEl.disabled = !this.foamChkEl.checked
      this.pushStyle()
    }
    this.foamChkEl.addEventListener('change', apply)
    this.foamAmtEl.addEventListener('input', apply)
  }

  private bindToggle() {
    const toggle = document.getElementById('slToggle') as HTMLButtonElement
    const body = document.getElementById('slBody') as HTMLDivElement
    toggle.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed')
      toggle.setAttribute('aria-expanded', String(!collapsed))
    })
  }

  // ---- apply a TYPE preset: physics + style + sync all slider/control positions ----
  private applyPreset(idx: number) {
    const p = PRESETS[idx]
    this.phys = { ...p.physics }
    this.style = {
      color: [...p.style.color] as [number, number, number],
      gloss: p.style.gloss,
      opacity: p.style.opacity,
      foam: p.style.foam,
    }

    // reflect active button
    this.typeButtons.forEach((b, i) => b.classList.toggle('active', i === idx))

    // push slider DOM positions to match the preset
    this.muEl.value = String(this.phys.mu)
    this.lambdaEl.value = String(this.phys.lambda)
    this.flowEl.value = String(this.phys.viscosity)
    this.gravityEl.value = String(this.phys.gravity)
    this.plasticityEl.value = String(this.phys.plasticity)
    this.glossEl.value = String(this.style.gloss)
    this.colorEl.value = rgb01ToHex(this.style.color)
    this.foamChkEl.checked = this.style.foam > 0
    this.foamAmtEl.value = String(this.style.foam > 0 ? this.style.foam : 0.5)
    this.foamAmtEl.disabled = !this.foamChkEl.checked

    this.pushMaterial()
    this.pushStyle()
  }

  private pushMaterial() {
    this.sim.setMaterial(this.phys.mu, this.phys.lambda, this.phys.viscosity, this.phys.gravity, this.phys.plasticity)
  }
  private pushStyle() {
    this.renderer.setStyle(this.style.color, this.style.gloss, this.style.opacity, this.style.foam)
  }

  // Re-assert the active material+style (e.g. after a blob reset, which the
  // simulator re-defaults). Called by main.ts after resetBlob().
  reapply() {
    this.pushMaterial()
    this.pushStyle()
  }
}
