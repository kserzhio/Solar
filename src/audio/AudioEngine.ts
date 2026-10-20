/**
 * Fully synthesised soundtrack (no audio files): drone, bass hit, rumble,
 * crystalline pings and an ambient pad. The AudioContext is created lazily on
 * the first user gesture, as browsers require.
 */
export class AudioEngine {
  muted = false;
  /** Off while the timeline is being fast-forwarded, so cues don't fire in a burst. */
  cuesEnabled = true;
  private volume = 0.8;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private droneGain!: GainNode;
  private droneFilter!: BiquadFilterNode;
  private warmOsc!: OscillatorNode;
  private warmGain!: GainNode;
  private rumbleGain!: GainNode;
  private padGain!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private lastPing = 0;
  private sparkleTimer = 0;
  private suspendedByPause = false;

  get started(): boolean {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture handler. */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.suspendedByPause) void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.2, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.noiseBuffer = this.makeNoise(4);
    this.buildDrone();
    this.buildRumble();
    this.buildPad();
    this.drone(0.22, 2.5);
  }

  private now(): number {
    return this.ctx!.currentTime;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown-ish noise: integrated white noise, softer than white.
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  private buildDrone(): void {
    const ctx = this.ctx!;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 320;
    this.droneFilter.Q.value = 0.7;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.master);
    this.droneGain.connect(this.reverbSend);

    const voices: [OscillatorType, number, number][] = [
      ['sine', 55, 0],
      ['sine', 82.4, 4],
      ['triangle', 110, -6],
      ['sine', 164.8, 3],
    ];
    voices.forEach(([type, f, detune], i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = [0.5, 0.28, 0.16, 0.08][i];
      o.connect(g).connect(this.droneFilter);
      o.start();
    });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 110;
    lfo.connect(lfoGain).connect(this.droneFilter.frequency);
    lfo.start();

    // A brighter fifth that fades in when the drone "warms up" near home.
    this.warmOsc = ctx.createOscillator();
    this.warmOsc.type = 'triangle';
    this.warmOsc.frequency.value = 246.9;
    this.warmGain = ctx.createGain();
    this.warmGain.gain.value = 0;
    this.warmOsc.connect(this.warmGain).connect(this.droneFilter);
    this.warmOsc.start();
  }

  private buildRumble(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    src.connect(lp).connect(this.rumbleGain).connect(this.master);
    src.start();
  }

  private buildPad(): void {
    const ctx = this.ctx!;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    this.padGain.connect(filter);
    filter.connect(this.master);
    filter.connect(this.reverbSend);
    // A-major-ish open voicing: A2 E3 A3 C#4 E4 B4.
    [110, 164.81, 220, 277.18, 329.63, 493.88].forEach((f, i) => {
      for (const det of [-5, 5]) {
        const o = ctx.createOscillator();
        o.type = i < 2 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = det + (i % 2 ? 2 : -2);
        const g = ctx.createGain();
        g.gain.value = 0.05 / (1 + i * 0.35);
        const trem = ctx.createOscillator();
        trem.frequency.value = 0.05 + i * 0.023;
        const tg = ctx.createGain();
        tg.gain.value = g.gain.value * 0.6;
        trem.connect(tg).connect(g.gain);
        o.connect(g).connect(this.padGain);
        o.start();
        trem.start();
      }
    });
  }

  private ramp(param: AudioParam, value: number, seconds: number): void {
    const t = this.now();
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + Math.max(0.01, seconds));
  }

  // ---------------------------------------------------------------- cues

  drone(level: number, seconds: number): void {
    if (!this.ctx) return;
    this.ramp(this.droneGain.gain, level, seconds);
  }

  /** Anticipation: everything drains to silence. */
  silence(seconds: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    this.ramp(this.droneGain.gain, 0, seconds);
    this.ramp(this.rumbleGain.gain, 0, seconds);
    this.ramp(this.padGain.gain, 0, seconds);
    this.ramp(this.warmGain.gain, 0, seconds);
  }

  /** A soft airy swell marking the passage between epochs. */
  whoosh(seconds = 1.8, peak = 0.16): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.playbackRate.value = 1.6;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + seconds * 0.5);
    bp.frequency.exponentialRampToValueAtTime(700, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + seconds * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    noise.connect(bp).connect(g);
    g.connect(this.master);
    g.connect(this.reverbSend);
    noise.start(t);
    noise.stop(t + seconds + 0.1);
  }

  /** A comet sweeping past the Sun: a long airy hiss with a faint shimmer. */
  cometPass(pan = 0): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.playbackRate.value = 2.2;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan - 0.5)), t);
    panner.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, pan + 0.5)), t + 4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 1.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
    noise.connect(hp).connect(g).connect(panner);
    panner.connect(this.master);
    panner.connect(this.reverbSend);
    noise.start(t);
    noise.stop(t + 4.3);
    window.setTimeout(() => this.ping(pan), 700);
    window.setTimeout(() => this.ping(pan + 0.2), 1300);
  }

  private blip(freqs: number[], level: number, length: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    g.connect(this.master);
    g.connect(this.reverbSend);
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t + i * 0.045);
      o.connect(g);
      o.start(t + i * 0.045);
      o.stop(t + length + 0.05);
    });
  }

  /** Interface sounds: barely-there glass ticks. */
  uiHover(): void {
    this.blip([2349], 0.018, 0.18);
  }

  uiSelect(): void {
    this.blip([1568, 2349], 0.035, 0.5);
  }

  uiBack(): void {
    this.blip([2349, 1568], 0.03, 0.45);
  }

  /** Rewind: a falling, reversed-sounding sweep that swallows the ambience. */
  rewind(seconds: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    window.clearInterval(this.sparkleTimer);
    this.ramp(this.padGain.gain, 0, seconds * 0.8);
    this.ramp(this.droneGain.gain, 0.05, seconds);
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.8;
    bp.frequency.setValueAtTime(6000, t);
    bp.frequency.exponentialRampToValueAtTime(120, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + seconds * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.3);
    noise.connect(bp).connect(g);
    g.connect(this.master);
    g.connect(this.reverbSend);
    noise.start(t);
    noise.stop(t + seconds + 0.4);
  }

  /** Inflation: a rising airy whoosh that the bang cuts off. */
  inflation(seconds: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + seconds * 0.95);
    g.gain.linearRampToValueAtTime(0, t + seconds + 0.04);
    noise.connect(bp).connect(g);
    g.connect(this.master);
    g.connect(this.reverbSend);
    noise.start(t);
    noise.stop(t + seconds + 0.1);
  }

  /** The Big Bang: a deep sub drop with a filtered noise burst. */
  boom(): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(95, t);
    sub.frequency.exponentialRampToValueAtTime(26, t + 3.2);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(1.1, t + 0.03);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 5);
    sub.connect(sg);
    sg.connect(this.master);
    sg.connect(this.reverbSend);
    sub.start(t);
    sub.stop(t + 5.2);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 3);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    noise.connect(lp).connect(ng);
    ng.connect(this.master);
    ng.connect(this.reverbSend);
    noise.start(t);
    noise.stop(t + 3.6);
  }

  /** Hot plasma: a low hum that fades with the cooling. */
  hum(seconds: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const t = this.now();
    const g = this.rumbleGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.75, t + 0.8);
    g.linearRampToValueAtTime(0.0, t + seconds);
    this.ramp(this.droneGain.gain, 0.08, seconds);
  }

  /** A crystalline "spark" for a star igniting. */
  ping(pan = 0): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const t = this.now();
    if (t - this.lastPing < 0.09) return;
    this.lastPing = t;
    const ctx = this.ctx;
    const scale = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3, 2637];
    const f = scale[Math.floor(Math.random() * scale.length)];
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.08, t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner);
    panner.connect(this.master);
    panner.connect(this.reverbSend);
    for (const [mult, type, amp] of [
      [1, 'sine', 1],
      [2.756, 'sine', 0.35],
      [5.404, 'triangle', 0.12],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 2.5);
    }
  }

  /** Approaching home: the drone returns, brighter and warmer. */
  warm(seconds: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    this.ramp(this.droneGain.gain, 0.24, seconds * 0.6);
    this.ramp(this.droneFilter.frequency, 900, seconds);
    this.ramp(this.warmGain.gain, 0.12, seconds);
  }

  /** Final calm ambience with occasional soft sparkles. */
  ambient(seconds = 4): void {
    if (!this.ctx || !this.cuesEnabled) return;
    this.ramp(this.padGain.gain, 0.9, seconds);
    this.ramp(this.droneGain.gain, 0.12, seconds);
    this.ramp(this.warmGain.gain, 0.05, seconds);
    this.ramp(this.rumbleGain.gain, 0, 1);
    window.clearInterval(this.sparkleTimer);
    this.sparkleTimer = window.setInterval(() => {
      if (Math.random() < 0.45) this.ping(Math.random() * 1.6 - 0.8);
    }, 3200);
  }

  /** Steady soundscape for a stage after jumping along the timeline. */
  settle(stage: 'intro' | 'bang' | 'plasma' | 'cosmos' | 'approach' | 'solar'): void {
    if (!this.ctx) return;
    window.clearInterval(this.sparkleTimer);
    this.ramp(this.rumbleGain.gain, stage === 'plasma' ? 0.25 : 0, 0.6);
    this.ramp(this.padGain.gain, 0, 0.6);
    this.ramp(this.warmGain.gain, 0, 0.6);
    this.ramp(this.droneFilter.frequency, 320, 0.6);
    if (stage === 'approach') this.warm(3);
    else if (stage === 'solar') this.ambient(2);
    else this.drone(stage === 'cosmos' ? 0.14 : 0.1, 0.8);
  }

  /** Back to the start screen. */
  reset(): void {
    window.clearInterval(this.sparkleTimer);
    if (!this.ctx) return;
    this.ramp(this.padGain.gain, 0, 1.2);
    this.ramp(this.rumbleGain.gain, 0, 0.6);
    this.ramp(this.warmGain.gain, 0, 1.2);
    this.ramp(this.droneFilter.frequency, 320, 1.2);
    this.drone(0.22, 2.5);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx) this.ramp(this.master.gain, muted ? 0 : this.volume, 0.25);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && !this.muted) this.ramp(this.master.gain, v, 0.1);
  }

  setPaused(paused: boolean): void {
    if (!this.ctx) return;
    this.suspendedByPause = paused;
    if (paused) void this.ctx.suspend();
    else void this.ctx.resume();
  }
}
