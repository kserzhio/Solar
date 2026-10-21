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

  /**
   * Through a wormhole: pressure building to the throat (a sub swell, a rising roar and a
   * glassy whistle sweeping up), then let go on the far side.
   */
  wormhole(seconds: number): void {
    if (!this.ctx || !this.cuesEnabled) return;
    const ctx = this.ctx;
    const t = this.now();
    const mid = t + seconds * 0.45;
    const end = t + seconds;
    window.clearInterval(this.sparkleTimer);
    this.ramp(this.padGain.gain, 0, seconds * 0.4);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(32, t);
    sub.frequency.exponentialRampToValueAtTime(58, mid);
    sub.frequency.exponentialRampToValueAtTime(30, end);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.7, mid);
    sg.gain.exponentialRampToValueAtTime(0.0001, end);
    sub.connect(sg).connect(this.master);
    sub.start(t);
    sub.stop(end + 0.1);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(90, t);
    lp.frequency.exponentialRampToValueAtTime(1100, mid);
    lp.frequency.exponentialRampToValueAtTime(140, end);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.55, mid);
    ng.gain.exponentialRampToValueAtTime(0.0001, end);
    noise.connect(lp).connect(ng);
    ng.connect(this.master);
    ng.connect(this.reverbSend);
    noise.start(t);
    noise.stop(end + 0.1);

    const whistle = ctx.createBufferSource();
    whistle.buffer = this.noiseBuffer;
    whistle.loop = true;
    whistle.playbackRate.value = 2;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 18;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2400, mid);
    bp.frequency.exponentialRampToValueAtTime(600, end);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.exponentialRampToValueAtTime(0.12, mid);
    wg.gain.exponentialRampToValueAtTime(0.0001, end);
    whistle.connect(bp).connect(wg);
    wg.connect(this.master);
    wg.connect(this.reverbSend);
    whistle.start(t);
    whistle.stop(end + 0.1);
  }

  private garg: { gain: GainNode; filter: BiquadFilterNode; bright: GainNode; nodes: AudioScheduledSourceNode[] } | null = null;
  private gargBright = false;

  /**
   * Near Gargantua: a slow, dark drone (two low tones beating against each other, and a
   * breath of filtered noise) in place of the Solar System's ambience.
   */
  gargantua(on: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (on && !this.garg) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 260;
      filter.Q.value = 0.8;
      filter.connect(gain);
      gain.connect(this.master);
      gain.connect(this.reverbSend);
      const nodes: AudioScheduledSourceNode[] = [];
      for (const [f, level, type] of [
        [36.7, 0.5, 'sine'],
        [37.2, 0.35, 'sine'],
        [55, 0.22, 'triangle'],
        [73.4, 0.08, 'sine'],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = level;
        o.connect(g).connect(filter);
        o.start();
        nodes.push(o);
      }
      const breath = ctx.createBufferSource();
      breath.buffer = this.noiseBuffer;
      breath.loop = true;
      breath.playbackRate.value = 0.5;
      const bg = ctx.createGain();
      bg.gain.value = 0.25;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.045;
      const lg = ctx.createGain();
      lg.gain.value = 0.2;
      lfo.connect(lg).connect(bg.gain);
      breath.connect(bg).connect(filter);
      breath.start();
      lfo.start();
      nodes.push(breath, lfo);
      // «As in nature»: a high, glassy shimmer over the drone (the blazing side of the disk),
      // two close tones beating and a band of hiss, faded in by gargantuaLook().
      const bright = ctx.createGain();
      bright.gain.value = this.gargBright ? 0.1 : 0;
      bright.connect(gain);
      for (const f of [220, 221.6, 330.4]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = f > 300 ? 0.25 : 0.5;
        o.connect(g).connect(bright);
        o.start();
        nodes.push(o);
      }
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer;
      hiss.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1400;
      band.Q.value = 3;
      const hg = ctx.createGain();
      hg.gain.value = 0.35;
      hiss.connect(band).connect(hg).connect(bright);
      hiss.start();
      nodes.push(hiss);
      // The bright voice bypasses the drone's low-pass (it would cut it away).
      bright.disconnect();
      bright.connect(this.master);
      bright.connect(this.reverbSend);
      this.garg = { gain, filter, bright, nodes };
      window.clearInterval(this.sparkleTimer);
      this.ramp(this.padGain.gain, 0, 2);
      this.ramp(this.droneGain.gain, 0, 2);
      this.ramp(gain.gain, 0.5, 4);
    } else if (!on && this.garg) {
      const { gain, bright, nodes } = this.garg;
      this.garg = null;
      this.ramp(gain.gain, 0, 1.5);
      this.ramp(bright.gain, 0, 1.5);
      window.setTimeout(() => {
        nodes.forEach((n) => n.stop());
        gain.disconnect();
        bright.disconnect();
      }, 1700);
    }
  }

  /**
   * Gargantua's look changing: «as in nature» brings in the bright voice, and either way a
   * short sweep of air marks the change (up into nature, down into the film).
   */
  gargantuaLook(physics: boolean, sweep = true): void {
    this.gargBright = physics;
    if (!this.ctx || !this.garg) return;
    const ctx = this.ctx;
    this.ramp(this.garg.bright.gain, physics ? 0.1 : 0, 1.6);
    if (!sweep || !this.cuesEnabled) return;
    const t = this.now();
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(physics ? 300 : 2400, t);
    f.frequency.exponentialRampToValueAtTime(physics ? 2400 : 300, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    src.connect(f).connect(g).connect(this.master);
    g.connect(this.reverbSend);
    src.start(t);
    src.stop(t + 1.7);
  }

  private chirpNodes: AudioScheduledSourceNode[] = [];

  /**
   * Two black holes merging in `seconds`: the gravitational-wave "chirp", made audible as
   * LIGO's scientists did — a low tone sweeping up ever faster to the merger, then a short
   * ring-down. chirp(0) stops it.
   */
  chirp(seconds: number): void {
    this.chirpNodes.forEach((n) => {
      try {
        n.stop();
      } catch {
        // Already stopped.
      }
    });
    this.chirpNodes = [];
    if (!this.ctx || !this.cuesEnabled || seconds <= 0) return;
    const ctx = this.ctx;
    const t = this.now();
    const steps = 96;
    const freq = new Float32Array(steps);
    // Frequency ∝ (1 − t/tc)^−3/8, from 28 Hz to about 300 Hz.
    for (let i = 0; i < steps; i++) freq[i] = Math.min(300, 28 * Math.pow(1 - Math.min(i / (steps - 1), 0.9985), -3 / 8));
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueCurveAtTime(freq, t, seconds);
    o.frequency.setTargetAtTime(240, t + seconds, 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 2);
    g.gain.exponentialRampToValueAtTime(0.45, t + seconds - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.6);
    o.connect(g).connect(this.master);
    g.connect(this.reverbSend);
    o.start(t);
    o.stop(t + seconds + 0.7);
    // The thump of the merger itself.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(70, t + seconds);
    thump.frequency.exponentialRampToValueAtTime(30, t + seconds + 1.2);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t + seconds);
    tg.gain.exponentialRampToValueAtTime(0.6, t + seconds + 0.04);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 1.4);
    thump.connect(tg).connect(this.master);
    tg.connect(this.reverbSend);
    thump.start(t + seconds);
    thump.stop(t + seconds + 1.5);
    this.chirpNodes = [o, thump];
  }

  private throat: { gain: GainNode; nodes: AudioScheduledSourceNode[] } | null = null;

  /**
   * A wormhole's mouth close by, 0..1: a low hum with a slow wobble and a breath of air
   * through it, growing as we near the throat.
   */
  throatHum(k: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.throat) {
      if (k < 0.01) return;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      gain.connect(this.reverbSend);
      const nodes: AudioScheduledSourceNode[] = [];
      const wob = ctx.createGain();
      wob.gain.value = 0.7;
      wob.connect(gain);
      for (const [fr, level] of [
        [46, 0.5],
        [69.3, 0.3],
        [92.6, 0.12],
      ] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = fr;
        const g = ctx.createGain();
        g.gain.value = level;
        o.connect(g).connect(wob);
        o.start();
        nodes.push(o);
      }
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.31;
      const lg = ctx.createGain();
      lg.gain.value = 0.3;
      lfo.connect(lg).connect(wob.gain);
      lfo.start();
      const air = ctx.createBufferSource();
      air.buffer = this.noiseBuffer;
      air.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 380;
      bp.Q.value = 1.4;
      const ag = ctx.createGain();
      ag.gain.value = 0.2;
      air.connect(bp).connect(ag).connect(gain);
      air.start();
      nodes.push(lfo, air);
      this.throat = { gain, nodes };
    }
    this.throat.gain.gain.setTargetAtTime(Math.min(1, Math.max(0, k)) * 0.35, this.now(), 0.4);
  }

  /** How close we are to the hole, 0..1: the drone opens up and grows. */
  gargantuaNear(k: number): void {
    if (!this.ctx || !this.garg) return;
    const t = this.now();
    this.garg.filter.frequency.setTargetAtTime(220 + 900 * k, t, 0.6);
    this.garg.gain.gain.setTargetAtTime(0.4 + 0.45 * k, t, 0.6);
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
