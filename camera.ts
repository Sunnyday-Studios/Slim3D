import { mat4 } from 'wgpu-matrix'
import { renderUniformsViews } from './common'

// Result of a poke pick: the world-space pointer ray plus the per-frame world
// delta-v the InputController hands to MLSMPMSimulator.setPointerForce().
export interface PokeForce {
  origin: number[]   // ray origin = camera world position
  dir: number[]      // normalized ray direction (into the scene)
  force: number[]    // world-space per-frame delta-v (pre-clamped here; re-clamped in setPointerForce)
  radius: number     // world-space poke radius
}

export class Camera {
  currentXtheta!: number
  currentYtheta!: number
  maxYTheta!: number
  minYTheta!: number
  sensitivity!: number
  currentDistance!: number
  maxDistance!: number
  minDistance!: number
  target!: number[]
  fov!: number
  zoomRate!: number

  // --- M4 ViewCube snap tween (eased orbit toward a target yaw/pitch) ---
  // performance.now() is allowed in app code (only Workflow scripts forbid it).
  private tweenActive = false
  private tweenStartMs = 0
  private tweenDurMs = 300
  private tweenFromYaw = 0
  private tweenFromPitch = 0
  private tweenToYaw = 0
  private tweenToPitch = 0

  // The constructor signature is kept (main.ts does `new Camera(canvas)`), but it
  // NO LONGER binds any listeners — the InputController owns all canvas pointer
  // handling now, and calls the imperative methods below. The param is unused.
  constructor(_canvasElement: HTMLCanvasElement) {}

  reset(canvasElement: HTMLCanvasElement, initDistance: number, target: number[], fov: number, zoomRate: number) {
    this.currentXtheta = (Math.PI / 4) * 1
    this.currentYtheta = -Math.PI / 12
    this.maxYTheta = 0
    this.minYTheta = (-0.99 * Math.PI) / 2
    this.sensitivity = 0.005
    this.currentDistance = initDistance
    this.maxDistance = 2 * this.currentDistance
    this.minDistance = 0.3 * this.currentDistance
    this.target = target
    this.fov = fov
    this.zoomRate = zoomRate

    const aspect = canvasElement.clientWidth / canvasElement.clientHeight
    const projection = mat4.perspective(fov, aspect, 0.1, 500)
    renderUniformsViews.projection_matrix.set(projection)
    renderUniformsViews.inv_projection_matrix.set(mat4.inverse(projection))
    this.recalculateView()
  }

  // ----------------------------------------------------------------------------
  // Imperative camera control (called by InputController). Orbit/zoom math is
  // preserved EXACTLY from the M1 listener code.
  // ----------------------------------------------------------------------------

  // dxPixels/dyPixels = RAW screen movement (current - previous). The M1 mousemove
  // used deltaX = prev - current and did `currentXtheta += sensitivity * deltaX`.
  // With raw (cur - prev) input that is `currentXtheta -= sensitivity * (cur-prev)`,
  // which is what we do here — identical feel.
  orbit(dxPixels: number, dyPixels: number) {
    // Any genuine user orbit cancels an in-flight ViewCube snap tween, so a live
    // drag always wins over an animation (no fight between the two).
    this.tweenActive = false
    this.currentXtheta -= this.sensitivity * dxPixels
    this.currentYtheta -= this.sensitivity * dyPixels
    if (this.currentYtheta > this.maxYTheta) this.currentYtheta = this.maxYTheta
    if (this.currentYtheta < this.minYTheta) this.currentYtheta = this.minYTheta
    this.recalculateView()
  }

  // ----------------------------------------------------------------------------
  // M4 ViewCube support: read current orbit angles + an eased snap tween.
  // ----------------------------------------------------------------------------

  // Current orbit angles (yaw = currentXtheta, pitch = currentYtheta).
  getAngles(): { yaw: number; pitch: number } {
    return { yaw: this.currentXtheta, pitch: this.currentYtheta }
  }

