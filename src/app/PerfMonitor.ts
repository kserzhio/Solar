/**
 * Watches the frame rate; if it stays under 45 fps for 2 seconds, steps the
 * quality down (fewer particles, cheaper bloom, lower pixel ratio).
 */
export class PerfMonitor {
  level = 0;
  fps = 60;
  private acc = 0;
  private frames = 0;
  private lowFor = 0;
  private grace = 2;

  constructor(
    private readonly maxLevel: number,
    private readonly onDowngrade: (level: number) => void,
  ) {}

  /** Ignore the next few seconds (scene switches, shader compiles, tab returns). */
  hold(seconds = 1.5): void {
    this.grace = Math.max(this.grace, seconds);
    this.acc = 0;
    this.frames = 0;
  }

  tick(realDt: number): void {
    if (document.hidden) return;
    if (this.grace > 0) {
      this.grace -= realDt;
      return;
    }
    this.acc += realDt;
    this.frames++;
    if (this.acc < 0.5) return;
    this.fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    this.lowFor = this.fps < 45 ? this.lowFor + 0.5 : 0;
    if (this.lowFor >= 2 && this.level < this.maxLevel) {
      this.level++;
      this.lowFor = 0;
      this.grace = 2.5;
      this.onDowngrade(this.level);
    }
  }
}
