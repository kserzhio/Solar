import * as THREE from 'three';
import { gsap } from 'gsap';
import { config } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, gaussian, globalUniforms, mulberry32 } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import type { Solar } from './Solar';
import { disposeObject, lerp, smooth } from './util';

const AU_PER_LY = 63241;
/** Camera distance to the focus point, in world units, while zooming. */
const VIEW = 92;
/** Display unit of the Solar System scene, in AU (Neptune's orbit ≈ 27.6 units ≈ 30 AU). */
const SOLAR_UNIT = 1.09;

/**
 * Zoom levels: nominal physical camera distance (AU) and the level's own unit (AU per
 * local unit). Each level is modelled in its own units and scaled so that one physical
 * length always maps to the same world length; "home" stays at the origin throughout.
 */
const LEVELS = [
  { name: 'Сонячна система', p: VIEW * SOLAR_UNIT, unit: SOLAR_UNIT },
  { name: 'Сусідні зорі', p: 25 * AU_PER_LY, unit: AU_PER_LY },
  { name: 'Чумацький Шлях', p: 115_000 * AU_PER_LY, unit: 1_000 * AU_PER_LY },
  { name: 'Місцева група', p: 3.1e6 * AU_PER_LY, unit: 1e4 * AU_PER_LY },
  { name: 'Космічна павутина', p: 7e8 * AU_PER_LY, unit: 1e6 * AU_PER_LY },
  { name: 'Спостережуваний Всесвіт', p: 1.35e11 * AU_PER_LY, unit: 1e9 * AU_PER_LY },
];
const LOG_P = LEVELS.map((l) => Math.log10(l.p));

/**
 * Voyager 1: ecliptic latitude ≈ +35°, about 171 AU out in late 2026; it crossed the
 * heliopause, into interstellar space, at 121.6 AU in August 2012. The planets' longitudes
 * here are not the real ones, so the path is turned side-on to the default view (lon 180°)
 * to show its full length; the latitude is real.
 */
const VOYAGER = { lon: 180, lat: 34.9, au: 171, heliopauseAu: 121.6 };
const voyagerDir = () => {
  const lon = THREE.MathUtils.degToRad(VOYAGER.lon);
  const lat = THREE.MathUtils.degToRad(VOYAGER.lat);
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
};
export const ZOOM_LEVELS = LEVELS.map((l) => l.name);
const MAX_Z = LEVELS.length - 1;

export interface ZoomLabel {
  x: number;
  y: number;
  text: string;
  sub?: string;
  kind: 'home' | 'object' | 'ring';
  opacity: number;
  /** Text to the left of the dot (avoids collisions). */
  left?: boolean;
}

export interface ZoomHud {
  z: number;
  labels: ZoomLabel[];
  /** Physical size of one CSS pixel at the focus, in AU (for the scale bar). */
  auPerPx: number;
}

interface LevelView {
  group: THREE.Group;
  materials: THREE.ShaderMaterial[];
  lines: THREE.LineBasicMaterial[];
  labels: {
    pos: THREE.Vector3;
    text: string;
    sub?: string;
    kind: ZoomLabel['kind'];
    left?: boolean;
    zRange?: [number, number];
    /** Shown only during «Політ». */
    motion?: boolean;
  }[];
}

// ---------------------------------------------------------------- shaders

/** Stars drawn at a constant angular size (they are points at every scale). */
function starMaterial(): THREE.ShaderMaterial {
  return additiveMaterial(
    /* glsl */ `
      ${POINT_SIZE}
      uniform float uFade;
      attribute vec3 aColor;
      attribute float aSize;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vColor = aColor;
        vAlpha = uFade;
        gl_PointSize = min(pointSize(-mv.z * aSize, -mv.z, vAlpha), 22.0);
        gl_Position = projectionMatrix * mv;
      }`,
    /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float d = dot(c, c);
        if (d > 1.0) discard;
        // A white-hot core inside a halo of the star's own colour, so red dwarfs read as
        // red and Sirius as blue-white instead of every star bleaching to white.
        float core = exp(-d * 22.0);
        float halo = exp(-d * 4.0);
        vec3 col = vColor * halo * 0.85 + mix(vColor, vec3(1.0), 0.45) * core * 1.1;
        gl_FragColor = vec4(col, vAlpha);
      }`,
    { uFade: { value: 0 } },
  );
}

/** Diffuse matter (galaxies, filaments): sizes in the level's units, scaled with it. */
function matterMaterial(maxPx = 7): THREE.ShaderMaterial {
  return additiveMaterial(
    /* glsl */ `
      ${POINT_SIZE}
      uniform float uFade;
      uniform float uScale;
      attribute vec3 aColor;
      attribute float aSize;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float viewZ = -mv.z;
        vColor = aColor;
        vAlpha = uFade * smoothstep(0.5, 6.0, viewZ);
        gl_PointSize = min(pointSize(aSize * uScale, viewZ, vAlpha), ${maxPx.toFixed(1)});
        gl_Position = projectionMatrix * mv;
      }`,
    POINT_FRAG,
    { uFade: { value: 0 }, uScale: { value: 1 } },
  );
}

/** Dark dust: normal-blended points that dim the light behind them. */
function dustMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 0 }, uScale: { value: 1 }, uViewScale: globalUniforms.uViewScale },
    vertexShader: /* glsl */ `
      ${POINT_SIZE}
      uniform float uFade;
      uniform float uScale;
      attribute float aSize;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vAlpha = uFade * 0.35 * smoothstep(0.5, 6.0, -mv.z);
        gl_PointSize = min(pointSize(aSize * uScale, -mv.z, vAlpha), 14.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float d = dot(c, c);
        if (d > 1.0) discard;
        gl_FragColor = vec4(0.03, 0.02, 0.015, exp(-d * 3.0) * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

function pointsFrom(
  positions: number[],
  colors: number[],
  sizes: number[],
  material: THREE.ShaderMaterial,
): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors.length) g.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  const p = new THREE.Points(g, material);
  p.frustumCulled = false;
  return p;
}

const hex = (h: string) => new THREE.Color(h);

/**
 * Animated flow lines for «Політ»: comet-like dashes stream from the first point of each
 * path to its last, showing which way things are moving. Hidden unless motion is on.
 */
function flowLines(
  paths: THREE.Vector3[][],
  color: string,
  motion: { value: number },
  opts: { dashes?: number; speed?: number; bright?: number } = {},
): { object: THREE.LineSegments; material: THREE.ShaderMaterial } {
  const pos: number[] = [];
  const along: number[] = [];
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      along.push(i / (path.length - 1), (i + 1) / (path.length - 1));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('aT', new THREE.Float32BufferAttribute(along, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uFade: { value: 0 },
      uMotion: motion,
      uTime: globalUniforms.uTime,
      uColor: { value: new THREE.Color(color) },
      uDashes: { value: opts.dashes ?? 6 },
      uSpeed: { value: opts.speed ?? 0.5 },
      uBright: { value: opts.bright ?? 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aT;
      varying float vT;
      void main() {
        vT = aT;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFade;
      uniform float uMotion;
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uDashes;
      uniform float uSpeed;
      uniform float uBright;
      varying float vT;
      void main() {
        float f = fract(vT * uDashes - uTime * uSpeed);
        // A bright head with a fading tail, moving towards the end of the path.
        float dash = smoothstep(0.0, 0.7, f) * (1.0 - smoothstep(0.7, 0.8, f));
        float ends = sin(3.14159 * vT);
        gl_FragColor = vec4(uColor * (0.15 + dash) * ends * uFade * uMotion * uBright, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;
  return { object, material };
}

/** A straight path a to b sampled into n points. */
const segment = (a: THREE.Vector3, b: THREE.Vector3, n = 24) => Array.from({ length: n }, (_, i) => a.clone().lerp(b, i / (n - 1)));

/** Direction of the Great Attractor / our motion in the level-4 and level-5 frames. */
const ATTRACTOR_DIR = new THREE.Vector3(0.25, -0.3, 0.92).normalize();
/** Our motion relative to the CMB (the dipole), in the level-5 frame. */
const DIPOLE_DIR = new THREE.Vector3(-0.6, 0.5, 0.62).normalize();

/** One caption per level when «Політ» is on. */
const MOTION_CAPTIONS: Record<number, string> = {
  1: 'Сонце летить до зорі Вега: 20 км/с',
  2: 'Галактика обертається: оберт за 230 млн років',
  3: 'Андромеда наближається: 110 км/с',
  4: 'Нас тягне до Великого Атрактора: 600 км/с',
  5: 'Відносно реліктового світла: 370 км/с',
};

/** RA/Dec (degrees) + distance → local Cartesian (y up). */
function sky(raDeg: number, decDeg: number, d: number): THREE.Vector3 {
  const ra = THREE.MathUtils.degToRad(raDeg);
  const dec = THREE.MathUtils.degToRad(decDeg);
  return new THREE.Vector3(d * Math.cos(dec) * Math.cos(ra), d * Math.sin(dec), -d * Math.cos(dec) * Math.sin(ra));
}

// ---------------------------------------------------------------- galaxy generators

interface Spiral {
  count: number;
  radius: number;
  arms: number;
  wind: number;
  bar: number;
  center: THREE.Vector3;
  quat: THREE.Quaternion;
  size: number;
  brightness: number;
  core: THREE.Color;
  arm: THREE.Color;
}

function spiral(rand: () => number, s: Spiral, out: { p: number[]; c: number[]; z: number[] }): void {
  const v = new THREE.Vector3();
  const col = new THREE.Color();
  const hii = hex(config.colors.galaxyHII);
  const old = hex('#ffe2b8');
  for (let i = 0; i < s.count; i++) {
    const roll = rand();
    const R = s.radius;
    let b = s.brightness;
    if (roll < 0.12) {
      v.set(gaussian(rand), gaussian(rand) * 0.55, gaussian(rand)).multiplyScalar(R * 0.045);
      col.copy(s.core);
      b *= 1.6;
    } else if (roll < 0.12 + s.bar * 0.12) {
      v.set((rand() * 2 - 1) * R * 0.24 + gaussian(rand) * R * 0.02, gaussian(rand) * R * 0.01, gaussian(rand) * R * 0.04);
      v.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.47);
      col.copy(s.core);
      b *= 1.3;
    } else if (roll < 0.75) {
      const arm = Math.floor(rand() * s.arms);
      const major = arm < 2;
      const r = Math.min(R * 1.05, R * 0.09 + -Math.log(1 - rand() * 0.985) * R * 0.22);
      const spread = gaussian(rand) * (major ? 0.16 : 0.22);
      const ang = (arm / s.arms) * Math.PI * 2 + 0.47 + Math.log(r / (R * 0.09)) * s.wind + spread;
      v.set(Math.cos(ang) * r, gaussian(rand) * R * 0.007, Math.sin(ang) * r);
      const k = rand();
      col.copy(k < 0.05 ? hii : s.arm);
      b *= major ? 1.1 : 0.8;
    } else {
      const r = R * 0.1 + -Math.log(1 - rand() * 0.98) * R * 0.26;
      const ang = rand() * Math.PI * 2;
      v.set(Math.cos(ang) * r, gaussian(rand) * R * 0.01, Math.sin(ang) * r);
      col.copy(old);
      b *= 0.45;
    }
    v.applyQuaternion(s.quat).add(s.center);
    out.p.push(v.x, v.y, v.z);
    const bb = b * (0.6 + rand() * 0.8);
    out.c.push(col.r * bb, col.g * bb, col.b * bb);
    out.z.push(s.size * (0.6 + rand() * 0.8));
  }
}

/** Irregular blob (Magellanic Clouds, dwarfs). */
function blob(rand: () => number, center: THREE.Vector3, r: number, count: number, color: THREE.Color, size: number, b: number, out: { p: number[]; c: number[]; z: number[] }): void {
  for (let i = 0; i < count; i++) {
    out.p.push(center.x + gaussian(rand) * r, center.y + gaussian(rand) * r * 0.55, center.z + gaussian(rand) * r * 0.8);
    const bb = b * (0.5 + rand());
    out.c.push(color.r * bb, color.g * bb, color.b * bb);
    out.z.push(size * (0.6 + rand() * 0.8));
  }
}

// ---------------------------------------------------------------- scene

/**
 * «Космічний зум»: from the Solar System out through the nearest stars, the Milky Way,
 * the Local Group, to the cosmic web, and back. Driven by the mouse wheel past the
 * Solar System's zoom limit, by the level navigator, or by Z / X.
 */
export class CosmicZoom implements SceneModule {
  readonly name = 'zoom' as const;
  readonly group = new THREE.Group();
  active = false;

  /** Current and requested zoom position: 0 = Solar System … 4 = cosmic web. */
  z = 0;
  target = 0;
  onHud: (hud: ZoomHud) => void = () => {};
  /** One-off caption (shown when the observable Universe comes into view). */
  onCaption: (text: string) => void = () => {};
  private cmbToldAt = -1;
  /** Cinematic flight back to the Solar System («Додому»). */
  private homeTween: gsap.core.Tween | null = null;

  private levels: LevelView[] = [];
  /** «Політ» at cosmic scales: everything here is moving too. */
  motion = false;
  onMotion: (on: boolean) => void = () => {};
  private motionU = { value: 0 };
  private motionLevel = -1;
  /** Rotation of the Milky Way about its centre (level 2) while flying. */
  private galaxyTurn = 0;
  private galaxyCenter = new THREE.Vector3(-26, 0, 0);
  private tmpQ = new THREE.Quaternion();
  private yAxis = new THREE.Vector3(0, 1, 0);
  /** Voyager 1's path out of the Solar System, in Solar-System units (scaled with it). */
  private voyager = new THREE.Group();
  private voyagerLine: THREE.LineDashedMaterial;
  /** The CMB shell: faded out while the camera passes through its surface. */
  private shell!: { mat: THREE.ShaderMaterial; radius: number };
  private dist = VIEW;
  private lastTarget = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private zero = new THREE.Vector3();
  private engaged = false;
  private labelsOut: ZoomLabel[] = [];
  private mwCenter = new THREE.Vector3(-26_000 * AU_PER_LY, 0, 0);
  private lgCenter: THREE.Vector3;

  constructor(
    private ctx: Ctx,
    private solar: () => Solar,
  ) {
    const m31 = new THREE.Vector3(0.32, 0.22, -0.92).normalize();
    this.lgCenter = m31.clone().multiplyScalar(2.5e6 * 0.5 * AU_PER_LY);
    this.levels.push(this.buildNeighbours(), this.buildMilkyWay(), this.buildLocalGroup(m31), this.buildWeb(), this.buildUniverse());
    for (const l of this.levels) {
      l.group.visible = false;
      this.group.add(l.group);
    }

    const end = voyagerDir().multiplyScalar(VOYAGER.au / SOLAR_UNIT);
    const path = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]);
    this.voyagerLine = new THREE.LineDashedMaterial({ color: 0xffd9a0, dashSize: 2.2, gapSize: 1.6, transparent: true, opacity: 0, depthWrite: false });
    const line = new THREE.Line(path, this.voyagerLine);
    line.computeLineDistances();
    line.frustumCulled = false;
    this.voyager.add(line);
    this.voyager.visible = false;
    this.group.add(this.voyager);
  }

  /** Visibility of the Voyager overlay: just past the Kuiper belt, before the Oort cloud. */
  private voyagerWeight(z: number): number {
    return smooth(0.06, 0.12, z) * (1 - smooth(0.26, 0.34, z));
  }

  // ---------------------------------------------------------------- level 1: neighbours

  private buildNeighbours(): LevelView {
    const group = new THREE.Group();
    const stars = [
      { n: 'Сонце', ra: 0, dec: 0, d: 0, c: '#ffe7b0', s: 1.1 },
      { n: 'Альфа Центавра', sub: '4,2–4,4 св. р. · три зорі', ra: 219.9, dec: -60.8, d: 4.37, c: '#ffe4a8', s: 1.2 },
      { n: '', ra: 217.4, dec: -62.7, d: 4.24, c: '#ff6a3a', s: 0.5 },
      { n: 'Зоря Барнарда', sub: '6 св. р.', ra: 269.5, dec: 4.7, d: 5.96, c: '#ff6f42', s: 0.5 },
      { n: 'Вольф 359', sub: '7,9 св. р.', ra: 164.1, dec: 7.0, d: 7.9, c: '#ff5a36', s: 0.42, left: true },
      { n: 'Лаланд 21185', sub: '8,3 св. р.', ra: 165.8, dec: 36.0, d: 8.3, c: '#ff7a48', s: 0.5 },
      { n: 'Сіріус', sub: '8,6 св. р.', ra: 101.3, dec: -16.7, d: 8.6, c: '#a9c6ff', s: 1.8 },
      { n: 'Епсилон Ерідана', sub: '10,5 св. р.', ra: 53.2, dec: -9.5, d: 10.5, c: '#ffb066', s: 0.75 },
      { n: 'Процион', sub: '11,4 св. р.', ra: 114.8, dec: 5.2, d: 11.4, c: '#fff0c8', s: 1.25 },
      { n: '61 Лебедя', sub: '11,4 св. р.', ra: 316.7, dec: 38.7, d: 11.4, c: '#ff9550', s: 0.65 },
      { n: 'Тау Кита', sub: '11,9 св. р.', ra: 26.0, dec: -15.9, d: 11.9, c: '#ffd590', s: 0.85 },
    ];
    const p: number[] = [];
    const c: number[] = [];
    const z: number[] = [];
    const labels: LevelView['labels'] = [];
    for (const s of stars) {
      const v = sky(s.ra, s.dec, s.d);
      const col = hex(s.c).multiplyScalar(1.15);
      p.push(v.x, v.y, v.z);
      c.push(col.r, col.g, col.b);
      z.push(0.009 * s.s);
      if (s.n) labels.push({ pos: v, text: s.n, sub: s.sub, kind: s.d === 0 ? 'home' : 'object', left: 'left' in s ? s.left : false });
    }
    // Plenty of faint red dwarfs we cannot see with the naked eye.
    const rand = mulberry32(4242);
    for (let i = 0; i < 380; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(4 + Math.cbrt(rand()) * 18);
      const col = hex(rand() < 0.75 ? '#ff6a40' : rand() < 0.5 ? '#ffc070' : '#c4d6ff').multiplyScalar(0.6 + rand() * 0.45);
      p.push(v.x, v.y, v.z);
      c.push(col.r, col.g, col.b);
      z.push(0.0035 + rand() * 0.0025);
    }
    // The Oort cloud: a vast sphere of icy bodies out to ~1.6 light-years, flattened near
    // its inner edge (the Hills cloud). We fly through it on the way to the stars.
    for (let i = 0; i < 7000; i++) {
      const r = 0.03 + Math.pow(rand(), 0.6) * 1.6;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(r);
      if (r < 0.35) v.y *= 0.45;
      const k = 0.35 + rand() * 0.35;
      p.push(v.x, v.y, v.z);
      c.push(0.42 * k, 0.5 * k, 0.68 * k);
      z.push(0.0022 + rand() * 0.0016);
    }
    labels.push({ pos: new THREE.Vector3(-1.2, -1.3, 0.4), text: 'Хмара Оорта', sub: 'до 1,6 св. р. · трильйони крижаних тіл', kind: 'object', left: true, zRange: [0.5, 1.25] });
    // Star-map stalks: a thin line from each named star down (or up) to the plane of the
    // distance rings, ending in a small foot, so its distance and height read at a glance.
    const stalk: number[] = [];
    for (const s of stars) {
      if (s.d === 0) continue;
      const v = sky(s.ra, s.dec, s.d);
      stalk.push(v.x, v.y, v.z, v.x, 0, v.z);
      p.push(v.x, 0, v.z);
      c.push(0.55, 0.62, 0.85);
      z.push(0.0035);
    }
    const mat = starMaterial();
    group.add(pointsFrom(p, c, z, mat));

    // Distance rings in the plane through the Sun.
    const lines: THREE.LineBasicMaterial[] = [];
    const stalkMat = new THREE.LineBasicMaterial({ color: 0x9aa6d8, transparent: true, opacity: 0, depthWrite: false });
    lines.push(stalkMat);
    const stalkGeo = new THREE.BufferGeometry();
    stalkGeo.setAttribute('position', new THREE.Float32BufferAttribute(stalk, 3));
    group.add(new THREE.LineSegments(stalkGeo, stalkMat));
    for (const r of [5, 10]) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 160; k++) {
        const a = (k / 160) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      const lm = new THREE.LineBasicMaterial({ color: 0x8b97c8, transparent: true, opacity: 0, depthWrite: false });
      lines.push(lm);
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lm));
      labels.push({ pos: new THREE.Vector3(r * 0.7071, 0, r * 0.7071), text: `${r} св. р.`, kind: 'ring' });
    }
    // The Sun's own drift through its neighbourhood: towards the solar apex near Vega.
    const apex = sky(271, 30, 3.4);
    const apexFlow = flowLines([segment(new THREE.Vector3(), apex)], '#ffe2a8', this.motionU, { dashes: 3, speed: 0.35, bright: 1.4 });
    group.add(apexFlow.object);
    labels.push({ pos: apex.clone().multiplyScalar(1.12), text: 'Сонячний апекс', sub: 'Сонце летить сюди · 20 км/с відносно сусідніх зір', kind: 'object', motion: true });
    return { group, materials: [mat, apexFlow.material], lines, labels };
  }

  // ---------------------------------------------------------------- level 2: Milky Way

  private buildMilkyWay(): LevelView {
    const group = new THREE.Group();
    const rand = mulberry32(1977);
    const center = new THREE.Vector3(-26, 0, 0);
    const out = { p: [] as number[], c: [] as number[], z: [] as number[] };
    spiral(rand, {
      count: Math.round(80000 * config.particleScale),
      radius: 50,
      arms: 4,
      wind: 3.0,
      bar: 1,
      center,
      quat: new THREE.Quaternion(),
      size: 0.38,
      brightness: 0.55,
      core: hex(config.colors.galaxyCore),
      arm: hex(config.colors.galaxyArm),
    }, out);
    // The Orion Spur: a short bridge of young stars where the Sun lives.
    // It follows the same spiral pitch as the arms and passes right through the Sun.
    const spurBase = -Math.log(26 / 4.5) * 3.0;
    for (let i = 0; i < 1800; i++) {
      const r = 21 + rand() * 10;
      const ang = spurBase + Math.log(r / 4.5) * 3.0 + gaussian(rand) * 0.035;
      const v = new THREE.Vector3(Math.cos(ang) * r, gaussian(rand) * 0.2, Math.sin(ang) * r).add(center);
      out.p.push(v.x, v.y, v.z);
      const col = hex(config.colors.galaxyArm).multiplyScalar(0.45 + rand() * 0.5);
      out.c.push(col.r, col.g, col.b);
      out.z.push(0.3);
    }
    // Bright star-forming nebulae (glowing hydrogen) along the arms near us.
    // Galactic longitude l is measured from the direction of the centre.
    const nebDir = (lDeg: number, kly: number) => {
      const l = THREE.MathUtils.degToRad(lDeg);
      return new THREE.Vector3(-Math.cos(l), 0, -Math.sin(l)).multiplyScalar(kly);
    };
    const nebulae = [
      { at: nebDir(209, 1.34), r: 0.22, a: '#ff5d8f', b: '#4fe0d0' },
      { at: nebDir(17, 5.7), r: 0.3, a: '#ff4f7a', b: '#ffb070' },
      { at: nebDir(6, 4.1), r: 0.28, a: '#ff6a95', b: '#ff9aa8' },
      { at: nebDir(287.6, 8.5), r: 0.4, a: '#ff4f74', b: '#7fd8ff' },
    ];
    for (const n of nebulae) {
      for (let i = 0; i < 550; i++) {
        const v = new THREE.Vector3(gaussian(rand), gaussian(rand) * 0.5, gaussian(rand)).multiplyScalar(n.r).add(n.at);
        out.p.push(v.x, v.y, v.z);
        const col = hex(rand() < 0.75 ? n.a : n.b).multiplyScalar(1.1 + rand() * 0.8);
        out.c.push(col.r, col.g, col.b);
        out.z.push(0.32);
      }
    }
    const mat = matterMaterial();
    group.add(pointsFrom(out.p, out.c, out.z, mat));

    // Dust lanes on the inner edges of the arms.
    const dust: number[] = [];
    const dz: number[] = [];
    for (let i = 0; i < 16000; i++) {
      const arm = Math.floor(rand() * 4);
      const r = 6 + Math.pow(rand(), 0.9) * 32;
      const ang = (arm / 4) * Math.PI * 2 + 0.47 + Math.log(r / 4.5) * 3.0 - 0.14 + gaussian(rand) * 0.05;
      dust.push(Math.cos(ang) * r + center.x, gaussian(rand) * 0.15, Math.sin(ang) * r + center.z);
      dz.push(0.9 + rand() * 0.8);
    }
    const dmat = dustMaterial();
    group.add(pointsFrom(dust, [], dz, dmat));

    // The Sun's path around the centre: one lap takes ~230 million years. Bright where we
    // are, fading along the arc behind us, with a short arrow of motion ahead.
    const orbitR = 26;
    const orbitPts: number[] = [];
    const orbitT: number[] = [];
    const SEG = 360;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      // The Sun moves towards galactic longitude 90° (−z here): start a little ahead of it
      // and run backwards round the full circle.
      const a = t * Math.PI * 2 - 0.12;
      orbitPts.push(center.x + Math.cos(a) * orbitR, 0, Math.sin(a) * orbitR);
      orbitT.push(t * Math.PI * 2 - 0.12);
    }
    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.Float32BufferAttribute(orbitPts, 3));
    orbitGeo.setAttribute('aT', new THREE.Float32BufferAttribute(orbitT, 1));
    const orbitMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0 }, uTime: globalUniforms.uTime },
      vertexShader: /* glsl */ `
        attribute float aT;
        varying float vT;
        void main() {
          vT = aT;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFade;
        uniform float uTime;
        varying float vT;
        void main() {
          // vT: radians travelled behind the Sun (negative = ahead of it).
          float behind = max(vT, 0.0);
          float trail = 0.16 + 0.84 * exp(-behind * 0.55);
          float ahead = vT < 0.0 ? smoothstep(-0.12, -0.02, vT) : 1.0;
          // Pulses running forward along the path show the direction of motion.
          float pulse = 0.75 + 0.25 * sin(vT * 26.0 + uTime * 2.2);
          vec3 col = vec3(1.0, 0.86, 0.55);
          gl_FragColor = vec4(col * trail * ahead * pulse * uFade * 1.8, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // Two hairlines a hair apart read as one steady line on any pixel density.
    for (const dy of [0, 0.05]) {
      const orbitLine = new THREE.Line(orbitGeo, orbitMat);
      orbitLine.position.y = dy;
      orbitLine.frustumCulled = false;
      group.add(orbitLine);
    }
    const orbitLabelA = Math.PI * 0.62;

    return {
      group,
      materials: [mat, dmat, orbitMat],
      lines: [],
      labels: [
        { pos: new THREE.Vector3(0, 0, 0), text: 'Ви тут', sub: 'рукав Оріона', kind: 'home' },
        { pos: center.clone(), text: 'Центр Галактики', sub: '26 000 св. р.', kind: 'object', left: true },
        { pos: new THREE.Vector3(-Math.cos(3.648), 0, -Math.sin(3.648)).multiplyScalar(1.34), text: 'Туманність Оріона', sub: '1 340 св. р.', kind: 'object', zRange: [1.35, 1.8] },
        { pos: new THREE.Vector3(-Math.cos(0.297), 0, -Math.sin(0.297)).multiplyScalar(5.7), text: 'Туманність Орел', sub: '5 700 св. р.', kind: 'object', left: true },
        { pos: new THREE.Vector3(-Math.cos(5.019), 0, -Math.sin(5.019)).multiplyScalar(8.5), text: 'Туманність Кіля', sub: '8 500 св. р.', kind: 'object' },
        { pos: new THREE.Vector3(center.x + Math.cos(orbitLabelA) * orbitR, 0, Math.sin(orbitLabelA) * orbitR), text: 'Орбіта Сонця', sub: '1 оберт ≈ 230 млн років', kind: 'object', zRange: [1.6, 2.6] },
      ],
    };
  }

  // ---------------------------------------------------------------- level 3: Local Group

  private buildLocalGroup(m31dir: THREE.Vector3): LevelView {
    const group = new THREE.Group();
    const rand = mulberry32(31);
    const out = { p: [] as number[], c: [] as number[], z: [] as number[] };
    const mw = new THREE.Vector3(-2.6, 0, 0);
    spiral(rand, {
      count: Math.round(16000 * config.particleScale), radius: 5, arms: 4, wind: 3.0, bar: 1, center: mw,
      quat: new THREE.Quaternion(), size: 0.16, brightness: 1.0,
      core: hex(config.colors.galaxyCore), arm: hex(config.colors.galaxyArm),
    }, out);
    const m31 = m31dir.clone().multiplyScalar(250);
    spiral(rand, {
      count: Math.round(24000 * config.particleScale), radius: 11, arms: 2, wind: 2.2, bar: 0.3, center: m31,
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(1.2, 0.6, 0.2)), size: 0.3, brightness: 0.95,
      core: hex('#ffd9a8'), arm: hex('#a8bcff'),
    }, out);
    const m33 = m31.clone().add(new THREE.Vector3(55, -35, 30));
    spiral(rand, {
      count: Math.round(6000 * config.particleScale), radius: 3, arms: 2, wind: 1.8, bar: 0, center: m33,
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, -0.3, 0.4)), size: 0.14, brightness: 0.9,
      core: hex('#ffe0b8'), arm: hex('#9fc0ff'),
    }, out);
    const lmc = new THREE.Vector3(-0.5, -0.8, 0.3).normalize().multiplyScalar(16).add(mw);
    const smc = new THREE.Vector3(-0.3, -0.9, 0.45).normalize().multiplyScalar(20).add(mw);
    blob(rand, lmc, 0.7, 2500, hex('#b8c8ff'), 0.09, 0.9, out);
    blob(rand, smc, 0.4, 1300, hex('#c8d4ff'), 0.08, 0.8, out);
    // Andromeda's companions M32 and M110.
    blob(rand, m31.clone().add(new THREE.Vector3(2.6, -0.9, 1.8)), 0.35, 700, hex('#ffe0b0'), 0.1, 1.0, out);
    blob(rand, m31.clone().add(new THREE.Vector3(-6.5, 3.5, -2.5)), 0.7, 900, hex('#f0dcc0'), 0.1, 0.8, out);
    // The Magellanic Bridge between the Clouds and the long gaseous Magellanic Stream.
    for (let i = 0; i < 700; i++) {
      const v = new THREE.Vector3().lerpVectors(lmc, smc, rand()).add(new THREE.Vector3(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(0.25));
      out.p.push(v.x, v.y, v.z);
      out.c.push(0.35, 0.45, 0.75);
      out.z.push(0.07);
    }
    for (let i = 0; i < 1400; i++) {
      const t = rand();
      const ang = t * 2.4;
      const v = new THREE.Vector3(Math.cos(ang) * 16, -6 + t * 18, Math.sin(ang) * 16).add(mw).add(new THREE.Vector3(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(0.6));
      const k = 0.25 * (1 - t * 0.6);
      out.p.push(v.x, v.y, v.z);
      out.c.push(0.5 * k, 0.75 * k, 1.0 * k);
      out.z.push(0.12);
    }
    for (let i = 0; i < 28; i++) {
      const at = new THREE.Vector3().randomDirection().multiplyScalar(40 + rand() * 330).add(m31.clone().multiplyScalar(rand() * 0.6));
      blob(rand, at, 0.4 + rand() * 0.6, 60, hex('#d8d0c4'), 0.12, 0.55, out);
    }
    const mat = matterMaterial();
    group.add(pointsFrom(out.p, out.c, out.z, mat));
    // The Milky Way and Andromeda falling towards each other.
    const mid = mw.clone().lerp(m31, 0.5);
    const toward = (from: THREE.Vector3) => segment(from.clone().lerp(mid, 0.08), from.clone().lerp(mid, 0.82));
    const approach = flowLines([toward(mw), toward(m31)], '#ffd9a0', this.motionU, { dashes: 5, speed: 0.4, bright: 1.6 });
    group.add(approach.object);
    return {
      group,
      materials: [mat, approach.material],
      lines: [],
      labels: [
        { pos: mid, text: 'Зближуються · 110 км/с', sub: 'зіткнення через ≈4,5 млрд років', kind: 'ring', motion: true },
        { pos: mw, text: 'Чумацький Шлях', sub: 'ми тут', kind: 'home' },
        { pos: m31, text: 'Андромеда', sub: '2,5 млн св. р.', kind: 'object' },
        { pos: m33, text: 'Галактика Трикутника', sub: '2,7 млн св. р.', kind: 'object' },
        { pos: lmc, text: 'Магелланові Хмари', sub: '160 тис. св. р.', kind: 'object', left: true },
      ],
    };
  }

  // ---------------------------------------------------------------- level 4: cosmic web

  private buildWeb(): LevelView {
    const group = new THREE.Group();
    const rand = mulberry32(2718);
    const virgo = new THREE.Vector3(-0.6, 0.25, -0.76).normalize().multiplyScalar(54);
    const nodes: THREE.Vector3[] = [new THREE.Vector3(), virgo];
    let guard = 0;
    while (nodes.length < 56 && guard++ < 4000) {
      const v = new THREE.Vector3((rand() * 2 - 1) * 460, (rand() * 2 - 1) * 230, (rand() * 2 - 1) * 460);
      if (nodes.some((n) => n.distanceTo(v) < 70)) continue;
      nodes.push(v);
    }
    const edges: [THREE.Vector3, THREE.Vector3][] = [];
    const seen = new Set<string>();
    nodes.forEach((n, i) => {
      nodes
        .map((m, j) => ({ j, d: m.distanceTo(n) }))
        .filter((e) => e.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .forEach(({ j }) => {
          const key = i < j ? `${i}-${j}` : `${j}-${i}`;
          if (seen.has(key)) return;
          seen.add(key);
          edges.push([n, nodes[j]]);
        });
    });
    // Filaments sag and curve rather than running dead straight.
    const bends = edges.map(() => new THREE.Vector3(gaussian(rand), gaussian(rand) * 0.6, gaussian(rand)).multiplyScalar(22));
    const p: number[] = [];
    const c: number[] = [];
    const z: number[] = [];
    const fil = hex(config.colors.filament);
    const warm = hex('#ffd2a0');
    const count = Math.round(70000 * config.particleScale);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      let col: THREE.Color;
      let b: number;
      if (rand() < 0.28) {
        const n = nodes[Math.floor(rand() * nodes.length)];
        v.set(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(7).add(n);
        col = warm;
        b = 0.9;
      } else {
        const ei = Math.floor(rand() * edges.length);
        const [a, bb] = edges[ei];
        const t = rand();
        const thick = 3 + 5 * Math.abs(t - 0.5);
        v.lerpVectors(a, bb, t).addScaledVector(bends[ei], Math.sin(t * Math.PI));
        v.x += gaussian(rand) * thick;
        v.y += gaussian(rand) * thick;
        v.z += gaussian(rand) * thick;
        col = fil;
        b = 0.55;
      }
      const k = b * (0.5 + rand() * 0.8);
      p.push(v.x, v.y, v.z);
      c.push(col.r * k, col.g * k, col.b * k);
      z.push(1.8 + rand() * 1.6);
    }
    const mat = matterMaterial(6);
    group.add(pointsFrom(p, c, z, mat));
    // Galaxies and clusters streaming towards the Great Attractor, ourselves included.
    const attractor = ATTRACTOR_DIR.clone().multiplyScalar(250);
    const streams: THREE.Vector3[][] = [];
    const frand = mulberry32(600);
    for (let i = 0; i < 90; i++) {
      const start = new THREE.Vector3().randomDirection().multiplyScalar(80 + frand() * 260).add(attractor.clone().multiplyScalar(0.2));
      if (start.distanceTo(attractor) < 90) continue;
      streams.push(segment(start, start.clone().lerp(attractor, 0.3 + frand() * 0.15), 18));
    }
    const flow = flowLines(streams, '#9fc4ff', this.motionU, { dashes: 3, speed: 0.3, bright: 0.9 });
    const ours = flowLines([segment(new THREE.Vector3(), attractor.clone().multiplyScalar(0.45), 24)], '#ffd9a0', this.motionU, { dashes: 4, speed: 0.35, bright: 1.8 });
    group.add(flow.object, ours.object);
    return {
      group,
      materials: [mat, flow.material, ours.material],
      lines: [],
      labels: [
        { pos: attractor, text: 'Великий Атрактор', sub: '≈250 млн св. р. · сюди течуть галактики', kind: 'object', motion: true },
        { pos: new THREE.Vector3(), text: 'Місцева група', sub: 'ми тут', kind: 'home' },
        { pos: virgo, text: 'Скупчення Діви', sub: '54 млн св. р.', kind: 'object', left: true },
        { pos: new THREE.Vector3(0.25, -0.3, 0.92).normalize().multiplyScalar(170), text: 'Ланіакея', sub: 'наше надскупчення · 520 млн св. р.', kind: 'object' },
      ],
    };
  }

  // ---------------------------------------------------------------- level 5: observable universe

  private buildUniverse(): LevelView {
    const group = new THREE.Group();
    const rand = mulberry32(13800);
    const R = 46.5;
    // The last-scattering surface seen from outside: the CMB as a glowing shell.
    const shellMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0 }, uNear: { value: 1 }, uMotion: this.motionU, uDipole: { value: DIPOLE_DIR.clone() } },
      vertexShader: /* glsl */ `
        varying vec3 vObj;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        void main() {
          vObj = normalize(position);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPosW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        uniform float uFade;
        uniform float uNear;
        uniform float uMotion;
        uniform vec3 uDipole;
        varying vec3 vObj;
        varying vec3 vNormalW;
        varying vec3 vPosW;
        vec3 planck(float t) {
          t = clamp(t * 0.5 + 0.5, 0.0, 1.0);
          vec3 a = vec3(0.0, 0.03, 0.32);
          vec3 b = vec3(0.05, 0.42, 0.95);
          vec3 c = vec3(0.95, 0.93, 0.82);
          vec3 d = vec3(1.0, 0.52, 0.08);
          vec3 e = vec3(0.6, 0.04, 0.01);
          if (t < 0.25) return mix(a, b, t / 0.25);
          if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
          if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
          return mix(d, e, (t - 0.75) / 0.25);
        }
        void main() {
          // Exactly the pattern the film showed at recombination (Plasma scene, false colour).
          vec3 q = vObj * 17.0;
          float n = snoise(q * 0.18 + 4.0) * 0.4;
          n += fbm5(q + 3.7) * 1.25;
          n += snoise(q * 2.7 + 11.0) * 0.2;
          n += snoise(q * 5.9 - 7.0) * 0.1;
          vec3 col = planck(n * 2.1);
          // The CMB dipole: moving at 370 km/s, we see the light ahead slightly bluer and
          // hotter, the light behind redder (greatly exaggerated here so it shows).
          float dp = dot(vObj, uDipole);
          vec3 shift = dp > 0.0 ? vec3(0.62, 0.86, 1.5) : vec3(1.45, 0.82, 0.55);
          col *= mix(vec3(1.0), shift, abs(dp) * uMotion);
          vec3 V = normalize(cameraPosition - vPosW);
          float facing = clamp(abs(dot(normalize(vNormalW), V)), 0.0, 1.0);
          float rim = pow(1.0 - facing, 2.5);
          float k = gl_FrontFacing ? 0.03 + rim * 0.85 : 0.07 + rim * 0.1;
          gl_FragColor = vec4(max(col * k * uFade * uNear, 0.0), 1.0);
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), shellMat);
    shell.frustumCulled = false;
    group.add(shell);
    this.shell = { mat: shellMat, radius: R };

    // Large-scale structure filling the sphere: clusters and voids of galaxies.
    const centers: THREE.Vector3[] = [];
    for (let i = 0; i < 420; i++) centers.push(new THREE.Vector3().randomDirection().multiplyScalar(Math.cbrt(rand()) * (R - 2)));
    const p: number[] = [];
    const c: number[] = [];
    const z: number[] = [];
    const count = Math.round(26000 * config.particleScale);
    const fil = hex(config.colors.filament);
    const warm = hex('#ffd2a0');
    for (let i = 0; i < count; i++) {
      let v: THREE.Vector3;
      let col: THREE.Color;
      let b: number;
      if (rand() < 0.72) {
        const a = centers[Math.floor(rand() * centers.length)];
        v = new THREE.Vector3(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(0.9).add(a);
        col = rand() < 0.4 ? warm : fil;
        b = 0.32;
      } else {
        const a = centers[Math.floor(rand() * centers.length)];
        const bb = centers[Math.floor(rand() * centers.length)];
        if (a.distanceTo(bb) > 12) { i--; continue; }
        v = new THREE.Vector3().lerpVectors(a, bb, rand()).add(new THREE.Vector3(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(0.5));
        col = fil;
        b = 0.22;
      }
      const k = b * (0.5 + rand() * 0.8);
      p.push(v.x, v.y, v.z);
      c.push(col.r * k, col.g * k, col.b * k);
      z.push(0.26 + rand() * 0.22);
    }
    const mat = matterMaterial(5);
    group.add(pointsFrom(p, c, z, mat));
    return {
      group,
      materials: [shellMat, mat],
      lines: [],
      labels: [
        { pos: new THREE.Vector3(), text: 'Ми тут', sub: 'у центрі нашого видимого Всесвіту', kind: 'home' },
        { pos: DIPOLE_DIR.clone().multiplyScalar(R), text: 'Ми летимо сюди', sub: '370 км/с відносно реліктового світла', kind: 'object', motion: true },
        { pos: new THREE.Vector3(0.0, 0.72, 0.69).normalize().multiplyScalar(R), text: 'Межа спостережуваного Всесвіту', sub: '46,5 млрд св. р. · реліктове випромінювання', kind: 'object' },
      ],
    };
  }

  // ---------------------------------------------------------------- zoom maths

  /** Physical camera distance (AU) for a zoom position: log-linear between levels. */
  private physical(z: number): number {
    const i = Math.min(MAX_Z - 1, Math.floor(z));
    const t = z - i;
    return Math.pow(10, lerp(LOG_P[i], LOG_P[i + 1], t));
  }

  /** Crossfade weight of level k (0 = Solar System). */
  private weight(k: number, z: number): number {
    if (k === 0) return 1 - smooth(0.3, 0.6, z);
    const fadeIn = smooth(k - 0.7, k - 0.4, z);
    const fadeOut = k === MAX_Z ? 1 : 1 - smooth(k + 0.3, k + 0.6, z);
    return fadeIn * fadeOut;
  }

  /** Physical point the camera looks at (AU): the Sun, then our Galaxy, then the Local Group. */
  private focusPoint(z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0).lerp(this.mwCenter, smooth(1.35, 2.0, z));
    out.lerp(this.lgCenter, smooth(2.4, 3.0, z));
    return out.lerp(this.zero, smooth(4.1, 4.7, z));
  }

  // ---------------------------------------------------------------- control

  /** Wheel past the Solar System's zoom limit (or any wheel while zoomed) drives the zoom. */
  private onWheel = (e: WheelEvent) => {
    const solar = this.solar();
    if (!this.active || !solar.isInteractive || solar.focusedIndex >= 0 || solar.comparing) return;
    const controls = solar.orbitControls;
    const dist = this.ctx.camera.position.distanceTo(controls.target);
    const zoomMode = this.target > 0 || this.z > 0.001;
    if (!zoomMode && !(e.deltaY > 0 && dist > controls.maxDistance - 2)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const delta = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
    this.setTarget(this.target + delta * 0.0011);
  };

  setTarget(z: number): void {
    this.homeTween?.kill();
    this.homeTween = null;
    this.target = THREE.MathUtils.clamp(z, 0, MAX_Z);
    if (this.target > 0 && !this.engaged) this.engage();
  }

  goTo(level: number): void {
    const solar = this.solar();
    if (solar.focusedIndex >= 0) solar.unfocus();
    this.setTarget(level);
  }

  /**
   * «Додому»: an unhurried flight back through every level to the Solar System, slow
   * enough for each level's labels to read on the way past.
   */
  goHome(): void {
    if (!this.engaged || this.z < 0.01) return;
    const solar = this.solar();
    if (solar.focusedIndex >= 0) solar.unfocus();
    this.homeTween?.kill();
    const state = { z: this.z };
    this.homeTween = gsap.to(state, {
      z: 0,
      duration: this.ctx.reducedMotion ? 1.6 : 1.6 + state.z,
      ease: 'power2.inOut',
      onUpdate: () => {
        this.z = this.target = state.z;
      },
      onComplete: () => {
        this.homeTween = null;
      },
    });
  }

  /** «Політ» while zoomed out: rotation, approach, flows and the CMB dipole. */
  setMotion(on: boolean): void {
    if (on === this.motion) return;
    this.motion = on;
    this.motionLevel = -1;
    this.onMotion(on);
  }

  get isHoming(): boolean {
    return this.homeTween !== null;
  }

  step(dir: 1 | -1): void {
    this.goTo(Math.round(this.target) + dir);
  }

  private engage(): void {
    const solar = this.solar();
    const controls = solar.orbitControls;
    this.engaged = true;
    controls.enableZoom = false;
    // Zooming out of the Solar System's flight carries on flying at every scale.
    if (solar.drifting) this.setMotion(true);
    this.lastTarget.copy(controls.target);
    this.dist = this.ctx.camera.position.distanceTo(controls.target);
  }

  private disengage(): void {
    const solar = this.solar();
    this.engaged = false;
    this.z = 0;
    solar.setZoom(1);
    solar.skyFade = 1;
    solar.orbitControls.enableZoom = true;
    solar.orbitControls.target.set(0, 0, 0);
    for (const l of this.levels) l.group.visible = false;
    this.voyager.visible = false;
    this.setMotion(false);
    this.galaxyTurn = 0;
  }

  // ---------------------------------------------------------------- lifecycle

  enter(): void {
    this.z = 0;
    this.target = 0;
    this.engaged = false;
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
  }

  exit(): void {
    this.homeTween?.kill();
    this.homeTween = null;
    window.removeEventListener('wheel', this.onWheel, { capture: true });
    if (this.engaged) this.disengage();
  }

  update(dt: number): void {
    const solar = this.solar();
    const cam = this.ctx.camera;
    if (!solar.isInteractive) return;

    if (this.engaged) {
      this.z += (this.target - this.z) * (1 - Math.exp(-dt * 2.4));
      if (Math.abs(this.target - this.z) < 1e-4) this.z = this.target;
      if (this.target === 0 && this.z < 0.002) this.disengage();
    }

    this.motionU.value += ((this.motion ? 1 : 0) - this.motionU.value) * Math.min(1, (dt || 1 / 60) * 2);
    // The Milky Way turns about its centre while we fly at its scale; zooming back in, it
    // eases to the nearest full turn so the neighbourhood lines up with the Sun again.
    if (this.motion && this.z > 1.7) this.galaxyTurn += dt * ((Math.PI * 2) / 150);
    else {
      const rest = Math.round(this.galaxyTurn / (Math.PI * 2)) * Math.PI * 2;
      this.galaxyTurn += (rest - this.galaxyTurn) * Math.min(1, (dt || 1 / 60) * 3);
    }

    if (this.engaged) {
      const P = this.physical(this.z);
      solar.setZoom(LEVELS[0].p / P);
      const vw = this.voyagerWeight(this.z);
      this.voyager.visible = vw > 0.002;
      this.voyager.scale.setScalar(LEVELS[0].p / P);
      this.voyagerLine.opacity = vw * 0.6;
      solar.skyFade = 1 - smooth(1.35, 1.85, this.z);
      this.levels.forEach((l, i) => {
        const k = i + 1;
        const w = this.weight(k, this.z);
        const s = (VIEW * LEVELS[k].unit) / P;
        l.group.visible = w > 0.002;
        l.group.scale.setScalar(s);
        if (k === 2) {
          // Rotate about the galactic centre: p' = R (p - c) + c, in the level's units.
          this.tmpQ.setFromAxisAngle(this.yAxis, this.galaxyTurn);
          l.group.quaternion.copy(this.tmpQ);
          l.group.position.copy(this.galaxyCenter).sub(this.tmp2.copy(this.galaxyCenter).applyQuaternion(this.tmpQ)).multiplyScalar(s);
        }
        l.group.updateMatrix();
        for (const m of l.materials) {
          m.uniforms.uFade.value = w;
          if (m.uniforms.uScale) m.uniforms.uScale.value = s;
        }
        for (const lm of l.lines) lm.opacity = w * 0.25;
      });

      // Keep the camera at a fixed distance from a focus that glides from the Sun to
      // the galactic centre and on to the Local Group; the user can still orbit.
      this.focusPoint(this.z, this.focus).multiplyScalar(VIEW / P);
      this.dist += (VIEW - this.dist) * Math.min(1, (dt || 1 / 60) * 2.5);
      const dir = this.tmp.subVectors(cam.position, this.lastTarget);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0.4, 1);
      dir.normalize();
      // While travelling outwards, rise above the galactic plane so the spiral reads face-on.
      const moving = Math.abs(this.target - this.z) > 0.01;
      if (moving && this.z > 1.2) {
        const lift = this.tmp2.set(dir.x * 0.45, 0.85, dir.z * 0.45).normalize();
        dir.lerp(lift, Math.min(1, (dt || 1 / 60) * 1.2) * smooth(1.2, 2.0, this.z)).normalize();
      }
      cam.position.copy(this.focus).addScaledVector(dir, this.dist);
      cam.lookAt(this.focus);

      // Flying through the last-scattering surface would flood the screen for a few
      // frames, so the shell dims away while the camera is close to it.
      const universe = this.levels[this.levels.length - 1].group;
      const ratio = cam.position.distanceTo(universe.position) / (this.shell.radius * universe.scale.x);
      // Seen from just outside it fills the whole screen, so it brightens more slowly there.
      this.shell.mat.uniforms.uNear.value = ratio < 1 ? smooth(0.03, 0.22, 1 - ratio) : smooth(0.03, 1.5, ratio - 1);
      solar.orbitControls.target.copy(this.focus);
      this.lastTarget.copy(this.focus);
    }

    // Arriving at the edge of the observable Universe: tie it back to the start of the film.
    if (this.engaged && this.z > 4.85 && this.cmbToldAt < 0) {
      this.cmbToldAt = this.z;
      this.onCaption('Межа — те саме світло, що вирвалося на волю');
    }
    if (this.z < 4.0) this.cmbToldAt = -1;

    // «Політ»: one line per level about how fast things move at that scale.
    if (this.engaged && this.motion) {
      const lvl = Math.round(this.z);
      if (lvl !== this.motionLevel && lvl >= 1 && Math.abs(this.z - lvl) < 0.2 && MOTION_CAPTIONS[lvl]) {
        this.motionLevel = lvl;
        const text = MOTION_CAPTIONS[lvl];
        // At the edge of the Universe the «same light» caption comes first.
        if (lvl === 5) gsap.delayedCall(6.5, () => this.motion && this.z > 4.5 && this.onCaption(text));
        else this.onCaption(text);
      }
    }

    this.emitHud();
  }

  private emitHud(): void {
    const cam = this.ctx.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.labelsOut.length = 0;
    if (this.engaged) {
      const P = this.physical(this.z);
      // Solar System scale: the Kuiper belt as we pull away from the planets.
      const s0 = LEVELS[0].p / P;
      if (this.z > 0.04 && this.z < 0.42) {
        const v = this.tmp.set(27, 0, 27).multiplyScalar(s0).project(cam);
        if (v.z <= 1) {
          this.labelsOut.push({ x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h, text: 'Пояс Койпера', sub: '30–50 а. о. · Плутон, Еріда', kind: 'object', opacity: smooth(0.04, 0.12, this.z) * (1 - smooth(0.32, 0.42, this.z)) });
        }
      }
      // Voyager 1 and the heliopause it crossed on the way out.
      const vw = this.voyagerWeight(this.z);
      if (vw > 0.05) {
        const marks = [
          { au: VOYAGER.au, text: 'Вояджер-1', sub: 'найдальший від Землі апарат · ≈171 а. о. · сигнал іде 23,7 год', kind: 'object' as const, left: true },
          { au: VOYAGER.heliopauseAu, text: 'Геліопауза · 121,6 а. о.', sub: 'межа сонячного вітру, перетнув у 2012 р.', kind: 'ring' as const, left: false },
        ];
        for (const m of marks) {
          const v = this.tmp.copy(voyagerDir()).multiplyScalar((m.au / SOLAR_UNIT) * s0).project(cam);
          if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
          this.labelsOut.push({ x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h, text: m.text, sub: m.sub, kind: m.kind, left: m.left, opacity: vw });
        }
      }
      this.levels.forEach((l, i) => {
        const k = i + 1;
        const wgt = this.weight(k, this.z);
        if (wgt < 0.12) return;
        // Positions go through the level's own transform (scale, and the galaxy's turn).
        for (const lb of l.labels) {
          if (lb.zRange && (this.z < lb.zRange[0] || this.z > lb.zRange[1])) continue;
          if (lb.motion && this.motionU.value < 0.05) continue;
          const v = this.tmp.copy(lb.pos).applyMatrix4(l.group.matrix).project(cam);
          if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
          this.labelsOut.push({
            x: (v.x * 0.5 + 0.5) * w,
            y: (1 - (v.y * 0.5 + 0.5)) * h,
            text: lb.text,
            sub: lb.sub,
            kind: lb.kind,
            left: lb.left,
            opacity: smooth(0.12, 0.6, wgt) * (lb.motion ? this.motionU.value : 1),
          });
        }
      });
    }
    const dist = cam.position.distanceTo(this.solar().orbitControls.target);
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist) / h;
    const auPerPx = worldPerPx * (this.engaged ? this.physical(this.z) / VIEW : SOLAR_UNIT);
    this.onHud({ z: this.engaged ? this.z : 0, labels: this.labelsOut, auPerPx });
  }

  dispose(): void {
    this.exit();
    disposeObject(this.group);
  }
}

