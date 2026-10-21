import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';
import { equatorialToScene } from './util';

/**
 * The brightest stars of the real sky (J2000 RA / Dec in degrees, visual magnitude, B−V
 * colour index), placed through the same galactic frame as the Milky Way panorama so they
 * sit on top of the stars in the photo. `name` is shown when constellations are on.
 */
const STARS: { id: string; name?: string; ra: number; dec: number; mag: number; bv: number }[] = [
  { id: 'sirius', name: 'Сіріус', ra: 101.287, dec: -16.716, mag: -1.46, bv: 0.0 },
  { id: 'canopus', name: 'Канопус', ra: 95.988, dec: -52.696, mag: -0.74, bv: 0.15 },
  { id: 'arcturus', name: 'Арктур', ra: 213.915, dec: 19.182, mag: -0.05, bv: 1.23 },
  { id: 'rigilkent', name: 'Альфа Центавра', ra: 219.902, dec: -60.834, mag: -0.27, bv: 0.71 },
  { id: 'vega', name: 'Вега', ra: 279.234, dec: 38.784, mag: 0.03, bv: 0.0 },
  { id: 'capella', name: 'Капелла', ra: 79.172, dec: 45.998, mag: 0.08, bv: 0.8 },
  { id: 'rigel', name: 'Рігель', ra: 78.634, dec: -8.202, mag: 0.13, bv: -0.03 },
  { id: 'procyon', name: 'Процион', ra: 114.825, dec: 5.225, mag: 0.34, bv: 0.42 },
  { id: 'achernar', ra: 24.429, dec: -57.237, mag: 0.46, bv: -0.16 },
  { id: 'betelgeuse', name: 'Бетельгейзе', ra: 88.793, dec: 7.407, mag: 0.5, bv: 1.85 },
  { id: 'hadar', ra: 210.956, dec: -60.373, mag: 0.61, bv: -0.23 },
  { id: 'altair', name: 'Альтаїр', ra: 297.696, dec: 8.868, mag: 0.76, bv: 0.22 },
  { id: 'acrux', ra: 186.65, dec: -63.099, mag: 0.76, bv: -0.24 },
  { id: 'aldebaran', name: 'Альдебаран', ra: 68.98, dec: 16.509, mag: 0.86, bv: 1.54 },
  { id: 'antares', name: 'Антарес', ra: 247.352, dec: -26.432, mag: 0.96, bv: 1.83 },
  { id: 'spica', ra: 201.298, dec: -11.161, mag: 0.97, bv: -0.23 },
  { id: 'pollux', ra: 116.329, dec: 28.026, mag: 1.14, bv: 1.0 },
  { id: 'fomalhaut', ra: 344.413, dec: -29.622, mag: 1.16, bv: 0.09 },
  { id: 'deneb', name: 'Денеб', ra: 310.358, dec: 45.28, mag: 1.25, bv: 0.09 },
  { id: 'mimosa', ra: 191.93, dec: -59.689, mag: 1.25, bv: -0.24 },
  { id: 'regulus', ra: 152.093, dec: 11.967, mag: 1.35, bv: -0.11 },
  { id: 'adhara', ra: 104.656, dec: -28.972, mag: 1.5, bv: -0.21 },
  { id: 'castor', ra: 113.65, dec: 31.888, mag: 1.58, bv: 0.03 },
  { id: 'gacrux', ra: 187.791, dec: -57.113, mag: 1.63, bv: 1.6 },
  { id: 'shaula', ra: 263.402, dec: -37.104, mag: 1.62, bv: -0.22 },
  { id: 'bellatrix', ra: 81.283, dec: 6.35, mag: 1.64, bv: -0.22 },
  { id: 'elnath', ra: 81.573, dec: 28.608, mag: 1.65, bv: -0.13 },
  { id: 'miaplacidus', ra: 138.3, dec: -69.717, mag: 1.67, bv: 0.07 },
  { id: 'alnilam', ra: 84.053, dec: -1.202, mag: 1.69, bv: -0.18 },
  { id: 'alnair', ra: 332.058, dec: -46.961, mag: 1.74, bv: -0.13 },
  { id: 'alnitak', ra: 85.19, dec: -1.943, mag: 1.77, bv: -0.21 },
  { id: 'alioth', ra: 193.507, dec: 55.96, mag: 1.77, bv: -0.02 },
  { id: 'dubhe', ra: 165.932, dec: 61.751, mag: 1.79, bv: 1.07 },
  { id: 'mirfak', ra: 51.081, dec: 49.861, mag: 1.79, bv: 0.48 },
  { id: 'wezen', ra: 107.098, dec: -26.393, mag: 1.83, bv: 0.68 },
  { id: 'sargas', ra: 264.33, dec: -42.998, mag: 1.86, bv: 0.4 },
  { id: 'kausaus', ra: 276.043, dec: -34.385, mag: 1.85, bv: -0.03 },
  { id: 'avior', ra: 125.628, dec: -59.51, mag: 1.86, bv: 1.28 },
  { id: 'alkaid', ra: 206.885, dec: 49.313, mag: 1.86, bv: -0.1 },
  { id: 'menkalinan', ra: 89.882, dec: 44.948, mag: 1.9, bv: 0.03 },
  { id: 'atria', ra: 252.166, dec: -69.028, mag: 1.92, bv: 1.44 },
  { id: 'alhena', ra: 99.428, dec: 16.399, mag: 1.93, bv: 0.0 },
  { id: 'peacock', ra: 306.412, dec: -56.735, mag: 1.94, bv: -0.2 },
  { id: 'polaris', name: 'Полярна', ra: 37.955, dec: 89.264, mag: 1.98, bv: 0.6 },
  { id: 'mirzam', ra: 95.675, dec: -17.956, mag: 1.98, bv: -0.24 },
  { id: 'alphard', ra: 141.897, dec: -8.659, mag: 1.98, bv: 1.44 },
  { id: 'hamal', ra: 31.793, dec: 23.462, mag: 2.0, bv: 1.15 },
  { id: 'mizar', ra: 200.981, dec: 54.925, mag: 2.23, bv: 0.02 },
  { id: 'merak', ra: 165.46, dec: 56.382, mag: 2.37, bv: 0.03 },
  { id: 'phecda', ra: 178.457, dec: 53.695, mag: 2.44, bv: 0.04 },
  { id: 'megrez', ra: 183.857, dec: 57.033, mag: 3.31, bv: 0.08 },
  { id: 'saiph', ra: 86.939, dec: -9.67, mag: 2.09, bv: -0.18 },
  { id: 'mintaka', ra: 83.002, dec: -0.299, mag: 2.23, bv: -0.22 },
  { id: 'meissa', ra: 83.784, dec: 9.934, mag: 3.39, bv: -0.16 },
  { id: 'schedar', ra: 10.127, dec: 56.537, mag: 2.24, bv: 1.17 },
  { id: 'caph', ra: 2.295, dec: 59.15, mag: 2.28, bv: 0.34 },
  { id: 'navi', ra: 14.177, dec: 60.717, mag: 2.47, bv: -0.15 },
  { id: 'ruchbah', ra: 21.454, dec: 60.235, mag: 2.68, bv: 0.13 },
  { id: 'segin', ra: 28.599, dec: 63.67, mag: 3.37, bv: -0.15 },
  { id: 'imai', ra: 183.786, dec: -58.749, mag: 2.79, bv: -0.23 },
  { id: 'sadr', ra: 305.557, dec: 40.257, mag: 2.23, bv: 0.67 },
  { id: 'gienah', ra: 311.553, dec: 33.97, mag: 2.48, bv: 1.03 },
  { id: 'fawaris', ra: 296.244, dec: 45.131, mag: 2.87, bv: -0.03 },
  { id: 'albireo', ra: 292.68, dec: 27.96, mag: 3.08, bv: 1.13 },
  { id: 'acrab', ra: 241.359, dec: -19.806, mag: 2.62, bv: -0.07 },
  { id: 'dschubba', ra: 240.083, dec: -22.622, mag: 2.32, bv: -0.12 },
  { id: 'pisco', ra: 239.713, dec: -26.114, mag: 2.89, bv: -0.19 },
  { id: 'alniyat', ra: 245.297, dec: -25.593, mag: 2.89, bv: 0.13 },
  { id: 'tausco', ra: 248.971, dec: -28.216, mag: 2.82, bv: -0.25 },
  { id: 'larawag', ra: 252.541, dec: -34.293, mag: 2.29, bv: 1.15 },
  { id: 'xamidimura', ra: 252.968, dec: -38.048, mag: 3.0, bv: -0.2 },
  { id: 'etasco', ra: 258.038, dec: -43.239, mag: 3.32, bv: 0.41 },
  { id: 'iotasco', ra: 266.896, dec: -40.127, mag: 3.03, bv: 0.51 },
  { id: 'girtab', ra: 265.622, dec: -39.03, mag: 2.39, bv: -0.22 },
];