  // Start an eased tween of yaw/pitch toward (yaw, clamp(pitch)) over ~300ms.
  // Records start values + start time; update() advances it each frame.
  animateTo(yaw: number, pitch: number) {
    let p = pitch
    if (p > this.maxYTheta) p = this.maxYTheta
    if (p < this.minYTheta) p = this.minYTheta
    this.tweenFromYaw = this.currentXtheta
    this.tweenFromPitch = this.currentYtheta
    this.tweenToYaw = yaw
    this.tweenToPitch = p
    this.tweenStartMs = performance.now()
    this.tweenActive = true
  }

  // Called once per frame from main.ts. If a tween is active, advance it with an
  // ease-in-out curve, set yaw/pitch (clamped) and recalc the view. orbit()
  // clears tweenActive, so a mid-tween user drag cancels the animation.
  update() {
    if (!this.tweenActive) return
    const elapsed = performance.now() - this.tweenStartMs
    let t = this.tweenDurMs > 0 ? elapsed / this.tweenDurMs : 1
    if (t >= 1) { t = 1; this.tweenActive = false }
    // ease in-out (smoothstep-style cubic)
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    this.currentXtheta = this.tweenFromYaw + (this.tweenToYaw - this.tweenFromYaw) * e
    this.currentYtheta = this.tweenFromPitch + (this.tweenToPitch - this.tweenFromPitch) * e
    if (this.currentYtheta > this.maxYTheta) this.currentYtheta = this.maxYTheta
    if (this.currentYtheta < this.minYTheta) this.currentYtheta = this.minYTheta
    this.recalculateView()
  }

  // Discrete wheel step. +1 = zoom OUT (distance grows), matching the M1 wheel:
  // deltaY > 0 -> currentDistance += zoomRate.
  zoom(steps: number) {
    this.zoomBy(steps * this.zoomRate)
  }

  // Continuous zoom (for pinch). +units = farther, -units = closer. Same clamp.
  zoomBy(units: number) {
    this.currentDistance += units
    if (this.currentDistance < this.minDistance) this.currentDistance = this.minDistance
    if (this.currentDistance > this.maxDistance) this.currentDistance = this.maxDistance
    this.recalculateView()
  }

  getTarget(): number[] { return this.target }
  getDistance(): number { return this.currentDistance }

  recalculateView() {
    const mat = mat4.identity()
    mat4.translate(mat, this.target, mat)
    mat4.rotateY(mat, this.currentXtheta, mat)
    mat4.rotateX(mat, this.currentYtheta, mat)
    mat4.translate(mat, [0, 0, this.currentDistance], mat)
    const position = mat4.multiply(mat, [0, 0, 0, 1])

    const view = mat4.lookAt(
      [position[0], position[1], position[2]],
      this.target,
      [0, 1, 0],
    )
    renderUniformsViews.view_matrix.set(view)
    renderUniformsViews.inv_view_matrix.set(mat4.inverse(view))
  }

  // ----------------------------------------------------------------------------
  // Unprojection + poke force. The camera owns the inv_projection / inv_view
  // matrices it writes into renderUniforms, so the unproject math lives here.
  // ----------------------------------------------------------------------------

  // column-major mat4 (Float32Array(16)) * vec4 -> [x,y,z,w]
  private mulVec4(m: Float32Array, x: number, y: number, z: number, w: number): number[] {
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12] * w,
      m[1] * x + m[5] * y + m[9] * z + m[13] * w,
      m[2] * x + m[6] * y + m[10] * z + m[14] * w,
      m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    ]
  }

  // Manual column-major unproject. WebGPU clip space is z in [0,1]:
  //   near = (ndcX, ndcY, 0, 1), far = (ndcX, ndcY, 1, 1).
  // Push each through inv_projection (-> view space), perspective-divide by its
  // OWN w, then through inv_view (-> world). Origin = camera world position =
  // inv_view * (0,0,0,1) = inv_view column 3.
  unproject(ndcX: number, ndcY: number): { origin: number[]; dir: number[] } {
    const invP = renderUniformsViews.inv_projection_matrix
    const invV = renderUniformsViews.inv_view_matrix

    const nearV = this.mulVec4(invP, ndcX, ndcY, 0.0, 1.0)
    const farV = this.mulVec4(invP, ndcX, ndcY, 1.0, 1.0)
    const nwi = 1.0 / (nearV[3] || 1e-8)
    const fwi = 1.0 / (farV[3] || 1e-8)

    const nW = this.mulVec4(invV, nearV[0] * nwi, nearV[1] * nwi, nearV[2] * nwi, 1.0)
    const fW = this.mulVec4(invV, farV[0] * fwi, farV[1] * fwi, farV[2] * fwi, 1.0)

    const origin = [invV[12], invV[13], invV[14]] // camera world pos
    let dx = fW[0] - nW[0], dy = fW[1] - nW[1], dz = fW[2] - nW[2]
    const len = Math.hypot(dx, dy, dz) || 1
    return { origin, dir: [dx / len, dy / len, dz / len] }
  }

  // World point where a pointer ray pierces the PLANE through the orbit target,
  // perpendicular to the camera forward axis. `fwd` is the unit camera->target
  // direction; `depth` is the camera->target distance. Scaling the ray by
  // depth/dot(dir,fwd) lands on the true plane (not a sphere), so off-axis pokes
  // are not under-scaled by cos(angle). Clamp the denominator so rays nearly
  // parallel to the plane don't explode.
  private rayPointOnTargetPlane(
    ndcX: number, ndcY: number, fwd: number[], depth: number,
  ): { origin: number[]; dir: number[]; point: number[] } {
    const { origin, dir } = this.unproject(ndcX, ndcY)
    const denom = Math.max(dir[0] * fwd[0] + dir[1] * fwd[1] + dir[2] * fwd[2], 1e-4)
    const t = depth / denom
    return {
      origin, dir,
      point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
    }
  }

  // Build the poke force from the current + previous NDC of the poke pointer.
  // The drag is measured on the PLANE through the orbit target (perpendicular to
  // the view direction), so screen-drag maps to a world delta that scales
  // correctly with zoom and stays accurate off-axis. A small inward push along
  // the ray makes a stationary tap still dent. The simulator re-clamps |force| to
  // MAX_INJECT_V (atomic-headroom safe).
  poke(ndcX: number, ndcY: number, ndcPrevX: number, ndcPrevY: number): PokeForce {
    const depth = this.currentDistance // distance to the orbit target plane
    // camera forward = unit(target - cameraWorldPos). Use the current ray origin.
    const o = this.unproject(ndcX, ndcY).origin
    let fx = this.target[0] - o[0], fy = this.target[1] - o[1], fz = this.target[2] - o[2]
    const fl = Math.hypot(fx, fy, fz) || 1
    const fwd = [fx / fl, fy / fl, fz / fl]
    const cur = this.rayPointOnTargetPlane(ndcX, ndcY, fwd, depth)
    const prev = this.rayPointOnTargetPlane(ndcPrevX, ndcPrevY, fwd, depth)

    const DRAG = 0.15 // screen-drag -> world delta-v gain (depth is large, so keep low)
    const PUSH = 0.35 // inward push along the ray so a tap dents even with no drag
    const dir = cur.dir
    const force = [
      (cur.point[0] - prev.point[0]) * DRAG + dir[0] * PUSH,
      (cur.point[1] - prev.point[1]) * DRAG + dir[1] * PUSH,
      (cur.point[2] - prev.point[2]) * DRAG + dir[2] * PUSH,
    ]
    return { origin: cur.origin, dir, force, radius: 6.0 }
  }
}
