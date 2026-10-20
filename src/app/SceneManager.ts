import type { Ctx, SceneModule, SceneName } from './types';

export class SceneManager {
  private scenes = new Map<SceneName, SceneModule>();
  private active: SceneModule[] = [];
  /** Entered scenes that keep their state but are not updated (while an optional scene plays). */
  private frozen = new Set<SceneName>();

  constructor(private ctx: Ctx) {}

  add(scene: SceneModule): void {
    this.scenes.set(scene.name, scene);
  }

  get<T extends SceneModule>(name: SceneName): T {
    const scene = this.scenes.get(name);
    if (!scene) throw new Error(`Unknown scene: ${name}`);
    return scene as T;
  }

  isActive(name: SceneName): boolean {
    return this.scenes.get(name)?.active ?? false;
  }

  enter(name: SceneName): void {
    const scene = this.get(name);
    if (scene.active) return;
    scene.active = true;
    this.ctx.scene.add(scene.group);
    scene.enter();
    this.active.push(scene);
  }

  exit(name: SceneName): void {
    const scene = this.get(name);
    if (!scene.active) return;
    scene.active = false;
    scene.exit();
    this.ctx.scene.remove(scene.group);
    this.active = this.active.filter((s) => s !== scene);
  }

  freeze(names: SceneName[], on: boolean): void {
    names.forEach((n) => (on ? this.frozen.add(n) : this.frozen.delete(n)));
  }

  exitAll(): void {
    [...this.active].forEach((s) => this.exit(s.name));
  }

  /** Scenes update in the order they entered, so the newest one owns the camera. */
  update(dt: number, time: number): void {
    for (const scene of [...this.active]) if (!this.frozen.has(scene.name)) scene.update(dt, time);
  }

  applyConfig(): void {
    this.scenes.forEach((s) => s.applyConfig?.());
  }

  disposeAll(): void {
    this.exitAll();
    this.scenes.forEach((s) => s.dispose?.());
    this.scenes.clear();
  }
}
