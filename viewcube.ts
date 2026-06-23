// ============================================================================
// viewcube.ts — CSS-3D orientation gizmo ("rosette") for Slim3D M4.
//
// A small DOM/CSS cube in a screen corner that MIRRORS the live camera. It is a
// pure overlay: it touches NO WebGPU/sim state and owns its OWN pointer events
// (on its own element) so tapping/dragging it never pokes the slime.
//
//   - MIRROR:  every frame, read camera.getAngles() and set the cube container's
//              CSS transform so the face pointing at the screen matches the view.
//   - TAP:     snap the camera to that face's canonical view (camera.animateTo).
//   - DRAG:    orbit the camera by pointer deltas (camera.orbit) — a reliable
//              touch orbit control that doesn't fight 2-finger orbit on the canvas.
//   - HOME:    a labelled button under the cube resets to the default look.
//
// ----------------------------------------------------------------------------
// DERIVATION OF THE MIRROR TRANSFORM
// ----------------------------------------------------------------------------
// Camera convention (camera.ts recalculateView):
//   M = T(target)·Ry(yaw)·Rx(pitch)·T(0,0,dist)   [right-handed, world Y-up,
//   +Z toward viewer]. The camera's world orientation is Ry(yaw)·Rx(pitch); at
//   yaw=0,pitch=0 the camera looks toward world −Z, so it SEES the world face
//   whose outward normal is +Z.
//
// The cube must render the world axes AS THE CAMERA SEES THEM, i.e. apply the
// world→camera rotation Rx(−pitch)·Ry(−yaw). We place the cube's FRONT face with
// outward normal +Z, so at yaw=0,pitch=0 FRONT faces the viewer (matches "camera
// sees the +Z world face").
//
// CSS 3D differs from the world frame in two ways: (1) CSS Y points DOWN, and
// (2) CSS rotateX/rotateY are clockwise-positive looking from the +axis. Carrying
// the world→camera rotation through the Y-flip yields, in CSS:
//
//     translateZ(-CUBE/2) rotateX(pitch) rotateY(-yaw)        (degrees)
//
// VERIFICATION (all three cardinals):
//   • yaw=0, pitch=0  → identity → FRONT(+Z) faces viewer.            ✓
//   • orbit RIGHT (drag +dx): camera.orbit does yaw -= sens·dx → yaw↓ →
//     -yaw↑ → rotateY(+) spins the cube so its RIGHT(+X) face turns toward the
//     viewer. Orbiting right reveals the scene's right side = +X face.  ✓
//   • look DOWN (pitch → minY ≈ −π/2, negative): rotateX(negative) in the CSS
//     Y-down frame tips the TOP(+Y) face toward the viewer.            ✓
//
// So: container.style.transform =
//       `translateZ(${-CUBE/2}px) rotateX(${pitchDeg}deg) rotateY(${-yawDeg}deg)`
//
// ----------------------------------------------------------------------------
// PER-FACE SNAP TARGETS (respect the pitch clamp [minY=-0.99·π/2, maxY=0])
// ----------------------------------------------------------------------------
// FRONT is the home azimuth's "level" look. We define FRONT_YAW = 0 (a clean,
// sensible front) and level pitch = 0 (maxYTheta). Side/back faces keep level
// pitch and step yaw by ±π/2 / π. TOP looks straight down (pitch = minY). BOTTOM
// is UNREACHABLE because the pitch clamp forbids looking from below (pitch ≤ 0),
// so BOTTOM's tap clamps to the level FRONT view and is documented as such.
//
//   FRONT : yaw 0,        pitch 0
//   BACK  : yaw π,        pitch 0
//   RIGHT : yaw +π/2,     pitch 0
//   LEFT  : yaw −π/2,     pitch 0
//   TOP   : yaw (keep),   pitch minY      (look straight down; keep current azimuth)
//   BOTTOM: unreachable   → yaw (keep), pitch 0 (clamped to level; documented)
// ============================================================================

import { Camera } from './camera'

const CUBE = 84 // px — must match the .vc-cube size in index.html CSS
const DRAG_THRESHOLD_PX = 6 // movement under this on pointerup = TAP (snap), else DRAG (orbit)

type FaceName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom'

export class ViewCube {
  private camera: Camera
  private container: HTMLElement // the rotating cube container (gets the mirror transform)
  private hitLayer: HTMLElement // transparent element that captures pointer events

  // drag bookkeeping
  private dragging = false
  private activePointer: number | null = null
  private downX = 0
  private downY = 0
  private lastX = 0
  private lastY = 0
  private moved = 0 // accumulated absolute movement (px) to distinguish tap vs drag

