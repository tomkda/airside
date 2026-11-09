// Sound (v0.12). Everything is synthesised with the Web Audio API: no files, so the game stays one page.
// The sim never calls this; ui.ts and main.ts do, from what the player does and what the sim reports.
//
//   Building: a soft thud when something is placed, a lower crumble when it is demolished, a tick for tools.
//   Feedback: a short rise for money in, a two-note fall for "can't", a chime for a goal or an unlock.
//   The airfield: a jet's roar as it takes off or lands, louder when you are zoomed in near the runway,
//   and a quiet bed of air and terminal murmur that follows how busy the airport is.
const PREF = 'airside-sound';

export class Sound {
  on = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private bed: { air: GainNode; hum: GainNode } | null = null;
  private lastJet = 0;

  constructor() {
    try { this.on = localStorage.getItem(PREF) !== 'off'; } catch { /* default on */ }
    // browsers only let audio start from a gesture
    const wake = () => { if (this.on) this.ensure(); };
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake, { passive: true });
  }

  toggle(v = !this.on) {
    this.on = v;
    try { localStorage.setItem(PREF, v ? 'on' : 'off'); } catch { /* not saved */ }
    if (v) { this.ensure(); this.tick(); }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v ? 0.5 : 0, this.ctx.currentTime, 0.05);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return this.ctx; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain(); this.master.gain.value = this.on ? 0.5 : 0; this.master.connect(ctx.destination);
      const n = ctx.sampleRate * 2; this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noise.getChannelData(0); let b = 0;
      for (let i = 0; i < n; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6; }   // soft, low noise
      // the bed: filtered air, and a faint low hum for a busy terminal
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      const air = ctx.createGain(); air.gain.value = 0; src.connect(lp).connect(air).connect(this.master); src.start();
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 92;
      const hum = ctx.createGain(); hum.gain.value = 0; o.connect(hum).connect(this.master); o.start();
      this.bed = { air, hum };
      return ctx;
    } catch { this.ctx = null; return null; }
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', when = 0, slide = 0) {
    const ctx = this.on ? this.ensure() : null; if (!ctx || !this.master) return;
    const t = ctx.currentTime + when; const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  private burst(dur: number, vol: number, f0: number, f1: number, when = 0, attack = 0.01) {
    const ctx = this.on ? this.ensure() : null; if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + when; const s = ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.7; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  tick() { this.tone(880, 0.05, 0.05, 'triangle'); }
  place() { this.tone(150, 0.16, 0.22, 'sine', 0, 0.5); this.burst(0.12, 0.12, 900, 300); }
  demolish() { this.burst(0.45, 0.2, 500, 90); this.tone(90, 0.3, 0.16, 'sine', 0, 0.6); }
  cash() { this.tone(660, 0.09, 0.07, 'triangle'); this.tone(990, 0.14, 0.07, 'triangle', 0.07); }
  deny() { this.tone(220, 0.1, 0.09, 'square'); this.tone(165, 0.16, 0.09, 'square', 0.09); }
  chime() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.7, 0.09, 'sine', i * 0.09)); }
  dayEnd() { this.tone(392, 0.5, 0.07, 'sine'); this.tone(523.25, 0.8, 0.07, 'sine', 0.18); }

  /** A jet on the runway. `near` is 0–1: how close the view is to it. */
  jet(near: number, landing: boolean) {
    const ctx = this.on ? this.ensure() : null; if (!ctx) return;
    if (ctx.currentTime - this.lastJet < 1.2 || near <= 0.02) return;
    this.lastJet = ctx.currentTime;
    if (landing) this.burst(3.2, 0.22 * near, 1400, 260, 0, 0.25); else this.burst(4.5, 0.3 * near, 240, 1500, 0, 1.4);
  }

  /** The quiet bed: `busy` 0–1 for how full the terminals are, `close` 0–1 for how far in the view is. */
  ambience(busy: number, close: number, paused: boolean) {
    if (!this.ctx || !this.bed) return;
    const t = this.ctx.currentTime; const k = paused ? 0.3 : 1;
    this.bed.air.gain.setTargetAtTime(0.05 * k * (0.5 + 0.5 * (1 - close)), t, 0.6);
    this.bed.hum.gain.setTargetAtTime(0.03 * k * busy * close, t, 0.6);
  }
}
