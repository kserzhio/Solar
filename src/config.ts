/**
 * Tunable settings. The debug panel (key D in dev) edits this object live;
 * «Експорт налаштувань» copies it as JSON so the values can be pasted back here.
 */
export const config = {
  /** Global multiplier for every particle system (applied on «Почати спочатку»). */
  particleScale: 1,
  particles: {
    singularity: 60000,
    bang: 80000,
    cosmicWeb: 100000,
    galaxies: 56000,
    firstStars: 5000,
    heroGalaxy: 70000,
    disk: 45000,
  },
  bloom: {
    intensity: 1.25,
    threshold: 0.16,
    smoothing: 0.3,
    radius: 0.78,
  },
  /** Seconds per scene. Changes apply on the next run. */
  durations: {
    bang: 5.5,
    plasma: 13,
    cosmos: 14,
    approach: 10,
    arrival: 2.5,
  },
  cameraSpeed: 1,
  volume: 0.8,
  colors: {
    singularity: '#b4bac8',
    bangHot: '#fff4de',
    bangCool: '#ffb459',
    plasmaWhite: '#fff0d6',
    plasmaGold: '#ffb04a',
    plasmaOrange: '#ff7420',
    plasmaRed: '#7a1206',
    filament: '#5a68e0',
    starWarm: '#ffd6a6',
    starCool: '#bcd0ff',
    galaxyCore: '#ffd49a',
    galaxyArm: '#8fb0ff',
    galaxyHII: '#ff6aa8',
    nebulaViolet: '#7a3cff',
    nebulaTeal: '#1fc6bd',
    nebulaPink: '#ff4d96',
    disk: '#ffa65e',
    sun: '#ffaa3c',
  },
};

export type Config = typeof config;
export type ColorKey = keyof Config['colors'];

export const particleCount = (key: keyof Config['particles']): number =>
  Math.max(500, Math.round(config.particles[key] * config.particleScale));
