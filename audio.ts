// ============================================================================
// audio.ts — SlimeAudio: procedural, zero-asset slime SFX (Web Audio API).
//
// Real slime makes popping / crackling / squelching sounds. We synthesize them
// PROCEDURALLY (no audio files — keeps the freeware browser game zero-asset) and
// drive them from INTERACTION (poke / press / drag), with a distinct timbre per
// slime TYPE (Clear/Glossy/Butter/Cloud/Floam/Jelly).
//
// Synthesis primitives (all standard Web Audio idioms):
//   - "pop"     : a short filtered white-noise burst through a band-pass with a
//                 fast gain decay envelope (the wet bubble snap). A quick sine
//                 "ping" layered under the juicier types gives a tonal body.
//   - "squelch" : looping filtered noise through a band-pass whose cutoff is
//                 SWEPT while you drag/press — the wet smear sound. Held only
//                 while interacting; ramped to silence on release (no click).
//   - "crackle" : a stream of randomly-timed tiny pops (Poisson-ish scheduling)
//                 for the Floam/Cloud ASMR crunch; density is per-type.
//
// Mobile/desktop: browsers block audio until a user gesture — an AudioContext
// starts 'suspended' and must be resume()d inside a real gesture (iOS is strict).
// unlock() is called from input.ts's first pointerdown. It is idempotent.
//   Refs: MDN "Web Audio API best practices" (create/resume context from inside
//   a user gesture); the iOS suspended-context unlock pattern.
//
// Click-free: every envelope uses setTargetAtTime / linearRampToValueAtTime —
// never an instantaneous gain.value assignment — so the envelopes themselves
// never click. The master mute also ramps.
//
// Cheap: onPress() is called per frame but only SCHEDULES voices at a rate (it
// never spawns a voice per frame); concurrent one-shot voices are pooled/capped.
// ============================================================================

export type SlimeTypeName = 'Clear' | 'Glossy' | 'Butter' | 'Cloud' | 'Floam' | 'Jelly'

// Per-type synthesis profile. All frequencies in Hz, times in seconds.
interface SlimeProfile {
  // --- pop (the bubble snap on poke-start / during drag) ---
  popFreq: number      // band-pass centre of the noise burst
  popQ: number         // band-pass resonance (higher = more tonal/"juicy")
  popDecay: number     // gain setTargetAtTime time-constant (s) — bigger = longer tail
  popGain: number      // peak gain of one pop
  popPing: number      // 0..1 amount of a tonal sine layered under the noise (juiciness)
  // --- squelch (the wet smear while dragging/pressing) ---
  sqBase: number       // band-pass cutoff floor while pressing
  sqSweep: number      // extra cutoff added at full drag/press (wetness/openness)
  sqQ: number          // squelch band-pass resonance
  sqGain: number       // peak squelch gain (scaled by press/drag intensity)
  lowpass: number      // master-ish tone cap for this type (muted vs bright)
  // --- crackle (the granular ASMR pops while pressing) ---
  crackleRate: number  // mean pops/sec at full intensity (0 = no crackle)
  cracklePitch: number // band-pass centre of each crackle grain
  crackleSpread: number// +/- random pitch spread (Hz) per grain
}

