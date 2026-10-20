/**
 * Planet facts (approximate public NASA values) and the "comfortable" display
 * scale: radii and orbits are compressed so the whole system fits in one frame.
 */
export type PlanetKind = 'rocky' | 'earth' | 'gas' | 'ice';

export interface Planet {
  id: string;
  name: string;
  kicker: string;
  kind: PlanetKind;
  diameter: string;
  distance: string;
  day: string;
  year: string;
  moons: string;
  fact: string;
  /** Display radius and orbit radius in scene units. */
  size: number;
  orbit: number;
  /** Real orbital period in Earth years, compressed for display speed. */
  periodYears: number;
  /** Starting angle on the orbit, radians. */
  phase: number;
  /** Axial tilt, degrees. */
  tilt: number;
  /** Orbital inclination to the ecliptic, degrees, and the node direction (radians). */
  inclination?: number;
  node?: number;
  /** Shader palette: base, secondary, accent, atmosphere. */
  colors: [string, string, string, string];
  rings?: boolean;
  /** Faint narrow ring system (Jupiter, Uranus, Neptune): radii in planet sizes. */
  faintRings?: { inner: number; outer: number; opacity: number; color: string };
  /** A large storm system: latitude/longitude (radians), angular radius, colour. */
  spot?: { lat: number; lon: number; radius: number; color: string };
  /** Visible moons in display units: radius, orbit distance, angular speed (rad per clock second). */
  satellites?: { name: string; radius: number; distance: number; speed: number; phase: number; color: string }[];
}

export const PLANETS: Planet[] = [
  {
    id: 'mercury',
    name: 'Меркурій',
    kicker: 'Планета земної групи',
    kind: 'rocky',
    diameter: '4 879 км',
    distance: '57,9 млн км · 0,39 а. о.',
    day: '176 земних діб',
    year: '88 земних діб',
    moons: '0',
    fact: 'Сонячна доба на Меркурії (176 земних діб) удвічі довша за його рік.',
    size: 0.26,
    orbit: 4.2,
    periodYears: 0.241,
    phase: 0.4,
    tilt: 0,
    colors: ['#8c8580', '#5d5853', '#b5aea6', '#000000'],
  },
  {
    id: 'venus',
    name: 'Венера',
    kicker: 'Планета земної групи',
    kind: 'rocky',
    diameter: '12 104 км',
    distance: '108,2 млн км · 0,72 а. о.',
    day: '243 земні доби',
    year: '225 земних діб',
    moons: '0',
    fact: 'Обертається у зворотний бік, тож Сонце там сходить на заході. На поверхні близько 465 °C.',
    size: 0.44,
    orbit: 5.9,
    periodYears: 0.615,
    phase: 2.3,
    tilt: 177,
    colors: ['#e3c48f', '#c49a5c', '#f1dfb6', '#ffd9a0'],
  },
  {
    id: 'earth',
    name: 'Земля',
    kicker: 'Наш дім',
    kind: 'earth',
    diameter: '12 742 км',
    distance: '149,6 млн км · 1 а. о.',
    day: '23 год 56 хв',
    year: '365,25 доби',
    moons: '1',
    fact: 'Єдина відома планета, на поверхні якої є рідка вода і життя.',
    size: 0.47,
    orbit: 7.7,
    periodYears: 1,
    phase: 4.1,
    tilt: 23.4,
    colors: ['#1d4f9a', '#3f7d3a', '#c9b38a', '#7fb4ff'],
    satellites: [{ name: 'Місяць', radius: 0.12, distance: 0.95, speed: 1.1, phase: 0, color: '#a9a7a3' }],
  },
  {
    id: 'mars',
    name: 'Марс',
    kicker: 'Планета земної групи',
    kind: 'rocky',
    diameter: '6 779 км',
    distance: '227,9 млн км · 1,52 а. о.',
    day: '24 год 37 хв',
    year: '687 земних діб',
    moons: '2',
    fact: 'Тут гора Олімп — найвищий відомий вулкан Сонячної системи, близько 22 км заввишки.',
    size: 0.34,
    orbit: 9.6,
    periodYears: 1.881,
    phase: 5.6,
    tilt: 25.2,
    colors: ['#b5532e', '#7a2e17', '#d9875a', '#e0a07a'],
  },
  {
    id: 'jupiter',
    name: 'Юпітер',
    kicker: 'Газовий гігант',
    kind: 'gas',
    diameter: '139 820 км',
    distance: '778,5 млн км · 5,2 а. о.',
    day: '9 год 56 хв',
    year: '11,9 земного року',
    moons: '95+',
    fact: 'Велика Червона Пляма — шторм, більший за Землю, який спостерігають понад 150 років.',
    size: 1.3,
    orbit: 15.2,
    periodYears: 11.86,
    phase: 1.2,
    tilt: 3.1,
    colors: ['#d8c2a0', '#a9774f', '#f3e6d0', '#e8d4b0'],
    spot: { lat: -0.36, lon: 0.6, radius: 0.2, color: '#a8381f' },
    faintRings: { inner: 1.22, outer: 1.45, opacity: 0.22, color: '#c9a98a' },
    satellites: [
      { name: 'Іо', radius: 0.075, distance: 1.95, speed: 1.6, phase: 0.3, color: '#d8c35c' },
      { name: 'Європа', radius: 0.066, distance: 2.4, speed: 1.15, phase: 2.1, color: '#d9d0c1' },
      { name: 'Ганімед', radius: 0.11, distance: 2.95, speed: 0.8, phase: 4.0, color: '#9d9288' },
      { name: 'Каллісто', radius: 0.1, distance: 3.6, speed: 0.48, phase: 5.2, color: '#6e655d' },
    ],
  },
  {
    id: 'saturn',
    name: 'Сатурн',
    kicker: 'Газовий гігант',
    kind: 'gas',
    diameter: '116 460 км',
    distance: '1,43 млрд км · 9,5 а. о.',
    day: '10 год 34 хв',
    year: '29,5 земного року',
    moons: '274',
    fact: 'Середня густина Сатурна менша за густину води: у велетенському океані він би плавав.',
    size: 1.08,
    orbit: 19.6,
    periodYears: 29.46,
    phase: 3.4,
    tilt: -26.7,
    colors: ['#e6d3a3', '#bf9e66', '#f6ecd0', '#f0dfb0'],
    rings: true,
    satellites: [{ name: 'Титан', radius: 0.1, distance: 3.15, speed: 0.5, phase: 1.0, color: '#d39a4b' }],
  },
  {
    id: 'uranus',
    name: 'Уран',
    kicker: 'Крижаний гігант',
    kind: 'ice',
    diameter: '50 724 км',
    distance: '2,87 млрд км · 19,2 а. о.',
    day: '17 год 14 хв',
    year: '84 земні роки',
    moons: '29',
    fact: 'Його вісь нахилена на 98°, тож планета ніби котиться орбітою на боці.',
    size: 0.72,
    orbit: 23.8,
    periodYears: 84.0,
    phase: 0.1,
    tilt: 97.8,
    colors: ['#9fd8e0', '#7bbcc8', '#c8eef2', '#b0f0ff'],
    faintRings: { inner: 1.6, outer: 2.05, opacity: 0.55, color: '#9aa6b0' },
  },
  {
    id: 'neptune',
    name: 'Нептун',
    kicker: 'Крижаний гігант',
    kind: 'ice',
    diameter: '49 244 км',
    distance: '4,5 млрд км · 30,1 а. о.',
    day: '16 год 6 хв',
    year: '164,8 земного року',
    moons: '16',
    fact: 'Тут найсильніші вітри в Сонячній системі — понад 2 000 км/год.',
    size: 0.7,
    orbit: 27.6,
    periodYears: 164.8,
    phase: 2.0,
    tilt: 28.3,
    colors: ['#3e63d6', '#2a3f9e', '#7c9cf0', '#6f8fff'],
    spot: { lat: -0.35, lon: 2.0, radius: 0.13, color: '#16226a' },
    faintRings: { inner: 1.7, outer: 2.4, opacity: 0.32, color: '#8f9ab8' },
  },
];

