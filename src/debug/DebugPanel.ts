import GUI from 'lil-gui';
import { config, type ColorKey } from '../config';
import { copyText } from '../stub';

export interface DebugHooks {
  applyConfig(): void;
  applyBloom(): void;
  setVolume(v: number): void;
  stats(): { fps: number; quality: number; particles: number };
}

const COLOR_LABELS: Record<ColorKey, string> = {
  singularity: 'Сингулярність',
  bangHot: 'Вибух · гарячий',
  bangCool: 'Вибух · охолодження',
  plasmaWhite: 'Плазма · білий',
  plasmaGold: 'Плазма · золотий',
  plasmaOrange: 'Плазма · помаранчевий',
  plasmaRed: 'Плазма · червоний',
  filament: 'Космічна павутина',
  starWarm: 'Зорі · теплі',
  starCool: 'Зорі · холодні',
  galaxyCore: 'Галактики · ядро',
  galaxyArm: 'Галактики · рукави',
  galaxyHII: 'Галактики · HII',
  nebulaViolet: 'Туманність · фіолетова',
  nebulaTeal: 'Туманність · бірюзова',
  nebulaPink: 'Туманність · рожева',
  disk: 'Протопланетний диск',
  sun: 'Сонце',
};

/** Dev-only lil-gui panel, toggled with D. */
export function createDebugPanel(hooks: DebugHooks): { toggle(): void } {
  const gui = new GUI({ title: 'Налагодження · D' });
  gui.hide();

  const stats = { fps: '—', quality: '—', particles: '—' };
  const info = gui.addFolder('Стан');
  info.add(stats, 'fps').name('FPS').disable().listen();
  info.add(stats, 'quality').name('Якість').disable().listen();
  info.add(stats, 'particles').name('Частинок (зараз)').disable().listen();
  window.setInterval(() => {
    const s = hooks.stats();
    stats.fps = s.fps.toFixed(0);
    stats.quality = `${Math.round(s.quality * 100)}%`;
    stats.particles = s.particles.toLocaleString('uk-UA');
  }, 500);

  const particles = gui.addFolder('Частинки (після «Почати спочатку»)');
  particles.add(config, 'particleScale', 0.25, 2, 0.05).name('Множник кількості');
  for (const key of Object.keys(config.particles) as (keyof typeof config.particles)[]) {
    particles.add(config.particles, key, 500, 250000, 500);
  }
  particles.close();

  const bloom = gui.addFolder('Bloom');
  bloom.add(config.bloom, 'intensity', 0, 4, 0.01).name('Сила').onChange(() => hooks.applyBloom());
  bloom.add(config.bloom, 'threshold', 0, 1, 0.01).name('Поріг').onChange(() => hooks.applyBloom());
  bloom.add(config.bloom, 'smoothing', 0, 1, 0.01).name('Згладжування').onChange(() => hooks.applyBloom());
  bloom.add(config.bloom, 'radius', 0, 1, 0.01).name('Радіус').onChange(() => hooks.applyBloom());

  const durations = gui.addFolder('Тривалість сцен, с (наступний запуск)');
  durations.add(config.durations, 'bang', 1.2, 10, 0.1).name('Вибух');
  durations.add(config.durations, 'plasma', 2, 20, 0.1).name('Плазма і Темні віки');
  durations.add(config.durations, 'cosmos', 4, 40, 0.5).name('Зорі й галактики');
  durations.add(config.durations, 'approach', 4, 30, 0.5).name('Наближення до дому');
  durations.add(config.durations, 'arrival', 1, 8, 0.1).name('Поява Сонячної системи');

  gui.add(config, 'cameraSpeed', 0.2, 1.6, 0.05).name('Швидкість камери');
  gui.add(config, 'volume', 0, 1, 0.01).name('Гучність').onChange((v: number) => hooks.setVolume(v));

  const colors = gui.addFolder('Кольори');
  for (const key of Object.keys(config.colors) as ColorKey[]) {
    colors.addColor(config.colors, key).name(COLOR_LABELS[key]).onChange(() => hooks.applyConfig());
  }
  colors.close();

  const actions = {
    export: async () => {
      const ok = await copyText(JSON.stringify(config, null, 2));
      exportCtrl.name(ok ? 'Скопійовано ✓' : 'Не вдалося скопіювати');
      window.setTimeout(() => exportCtrl.name('Експорт налаштувань'), 2000);
    },
  };
  const exportCtrl = gui.add(actions, 'export').name('Експорт налаштувань');

  // Typing in the panel must not trigger hotkeys.
  gui.domElement.addEventListener('keydown', (e) => e.stopPropagation());

  return {
    toggle: () => (gui._hidden ? gui.show() : gui.hide()),
  };
}
