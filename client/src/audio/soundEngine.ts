export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private turbineOsc: OscillatorNode | null = null;
  private turbineGain: GainNode | null = null;
  private burnerGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  public enabled = false;

  public toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.initIfNeeded();
      if (this.ctx?.state === 'suspended') {
        void this.ctx.resume();
      }
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(0.32, this.ctx.currentTime, 0.08);
      }
      this.playClick();
    } else if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.06);
    }
    return this.enabled;
  }

  private initIfNeeded(): void {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.masterGain = master;

    // Reusable 2s white noise buffer
    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buf;

    // 1. Jet turbine hum
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 82;
    const turbFilter = ctx.createBiquadFilter();
    turbFilter.type = 'lowpass';
    turbFilter.frequency.value = 240;
    const turbGain = ctx.createGain();
    turbGain.gain.value = 0.16;
    osc.connect(turbFilter);
    turbFilter.connect(turbGain);
    turbGain.connect(master);
    osc.start();
    this.turbineOsc = osc;
    this.turbineGain = turbGain;

    // 2. Afterburner roar
    const burnerSrc = ctx.createBufferSource();
    burnerSrc.buffer = buf;
    burnerSrc.loop = true;
    const burnerFilter = ctx.createBiquadFilter();
    burnerFilter.type = 'bandpass';
    burnerFilter.frequency.value = 180;
    burnerFilter.Q.value = 0.7;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.0;
    burnerSrc.connect(burnerFilter);
    burnerFilter.connect(bGain);
    bGain.connect(master);
    burnerSrc.start();
    this.burnerGain = bGain;

    // 3. Wind rush
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'highpass';
    windFilter.frequency.value = 950;
    const wGain = ctx.createGain();
    wGain.gain.value = 0.05;
    windSrc.connect(windFilter);
    windFilter.connect(wGain);
    wGain.connect(master);
    windSrc.start();
    this.windGain = wGain;
  }

  public updateFlight(speed: number, afterburner: boolean): void {
    if (!this.enabled || !this.ctx || !this.turbineOsc || !this.burnerGain || !this.windGain || !this.turbineGain) {
      return;
    }
    const t = this.ctx.currentTime;
    const normSpd = Math.max(0, Math.min(1.5, speed / 90));
    this.turbineOsc.frequency.setTargetAtTime(72 + normSpd * 48, t, 0.08);
    this.turbineGain.gain.setTargetAtTime(afterburner ? 0.24 : 0.14, t, 0.08);
    this.burnerGain.gain.setTargetAtTime(afterburner ? 0.36 : 0.0, t, 0.08);
    this.windGain.gain.setTargetAtTime(0.03 + normSpd * 0.07, t, 0.1);
  }

  public playClick(): void {
    if (!this.enabled || !this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.exponentialRampToValueAtTime(280, t + 0.035);
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.045);
  }

  public playMissileWhoosh(): void {
    if (!this.enabled || !this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.exponentialRampToValueAtTime(320, t + 0.45);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(t);
    src.stop(t + 0.5);
  }

  public playDetonation(isWater: boolean, distFromJet: number): void {
    if (!this.enabled || !this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const atten = Math.max(0.08, Math.min(1, 120 / Math.max(40, distFromJet)));
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(isWater ? 750 : 480, t);
    filter.frequency.exponentialRampToValueAtTime(90, t + 0.7);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45 * atten, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.75);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(t);
    src.stop(t + 0.8);
  }
}
