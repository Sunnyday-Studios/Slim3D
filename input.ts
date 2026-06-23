// ============================================================================
// input.ts — unified Pointer-Events input controller for Slim3D M2.
//
// One cross-device path (mouse + touch + pen) via Pointer Events. Owns ALL
// canvas pointer handling.
//
//   Touch:  1 finger  = POKE the slime
//           2 fingers = ORBIT (average of the two fingers' movement)
//                       + PINCH-ZOOM (change in inter-finger distance)
//   Mouse:  LEFT-drag        = POKE
//           RIGHT/MIDDLE-drag = ORBIT
//           wheel             = ZOOM
//   Pen:    treated as a 1-finger touch poke.
//
// Mode is DERIVED from the live pointer Map + button state every down/up, so a
// 1-finger poke can never also orbit. Going 1<->2 fingers (or changing mouse
// buttons) re-baselines so there is no jump. setPointerCapture on down;
// pointercancel/lostpointercapture/pointerup all end the gesture cleanly.
//
// Coordinate mapping is resolution-independent: NDC is computed from
// canvas.getBoundingClientRect() (CSS pixels), so RENDER_SCALE / backing-store
// size never enters the math.
// ============================================================================

import { Camera } from './camera'
import { MLSMPMSimulator } from './mls-mpm/mls-mpm'

// `fresh` is set ONLY in onDown (a genuine new tap). It lets a stationary tap
// dent the slime, while a single finger left over from a 2->1 transition does
// NOT auto-poke until it actually moves. Cleared after first poke activation.
type Pt = { x: number; y: number; type: string; button: number; fresh: boolean }
type Mode = 'none' | 'poke' | 'orbit'

// Tuning
const PINCH_ZOOM_GAIN = 0.03 // pinch-distance px -> zoom units
// Press-ramp: ms of sustained hold to reach full press (1.0). A tap shorter than a
// fraction of this barely spreads (stays a dent); ~0.7s+ of hold flattens. The ramp
// is eased (smoothstep) so the flatten eases in instead of snapping on.
const PRESS_RAMP_MS = 700

export class InputController {
  private canvas: HTMLCanvasElement
  private camera: Camera
  private sim: MLSMPMSimulator

  private pointers = new Map<number, Pt>()
  private mode: Mode = 'none'

  // poke state (CSS-pixel client coords + NDC snapshots)
  private pokeId: number | null = null
  private pokeNdcX = 0
  private pokeNdcY = 0
  private pokeNdcPrevX = 0
  private pokeNdcPrevY = 0
  private pokeActive = false

  // press-duration ramp: timestamp (performance.now) the CURRENT poke became active.
  // The longer a finger is held, the more `press` (0..1) ramps up; press drives the
  // pointerForce spread/flatten. A quick tap releases before the ramp builds, so it
  // stays a small DENT; a sustained hold ramps to 1 and FLATTENS the blob. -1 = no
  // active poke yet (ramp not started).
  private pokeStartMs = -1

  // orbit state (orbitIds = 1 entry for mouse, 2 for two-finger touch)
  private orbitIds: number[] = []
  private orbitPrevCx = 0
  private orbitPrevCy = 0
  private pinchPrevDist = 0

  // gate the idle uniform write: only push the "clear" write once on
  // active->inactive, then stay quiet while idle (saves a per-frame GPU write).
  private prevActive = false

  constructor(canvas: HTMLCanvasElement, camera: Camera, simulator: MLSMPMSimulator) {
    this.canvas = canvas
    this.camera = camera
    this.sim = simulator

    // passive:false so preventDefault is honoured (browsers default wheel/touch
    // listeners to passive, which would silently ignore preventDefault).
    const opts: AddEventListenerOptions = { passive: false }
    canvas.addEventListener('pointerdown', this.onDown, opts)
    canvas.addEventListener('pointermove', this.onMove, opts)
    canvas.addEventListener('pointerup', this.onUp, opts)
    canvas.addEventListener('pointercancel', this.onUp, opts)
    // NOTE: pointerout/pointerleave are deliberately NOT wired. With
    // setPointerCapture active the spec suppresses them mid-drag, but some older
    // iOS WebKit builds emit a stray (bubbling) pointerout for a captured pointer,
    // which would call onUp and kill a live gesture. pointerup + pointercancel +
    // lostpointercapture already cover every legitimate end-of-gesture.
    canvas.addEventListener('lostpointercapture', this.onUp, opts)
    canvas.addEventListener('wheel', this.onWheel, opts)
    canvas.addEventListener('contextmenu', this.onContextMenu, opts)
    // iOS Safari non-standard gesture events — block page pinch-zoom of the doc.
    canvas.addEventListener('gesturestart', this.preventDefaultEv as EventListener, opts)
    canvas.addEventListener('gesturechange', this.preventDefaultEv as EventListener, opts)
  }

  // ---- NDC mapping (resolution-independent: CSS rect, NOT backing store) ----
  private toNDC(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return {
      x: ((clientX - r.left) / r.width) * 2 - 1,
      y: -(((clientY - r.top) / r.height) * 2 - 1), // flip: +y up (clip-space convention)
    }
  }

  private preventDefaultEv = (e: Event) => { e.preventDefault() }
  private onContextMenu = (e: Event) => { e.preventDefault() }

  // ---- pointer lifecycle ----
  private onDown = (e: PointerEvent) => {
    e.preventDefault()
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* invalid/already-up on some iOS builds */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button, fresh: true })
    this.resolveMode()
    this.rebaseline()
  }

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    p.x = e.clientX
    p.y = e.clientY

    if (this.mode === 'poke') {
      if (e.pointerId !== this.pokeId) return
      const ndc = this.toNDC(p.x, p.y)
      this.pokeNdcX = ndc.x
      this.pokeNdcY = ndc.y
      // A finger left over from a 2->1 transition (fresh=false) starts poking the
      // moment it actually moves. A genuine fresh tap is already active.
      this.pokeActive = true
      p.fresh = false
      // NOTE: POKE NEVER moves the camera — this is what stops a 1-finger / left
      // drag from also orbiting.
    } else if (this.mode === 'orbit') {
      if (this.orbitIds.length === 2) {
        // Two-finger touch: orbit by centroid movement + pinch-zoom.
        const a = this.pointers.get(this.orbitIds[0])
        const b = this.pointers.get(this.orbitIds[1])
        if (!a || !b) { this.resolveMode(); this.rebaseline(); return }
        const cx = (a.x + b.x) * 0.5
        const cy = (a.y + b.y) * 0.5
        // ORBIT: average of the two fingers' movement.
        this.camera.orbit(cx - this.orbitPrevCx, cy - this.orbitPrevCy)
        // PINCH ZOOM: change in inter-finger distance. Fingers apart (dist up) ->
        // zoom in -> distance DOWN, hence the negative sign.
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        this.camera.zoomBy(-(dist - this.pinchPrevDist) * PINCH_ZOOM_GAIN)
        this.orbitPrevCx = cx
        this.orbitPrevCy = cy
        this.pinchPrevDist = dist
      } else {
        // Single-pointer mouse orbit (right/middle drag): no pinch.
        const a = this.pointers.get(this.orbitIds[0])
        if (!a) { this.resolveMode(); this.rebaseline(); return }
        this.camera.orbit(a.x - this.orbitPrevCx, a.y - this.orbitPrevCy)
        this.orbitPrevCx = a.x
        this.orbitPrevCy = a.y
      }
    }
  }

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return
    // Mouse multi-button chord: only end when ALL buttons are released. The
    // browser fires a pointerup per button transition with the same pointerId;
    // keep the pointer alive (so e.g. right-orbit survives a left click) until no
    // buttons remain. (pointercancel/lostpointercapture always fall through.)
    if (e.type === 'pointerup' && e.pointerType === 'mouse' && e.buttons !== 0) {
      // update the recorded button so resolveMode() reflects what's still held
      const p = this.pointers.get(e.pointerId)!
      // buttons bitmask: 1=left, 2=right, 4=middle -> pick a representative button
      p.button = (e.buttons & 1) ? 0 : (e.buttons & 2) ? 2 : (e.buttons & 4) ? 1 : -1
      this.resolveMode()
      this.rebaseline()
      return
    }
    try { this.canvas.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    this.pointers.delete(e.pointerId)
    this.resolveMode()
    this.rebaseline()
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    // matches M1 wheel sign: deltaY > 0 -> zoom out (distance grows).
    this.camera.zoom(e.deltaY > 0 ? 1 : -1)
  }

  // ---- mode resolution from the live pointer set ----
  private resolveMode() {
    const ids = [...this.pointers.keys()]
    if (ids.length === 0) {
      this.mode = 'none'; this.pokeId = null; this.orbitIds = []; this.pokeActive = false
      return
    }

    let nTouch = 0
    let mouseButton = -1
    const touchIds: number[] = []
    for (const id of ids) {
      const p = this.pointers.get(id)!
      if (p.type === 'mouse') mouseButton = p.button
      else { nTouch++; touchIds.push(id) }
    }

    if (nTouch >= 2) {
      // Two-finger orbit+pinch. Use the FIRST TWO touch ids; a stray 3rd finger
      // is ignored so the centroid doesn't jitter.
      this.mode = 'orbit'
      this.orbitIds = touchIds.slice(0, 2)
      this.pokeId = null
      this.pokeActive = false
    } else if (nTouch === 1) {
      this.mode = 'poke'
      this.pokeId = touchIds[0]
      this.orbitIds = []
    } else {
      // mouse only
      if (mouseButton === 0) { this.mode = 'poke'; this.pokeId = ids[0]; this.orbitIds = [] }
      else if (mouseButton === 1 || mouseButton === 2) { this.mode = 'orbit'; this.orbitIds = ids; this.pokeId = null; this.pokeActive = false }
      else { this.mode = 'none'; this.pokeId = null; this.orbitIds = []; this.pokeActive = false }
    }
  }

  // ---- re-baseline so finger-count / button changes never cause a jump ----
  private rebaseline() {
    if (this.mode === 'poke' && this.pokeId !== null) {
      const p = this.pointers.get(this.pokeId)!
      const ndc = this.toNDC(p.x, p.y)
      // seed BOTH current and prev to the same point -> first frame has zero drag.
      this.pokeNdcX = ndc.x; this.pokeNdcY = ndc.y
      this.pokeNdcPrevX = ndc.x; this.pokeNdcPrevY = ndc.y
      // Only auto-activate on a GENUINE fresh tap (so a stationary tap still dents).
      // A single finger derived from a 2->1 transition (fresh=false) must NOT poke
      // until it moves (handled in onMove) — otherwise a resting finger left after
      // a pinch immediately dents the slime.
      this.pokeActive = p.fresh
    } else if (this.mode === 'orbit' && this.orbitIds.length === 2) {
      const a = this.pointers.get(this.orbitIds[0])!
      const b = this.pointers.get(this.orbitIds[1])!
      this.orbitPrevCx = (a.x + b.x) * 0.5
      this.orbitPrevCy = (a.y + b.y) * 0.5
      this.pinchPrevDist = Math.hypot(a.x - b.x, a.y - b.y)
      this.pokeActive = false
    } else if (this.mode === 'orbit' && this.orbitIds.length === 1) {
      // Single-pointer mouse orbit: seed the baseline so the first move doesn't
      // jump from a stale (0,0).
      const a = this.pointers.get(this.orbitIds[0])!
      this.orbitPrevCx = a.x
      this.orbitPrevCy = a.y
      this.pokeActive = false
    } else {
      this.pokeActive = false
    }
  }

  // ---- per-frame: compute & push the poke force (call BEFORE sim.execute) ----
  update() {
    if (this.mode === 'poke' && this.pokeActive) {
      // Stamp the press-ramp start on the first active frame of this poke; compute
      // an eased 0..1 ramp from how long the finger has been held. A quick tap
      // releases before the ramp builds -> press stays low -> just a dent. A
      // sustained hold ramps to 1 -> pointerForce adds radial-out + down -> flatten.
      const now = performance.now()
      if (this.pokeStartMs < 0) this.pokeStartMs = now
      const held = now - this.pokeStartMs
      const tRaw = PRESS_RAMP_MS > 0 ? Math.min(1, held / PRESS_RAMP_MS) : 1
      const press = tRaw * tRaw * (3 - 2 * tRaw) // smoothstep ease-in

      const poke = this.camera.poke(this.pokeNdcX, this.pokeNdcY, this.pokeNdcPrevX, this.pokeNdcPrevY)
      this.sim.setPointerForce(poke.origin, poke.dir, poke.force, poke.radius, true, press)
      // advance prev NDC for next frame's drag delta
      this.pokeNdcPrevX = this.pokeNdcX
      this.pokeNdcPrevY = this.pokeNdcY
      this.prevActive = true
    } else {
      // poke ended (or never started) -> reset the press ramp so the next tap
      // starts fresh at press=0.
      this.pokeStartMs = -1
      // Only write the "clear" uniform ONCE on the active->inactive edge; while
      // already idle, skip the per-frame GPU write entirely. The pass still runs
      // each frame but the shader early-returns on active<0.5 (cheap no-op).
      if (this.prevActive) {
        this.sim.setPointerForce([0, 0, 0], [0, 0, 1], [0, 0, 0], 0, false, 0)
        this.prevActive = false
      }
    }
  }

  dispose() {
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onDown)
    c.removeEventListener('pointermove', this.onMove)
    c.removeEventListener('pointerup', this.onUp)
    c.removeEventListener('pointercancel', this.onUp)
    c.removeEventListener('lostpointercapture', this.onUp)
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('contextmenu', this.onContextMenu)
    c.removeEventListener('gesturestart', this.preventDefaultEv as EventListener)
    c.removeEventListener('gesturechange', this.preventDefaultEv as EventListener)
  }
}