/** Constellation figures (pairs of star ids) and where to write their names. */
const CONSTELLATIONS: { name: string; lines: [string, string][] }[] = [
  {
    name: 'Оріон',
    lines: [
      ['betelgeuse', 'bellatrix'], ['betelgeuse', 'alnitak'], ['bellatrix', 'mintaka'], ['mintaka', 'alnilam'],
      ['alnilam', 'alnitak'], ['alnitak', 'saiph'], ['mintaka', 'rigel'], ['meissa', 'betelgeuse'], ['meissa', 'bellatrix'],
    ],
  },
  {
    name: 'Великий Віз',
    lines: [['alkaid', 'mizar'], ['mizar', 'alioth'], ['alioth', 'megrez'], ['megrez', 'dubhe'], ['dubhe', 'merak'], ['merak', 'phecda'], ['phecda', 'megrez']],
  },
  { name: 'Кассіопея', lines: [['caph', 'schedar'], ['schedar', 'navi'], ['navi', 'ruchbah'], ['ruchbah', 'segin']] },
  { name: 'Південний Хрест', lines: [['acrux', 'gacrux'], ['mimosa', 'imai']] },
  { name: 'Лебідь', lines: [['deneb', 'sadr'], ['sadr', 'albireo'], ['fawaris', 'sadr'], ['sadr', 'gienah']] },
  {
    name: 'Скорпіон',
    lines: [
      ['acrab', 'dschubba'], ['dschubba', 'pisco'], ['dschubba', 'alniyat'], ['alniyat', 'antares'], ['antares', 'tausco'],
      ['tausco', 'larawag'], ['larawag', 'xamidimura'], ['xamidimura', 'etasco'], ['etasco', 'sargas'], ['sargas', 'iotasco'],
      ['iotasco', 'girtab'], ['girtab', 'shaula'],
    ],
  },
];