  constructor(camera: Camera) {
    this.camera = camera

    const container = document.getElementById('vcCube')
    const hit = document.getElementById('vcHit')
    const home = document.getElementById('vcHome')
    if (!container || !hit || !home) {
      throw new Error('ViewCube: #vcCube / #vcHit / #vcHome not found in DOM')
    }
    this.container = container
    this.hitLayer = hit

    // Pointer events live on the hit layer ONLY (its own element), so the canvas
    // InputController never sees them and the slime is never poked.
    const opts: AddEventListenerOptions = { passive: false }
    hit.addEventListener('pointerdown', this.onDown, opts)
    hit.addEventListener('pointermove', this.onMove, opts)
    hit.addEventListener('pointerup', this.onUp, opts)
    hit.addEventListener('pointercancel', this.onUp, opts)
    hit.addEventListener('lostpointercapture', this.onUp, opts)

    home.addEventListener('click', this.onHome)

    // Initial sync so the cube isn't blank for one frame.
    this.update()
  }

  // ---- called once per frame by main.ts (after camera.update()) ----
  update() {
    const { yaw, pitch } = this.camera.getAngles()
    const yawDeg = (yaw * 180) / Math.PI
    const pitchDeg = (pitch * 180) / Math.PI
    // See derivation above. translateZ pulls the cube back so the perspective
    // origin sits at the cube CENTRE (not the front face) — keeps it from
    // ballooning toward the viewer as it spins.
    this.container.style.transform =
      `translateZ(${-CUBE / 2}px) rotateX(${pitchDeg}deg) rotateY(${-yawDeg}deg)`
  }

  // ---- pointer: drag = orbit, tap = snap ----
  private onDown = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    this.activePointer = e.pointerId
    this.dragging = true
    this.downX = this.lastX = e.clientX
    this.downY = this.lastY = e.clientY
    this.moved = 0
    try { this.hitLayer.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }

  private onMove = (e: PointerEvent) => {
    if (!this.dragging || e.pointerId !== this.activePointer) return
    e.preventDefault()
    e.stopPropagation()
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.moved += Math.abs(dx) + Math.abs(dy)
    // Only start actually orbiting once past the tap threshold, so a clean tap
    // (with tiny jitter) snaps instead of nudging the camera. camera.orbit()
    // cancels any active tween (the snap-from-a-previous-tap), as intended.
    if (this.moved > DRAG_THRESHOLD_PX) {
      this.camera.orbit(dx, dy)
    }
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return
    e.preventDefault()
    e.stopPropagation()
    try { this.hitLayer.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    const wasTap = this.moved <= DRAG_THRESHOLD_PX && e.type === 'pointerup'
    this.dragging = false
    this.activePointer = null
    if (wasTap) {
      const face = this.faceAt(e.clientX, e.clientY)
      if (face) this.snapToFace(face)
    }
  }

  private onHome = () => {
    // Default look (matches camera.reset defaults: yaw=π/4, pitch=−π/12).
    this.camera.animateTo(Math.PI / 4, -Math.PI / 12)
  }

  // Which face was tapped? We hit-test the real DOM faces via elementsFromPoint
  // (they sit under the transparent hit layer) and read their data-face.
  private faceAt(clientX: number, clientY: number): FaceName | null {
    const els = document.elementsFromPoint(clientX, clientY)
    for (const el of els) {
      const f = (el as HTMLElement).dataset?.face
      if (f) return f as FaceName
    }
    return null
  }

  private snapToFace(face: FaceName) {
    const { yaw } = this.camera.getAngles()
    const FRONT = 0 // canonical front azimuth (sensible, clean front)
    switch (face) {
      case 'front':  this.camera.animateTo(FRONT, 0); break
      case 'back':   this.camera.animateTo(FRONT + Math.PI, 0); break
      case 'right':  this.camera.animateTo(FRONT + Math.PI / 2, 0); break
      case 'left':   this.camera.animateTo(FRONT - Math.PI / 2, 0); break
      case 'top':    this.camera.animateTo(yaw, this.camera.minYTheta); break // look straight down; keep azimuth
      case 'bottom': // UNREACHABLE (pitch clamp forbids looking from below): clamp to level front.
        this.camera.animateTo(yaw, 0); break
    }
  }

  dispose() {
    const h = this.hitLayer
    h.removeEventListener('pointerdown', this.onDown)
    h.removeEventListener('pointermove', this.onMove)
    h.removeEventListener('pointerup', this.onUp)
    h.removeEventListener('pointercancel', this.onUp)
    h.removeEventListener('lostpointercapture', this.onUp)
    document.getElementById('vcHome')?.removeEventListener('click', this.onHome)
  }
}