// Concrete per-type params. Researched against the prompt's slime taxonomy:
//   Clear/Glossy = wet BIG bubble pops (lower-mid, juicy, tonal ping).
//   Butter       = soft MUTED squish (low-pass, short, little ping, no crackle).
//   Cloud        = airy/fizzy soft crackle (high, light, gentle).
//   Floam        = SHARP DENSE crackle (bright, many tiny pops — the ASMR one).
//   Jelly        = gummy bouncy (mid, slightly pitched ping, mild crackle).
const PROFILES: Record<SlimeTypeName, SlimeProfile> = {
  Clear: {
    popFreq: 300, popQ: 7.0, popDecay: 0.050, popGain: 0.90, popPing: 0.60,
    sqBase: 380, sqSweep: 1800, sqQ: 5.0, sqGain: 0.50, lowpass: 5500,
    crackleRate: 5, cracklePitch: 1500, crackleSpread: 700,
  },
  Glossy: {
    popFreq: 360, popQ: 8.0, popDecay: 0.055, popGain: 1.00, popPing: 0.65,
    sqBase: 420, sqSweep: 2100, sqQ: 5.5, sqGain: 0.55, lowpass: 6200,
    crackleRate: 6, cracklePitch: 1700, crackleSpread: 800,
  },
  Butter: {
    popFreq: 160, popQ: 3.0, popDecay: 0.030, popGain: 0.70, popPing: 0.12,
    sqBase: 200, sqSweep: 620, sqQ: 2.4, sqGain: 0.62, lowpass: 1150,
    crackleRate: 0, cracklePitch: 600, crackleSpread: 200,
  },
  Cloud: {
    popFreq: 950, popQ: 2.0, popDecay: 0.020, popGain: 0.45, popPing: 0.0,
    sqBase: 1400, sqSweep: 3000, sqQ: 1.5, sqGain: 0.30, lowpass: 9500,
    crackleRate: 18, cracklePitch: 4200, crackleSpread: 2200,
  },
  Floam: {
    popFreq: 2500, popQ: 6.0, popDecay: 0.011, popGain: 0.60, popPing: 0.0,
    sqBase: 1200, sqSweep: 2600, sqQ: 3.0, sqGain: 0.28, lowpass: 12000,
    crackleRate: 48, cracklePitch: 5400, crackleSpread: 3200,
  },
  Jelly: {
    popFreq: 480, popQ: 9.0, popDecay: 0.065, popGain: 0.85, popPing: 0.72,
    sqBase: 460, sqSweep: 1500, sqQ: 6.0, sqGain: 0.50, lowpass: 4200,
    crackleRate: 8, cracklePitch: 2000, crackleSpread: 900,
  },
}

const MAX_VOICES = 8          // hard cap on concurrent one-shot (pop/crackle) voices
const PRESS_THROTTLE_MS = 33  // min spacing between scheduling passes (~30 Hz) from onPress