/** Rough colour of a star from its B−V index (blue-white to deep orange). */
function bvColor(bv: number): THREE.Color {
  const stops: [number, string][] = [[-0.3, '#9db4ff'], [0.0, '#cad8ff'], [0.4, '#f8f7ff'], [0.65, '#fff4e8'], [1.0, '#ffd9b0'], [1.5, '#ffb877'], [2.0, '#ff9d5c']];
  for (let i = 1; i < stops.length; i++) {
    if (bv <= stops[i][0]) {
      const t = (bv - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return new THREE.Color(stops[i - 1][1]).lerp(new THREE.Color(stops[i][1]), Math.max(0, t));
    }
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}

export interface SkyLabel {
  pos: THREE.Vector3;
  text: string;
  kind: 'star' | 'constellation';
}

/**
 * Bright stars as glowing points at their true places, plus faint constellation figures
 * that fade in on demand. Lives in the sky group (moved with the camera, like the panorama).
 */
export function createBrightStars(radius = 262) {
  const byId = new Map<string, THREE.Vector3>();
  const pos: number[] = [];
  const col: number[] = [];
  const size: number[] = [];
  const labels: SkyLabel[] = [];
  for (const s of STARS) {
    const v = equatorialToScene(s.ra, s.dec).multiplyScalar(radius);
    byId.set(s.id, v);
    pos.push(v.x, v.y, v.z);
    const c = bvColor(s.bv);
    col.push(c.r, c.g, c.b);
    // Magnitude to apparent size: each magnitude is 2.5× fainter.
    size.push(Math.min(9, 2.4 * Math.pow(10, -0.2 * (s.mag - 1.2))));
    if (s.name) labels.push({ pos: v.clone(), text: s.name, kind: 'star' });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  const uOpacity = { value: 0 };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { uOpacity, uViewScale: globalUniforms.uViewScale, uTime: globalUniforms.uTime },
      vertexShader: /* glsl */ `
        uniform float uViewScale;
        uniform float uTime;
        attribute vec3 aColor;
        attribute float aSize;
        varying vec3 vColor;
        varying float vTw;
        void main() {
          vColor = aColor;
          // A slow, gentle twinkle.
          vTw = 0.85 + 0.15 * sin(uTime * 1.3 + position.x * 0.37 + position.y * 0.11);
          gl_PointSize = aSize * (uViewScale / 760.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying vec3 vColor;
        varying float vTw;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float d = dot(c, c);
          if (d > 1.0) discard;
          float core = exp(-d * 14.0);
          float halo = exp(-d * 3.5) * 0.35;
          gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.6) * (core + halo) * vTw * uOpacity * 1.6, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  points.frustumCulled = false;

  const linePos: number[] = [];
  for (const c of CONSTELLATIONS) {
    const centre = new THREE.Vector3();
    let n = 0;
    for (const [a, b] of c.lines) {
      const pa = byId.get(a)!;
      const pb = byId.get(b)!;
      // Stop the lines short of the stars so the figures don't run through them.
      const da = pa.clone().lerp(pb, 0.08);
      const db = pb.clone().lerp(pa, 0.08);
      linePos.push(da.x, da.y, da.z, db.x, db.y, db.z);
      centre.add(pa).add(pb);
      n += 2;
    }
    labels.push({ pos: centre.divideScalar(n).setLength(radius), text: c.name, kind: 'constellation' });
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;

  const group = new THREE.Group();
  group.add(points, lines);
  return {
    group,
    labels,
    /** Overall visibility (follows the sky). */
    set opacity(v: number) {
      uOpacity.value = v;
    },
    /** Constellation figures, 0..1. */
    set figures(v: number) {
      lineMat.opacity = v * 0.32;
      lines.visible = v > 0.002;
    },
    dispose() {
      geometry.dispose();
      lineGeo.dispose();
      (points.material as THREE.Material).dispose();
      lineMat.dispose();
    },
  };
}