/** Dwarf planets: shown with tilted orbits, not part of the forming disk. */
export const DWARFS: Planet[] = [
  {
    id: 'ceres',
    name: 'Церера',
    kicker: 'Карликова планета',
    kind: 'rocky',
    diameter: '939 км',
    distance: '414 млн км · 2,77 а. о.',
    day: '9 год 4 хв',
    year: '4,6 земного року',
    moons: '0',
    fact: 'Найбільше тіло поясу астероїдів. На ній знайшли яскраві плями солей — сліди підземного розсолу.',
    size: 0.11,
    orbit: 12.3,
    periodYears: 4.6,
    phase: 2.6,
    tilt: 4,
    inclination: 10.6,
    node: 1.4,
    colors: ['#8f8b86', '#5e5a56', '#c9c4bc', '#000000'],
  },
  {
    id: 'pluto',
    name: 'Плутон',
    kicker: 'Карликова планета',
    kind: 'rocky',
    diameter: '2 377 км',
    distance: '5,9 млрд км · 39,5 а. о.',
    day: '6,4 земної доби',
    year: '248 земних років',
    moons: '5',
    fact: 'Має величезне крижане «серце» — рівнину Спутника, вкриту замерзлим азотом.',
    size: 0.17,
    orbit: 31.8,
    periodYears: 248,
    phase: 4.4,
    tilt: 120,
    inclination: 17.1,
    node: 1.9,
    colors: ['#cdb69d', '#8a6a52', '#f1e6d8', '#000000'],
  },
  {
    id: 'eris',
    name: 'Еріда',
    kicker: 'Карликова планета',
    kind: 'rocky',
    diameter: '2 326 км',
    distance: '10,1 млрд км · 68 а. о.',
    day: '≈ 15,8 земної доби',
    year: '557 земних років',
    moons: '1',
    fact: 'Її відкриття у 2005 році змусило астрономів переглянути поняття «планета» — і Плутон став карликовою.',
    size: 0.17,
    orbit: 36.5,
    periodYears: 557,
    phase: 0.9,
    tilt: 78,
    inclination: 44,
    node: 0.6,
    colors: ['#e6e2dc', '#a9a49d', '#ffffff', '#000000'],
  },
];

export const ASTEROID_BELT = { inner: 11.4, outer: 13.2 };
export const KUIPER_BELT = { inner: 29.5, outer: 44 };
export const SUN_RADIUS = 2.2;

/** Angular speed in rad/s at orbit speed 1×; real period ratios softened so outer planets still move. */
export const orbitalSpeed = (p: Planet): number => 0.16 * Math.pow(1 / p.periodYears, 0.6);
export const planetAngle = (p: Planet, clock: number): number => p.phase + orbitalSpeed(p) * clock;
/** Same law for loose dust at radius r (Earth's orbit as the reference). */
export const dustSpeed = (r: number): number => 0.16 * Math.pow(7.7 / r, 1.5);

/** Overview camera pose (spherical, around the Sun). Shared by the disk scene so the hand-off is seamless. */
export const OVERVIEW = { distance: 56, elevation: 0.43, azimuth: 0 };