export class SlimeAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null     // global gain (mute ramps this)
  private toneCap: BiquadFilterNode | null = null // per-type master low-pass (timbre)
  private noiseBuf: AudioBuffer | null = null     // shared white-noise buffer (pops/crackle)

  private profile: SlimeProfile = PROFILES.Glossy
  private muted = false

  // --- one-shot voice accounting (pops + crackle grains) ---
  private activeVoices = 0

  // --- squelch (single sustained voice while interacting) ---
  private sqSrc: AudioBufferSourceNode | null = null
  private sqFilter: BiquadFilterNode | null = null
  private sqGain: GainNode | null = null
  private sqBuf: AudioBuffer | null = null   // separate, longer looped noise for the smear
  private squelchOn = false

  // --- onPress throttle / crackle scheduling state ---
  private lastPressMs = 0
  private crackleAccum = 0   // fractional crackle budget carried between passes

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  // Lazily create + resume the AudioContext INSIDE a user gesture. Safe to call
  // every pointerdown: once running it is a no-op (we still nudge resume() because
  // iOS can re-suspend on interruptions). Never throws into the caller.
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext =
          (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
        if (!AC) return
        this.ctx = new AC()
        this.buildGraph()
      }
      if (this.ctx.state === 'suspended') {
        // resume() returns a promise; we deliberately don't await (we're in a
        // synchronous gesture handler). Swallow rejection — nothing to do.
        void this.ctx.resume().catch(() => {})
      }
    } catch {
      /* AudioContext unavailable (very old browser) — stay silent, never crash the app */
    }
  }

  // Build the persistent part of the graph: master gain -> tone low-pass -> dest.
  // One-shot voices and the squelch voice connect into `toneCap`.
  private buildGraph(): void {
    const ctx = this.ctx!
    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 1

    this.toneCap = ctx.createBiquadFilter()
    this.toneCap.type = 'lowpass'
    this.toneCap.frequency.value = this.profile.lowpass
    this.toneCap.Q.value = 0.7

    this.toneCap.connect(this.master)
    this.master.connect(ctx.destination)

    // Shared white-noise buffers (one short for grains, one longer for the smear loop).
    this.noiseBuf = this.makeNoise(0.25)
    this.sqBuf = this.makeNoise(1.5)
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds))
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  // ------------------------------------------------------------------------
  // Mute
  // ------------------------------------------------------------------------

  setMuted(m: boolean): void {
    this.muted = m
    if (this.master && this.ctx) {
      // Ramp (don't snap) to avoid a click. setTargetAtTime eases toward target.
      const now = this.ctx.currentTime
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setTargetAtTime(m ? 0 : 1, now, 0.02)
    }
    if (m) this.stopSquelch() // kill any held smear immediately when muting
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted)
    return this.muted
  }

  isMuted(): boolean { return this.muted }

  // ------------------------------------------------------------------------
  // Type selection
  // ------------------------------------------------------------------------

  setType(name: string): void {
    const p = PROFILES[name as SlimeTypeName]
    if (!p) return
    this.profile = p
    if (this.toneCap && this.ctx) {
      // Glide the master tone cap so switching type mid-hold doesn't click.
      const now = this.ctx.currentTime
      this.toneCap.frequency.setTargetAtTime(p.lowpass, now, 0.03)
    }
  }

  // ------------------------------------------------------------------------
  // Interaction API (called by input.ts)
  // ------------------------------------------------------------------------

  // A new poke just started. `strength` 0..1 (we pass the press ramp's start, ~0
  // for a fresh tap) scales the initial pop. Always fire one juicy pop so a tap
  // is audible even with no drag.
  //
  // Returns TRUE only if the start-pop actually fired (context running + unmuted).
  // The caller (input.ts) uses this to gate its rising-edge latch: on the very
  // first poke of the session the AudioContext may still be 'suspended' (resume()
  // from the same pointerdown is async and not awaited), so onPokeStart no-ops —
  // returning false lets input.ts retry on the next frame once the context is live,
  // so the most important poke (the unlock gesture itself) never loses its snap.
  // It also re-fires the start pop when un-muting mid-poke.
  onPokeStart(strength: number): boolean {
    if (!this.ready()) return false
    this.crackleAccum = 0
    this.lastPressMs = 0 // force the first onPress pass to act immediately
    this.firePop(0.7 + 0.3 * clamp01(strength))
    return true
  }

  // Called per frame while poking. `press01` = the input.ts press ramp (0..1,
  // longer hold -> 1). `dragSpeed` = |NDC delta|/frame (~0..0.1 typical). We
  // throttle internally and (a) keep the squelch smear alive with cutoff/gain set
  // by press+drag, (b) schedule crackle grains at the per-type rate * intensity,
  // (c) emit an occasional extra pop on fast drags. Cheap; spawns NOTHING per frame.
  onPress(press01: number, dragSpeed: number): void {
    if (!this.ready()) return

    const now = this.ctx!.currentTime * 1000
    if (this.lastPressMs !== 0 && now - this.lastPressMs < PRESS_THROTTLE_MS) return
    const dtMs = this.lastPressMs === 0 ? PRESS_THROTTLE_MS : now - this.lastPressMs
    this.lastPressMs = now

    const press = clamp01(press01)
    // Drag speed is small in NDC; map ~0..0.08 -> 0..1 and clamp.
    const drag = clamp01(dragSpeed / 0.08)
    // Overall "wetness" intensity: a press OR a drag both make it sing.
    const intensity = clamp01(Math.max(press * 0.85, drag))

    this.updateSquelch(intensity, drag)
    this.scheduleCrackle(intensity, dtMs)

    // Fast drags fling extra discrete pops (bubbles bursting as you smear).
    if (drag > 0.35 && Math.random() < drag * 0.25) {
      this.firePop(0.4 + 0.5 * drag)
    }
  }

  // Poke released. Fade the squelch smear out (ramped — no click) and stop crackle.
  onPokeEnd(): void {
    this.lastPressMs = 0
    this.crackleAccum = 0
    this.stopSquelch()
  }

  private ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !!this.master && !this.muted
  }

  // ------------------------------------------------------------------------
  // POP — short filtered noise burst (+ optional sine ping) with a fast decay.
  // ------------------------------------------------------------------------
  private firePop(amp: number): void {
    if (!this.ready() || this.activeVoices >= MAX_VOICES) return
    const ctx = this.ctx!
    const p = this.profile
    const t0 = ctx.currentTime

    // Noise burst -> band-pass -> gain env.
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    // randomize start offset so repeated pops aren't identical
    const off = Math.random() * 0.15
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    // small random pitch jitter for organic variation
    const jitter = 1 + (Math.random() - 0.5) * 0.25
    bp.frequency.value = p.popFreq * jitter
    bp.Q.value = p.popQ

    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    const peak = Math.max(0.0002, p.popGain * amp * 0.6)
    // fast attack then exponential-ish decay via setTargetAtTime
    g.gain.linearRampToValueAtTime(peak, t0 + 0.004)
    g.gain.setTargetAtTime(0.0001, t0 + 0.005, p.popDecay)

    src.connect(bp); bp.connect(g); g.connect(this.toneCap!)

    // Optional tonal "ping" under the noise for juicy/bubbly types.
    let osc: OscillatorNode | null = null
    let og: GainNode | null = null
    if (p.popPing > 0.001) {
      osc = ctx.createOscillator()
      osc.type = 'sine'
      const f = p.popFreq * jitter
      // Canonical physically-based bubble (van den Doel / UNC Sounding Liquids;
      // Minnaert resonance): the FREQUENCY RISES while the amplitude DECAYS. The
      // upward chirp reads as a wet bubble bursting (not a downward "bloop"/beep).
      osc.frequency.setValueAtTime(f * 0.85, t0)                                  // start low
      osc.frequency.exponentialRampToValueAtTime(f * 2.4, t0 + p.popDecay * 0.9)  // sweep UP = wet burst
      og = ctx.createGain()
      og.gain.setValueAtTime(0.0001, t0)
      og.gain.linearRampToValueAtTime(peak * 0.55 * p.popPing, t0 + 0.006)
      og.gain.setTargetAtTime(0.0001, t0 + 0.007, p.popDecay * 1.3)
      // (exp ramp safe here: target is always > 0; it's used for FREQUENCY only,
      //  never to fade a gain — gains fade via setTargetAtTime to a denormal floor.)
      osc.connect(og); og.connect(this.toneCap!)
    }

    const dur = Math.min(0.25 - off, 0.02 + p.popDecay * 6)
    this.activeVoices++
    const stopAt = t0 + dur + 0.05
    src.start(t0, off, dur + 0.04)
    src.stop(stopAt)
    if (osc) osc.start(t0), osc.stop(stopAt)
    // single onended decrement (src is the canonical voice)
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1)
      try { bp.disconnect(); g.disconnect() } catch { /* already gone */ }
      // symmetric teardown: disconnect the optional ping osc + its gain too.
      if (osc) { try { osc.disconnect() } catch { /* ignore */ } }
      if (og) { try { og.disconnect() } catch { /* ignore */ } }
    }
  }

  // ------------------------------------------------------------------------
  // CRACKLE — Poisson-ish stream of tiny pops. Budget grains over elapsed time so
  // the rate is frame-rate independent and never one-voice-per-frame.
  // ------------------------------------------------------------------------
  private scheduleCrackle(intensity: number, dtMs: number): void {
    const p = this.profile
    if (p.crackleRate <= 0 || intensity <= 0.01) return
    const rate = p.crackleRate * intensity            // grains/sec right now
    this.crackleAccum += rate * (dtMs / 1000)
    // emit whole grains; carry the fraction. Cap per pass so a long stall can't burst.
    let n = Math.floor(this.crackleAccum)
    this.crackleAccum -= n
    if (n > 3) n = 3
    for (let i = 0; i < n; i++) this.fireCrackleGrain(intensity)
  }

  private fireCrackleGrain(intensity: number): void {
    if (this.activeVoices >= MAX_VOICES) return
    const ctx = this.ctx!
    const p = this.profile
    const t0 = ctx.currentTime + Math.random() * 0.02 // tiny scatter

    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    const off = Math.random() * 0.2
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = Math.max(200, p.cracklePitch + (Math.random() - 0.5) * 2 * p.crackleSpread)
    bp.Q.value = 9

    const g = ctx.createGain()
    const peak = 0.12 + 0.18 * intensity
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(peak, t0 + 0.0015)
    g.gain.setTargetAtTime(0.0001, t0 + 0.002, 0.006) // very short tick

    src.connect(bp); bp.connect(g); g.connect(this.toneCap!)

    this.activeVoices++
    const dur = 0.03
    src.start(t0, off, dur)
    src.stop(t0 + dur + 0.02)
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1)
      try { bp.disconnect(); g.disconnect() } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------------
  // SQUELCH — one sustained looping-noise voice through a swept band-pass, alive
  // only while interacting. Cutoff & gain glide with press+drag; release ramps to 0.
  // ------------------------------------------------------------------------
  private updateSquelch(intensity: number, drag: number): void {
    const ctx = this.ctx!
    const p = this.profile
    if (!this.squelchOn) this.startSquelch()
    if (!this.sqFilter || !this.sqGain) return
    const now = ctx.currentTime
    // cutoff opens with intensity; drag adds a little extra "wet" brightness.
    const cutoff = p.sqBase + p.sqSweep * (0.25 + 0.75 * intensity) + drag * 600
    this.sqFilter.frequency.setTargetAtTime(cutoff, now, 0.04)
    const target = p.sqGain * (0.15 + 0.85 * intensity)
    this.sqGain.gain.setTargetAtTime(target, now, 0.05)
  }

  private startSquelch(): void {
    if (this.squelchOn || !this.ready()) return
    const ctx = this.ctx!
    const p = this.profile
    const src = ctx.createBufferSource()
    src.buffer = this.sqBuf
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = p.sqBase
    bp.Q.value = p.sqQ
    const g = ctx.createGain()
    g.gain.value = 0.0001 // ramp up in updateSquelch (no click)

    src.connect(bp); bp.connect(g); g.connect(this.toneCap!)
    src.start()

    this.sqSrc = src; this.sqFilter = bp; this.sqGain = g
    this.squelchOn = true
  }

  private stopSquelch(): void {
    if (!this.squelchOn || !this.ctx) { this.squelchOn = false; return }
    const ctx = this.ctx
    const now = ctx.currentTime
    const src = this.sqSrc, bp = this.sqFilter, g = this.sqGain
    this.sqSrc = null; this.sqFilter = null; this.sqGain = null
    this.squelchOn = false
    if (g) {
      g.gain.cancelScheduledValues(now)
      g.gain.setTargetAtTime(0.0001, now, 0.04) // fade out — no click
    }
    // stop the source after the fade has effectively completed, then tear down.
    const stopAt = now + 0.2
    try { src?.stop(stopAt) } catch { /* already stopped */ }
    if (src) {
      src.onended = () => {
        try { src.disconnect(); bp?.disconnect(); g?.disconnect() } catch { /* ignore */ }
      }
    }
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }
