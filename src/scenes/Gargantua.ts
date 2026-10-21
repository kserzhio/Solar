import * as THREE from 'three';
import { gsap } from 'gsap';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NOISE, globalUniforms, mulberry32 } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CardInfo, CuriousScene } from './curious';
import { Glow, disposeObject, smooth } from './util';
import { ELLIS, LENS, PASSAGE_SPEED, SKIES, Wormhole, refreshSky, skyUniforms } from './wormhole';
import { lang } from '../i18n';

/** World units: the radius of a non-spinning hole of the same mass, 2M. */
const R_IN = 1.2;
const R_OUT = 18;
/**
 * Two looks for the hole, between which the viewer can switch (F): as in the film, and as
 * in nature. The film (as its renderer's paper tells) drew Gargantua spinning at a = 0.6, so
 * its shadow is nearly round, and left out the Doppler shift; nature, for a hole spinning
 * fast, has a lopsided shadow, the gas reaching in much closer, one side of the disk
 * blazing and the other dimmed and reddened, and far hotter colours.
 */
export type HoleLook = 'film' | 'physics';
const LOOKS = {
  film: { spin: 0.6, doppler: 0, beam: 3, hot: 0.92, thick: 0.6, steep: 0.65, tint: [0.85, 0.79, 0.68] },
  // (Brighter overall: with the shifts in full, most of the disk is dimmed.)
  physics: { spin: 0.98, doppler: 1, beam: 4, hot: 1.6, thick: 0.75, steep: 0.6, tint: [2.0, 2.0, 2.0] },
} as const;
/** Radius of the innermost stable circular orbit (M) for spin a: where the disk ends. */
function isco(a: number): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}
const LOOK_KEY = 'gargantua-look';
/**
 * How much of each new frame of the tracer goes into the running average while the view
 * holds still (lower: smoother, but moving gas trails a little).
 */
const ACCUM_ALPHA = 0.3;
/** The smallest fraction of the screen's resolution the tracer may drop to. */
const HOLE_SCALE_MIN = 0.45;
/** Seconds to ease from one look to the other. */
const LOOK_TIME = 1.5;
function loadLook(): HoleLook {
  try {
    return localStorage.getItem(LOOK_KEY) === 'physics' ? 'physics' : 'film';
  } catch {
    return 'film';
  }
}
/** Direction of the far, faint star that fills in the planets' lighting. */
const STAR = new THREE.Vector3(-0.5, 0.45, 0.74).normalize();
/** Distance from the hole when we come out of the wormhole. */
const START_DIST = 95;
/** The wormhole's mouth on this side: mesh radius (its throat is LENS times smaller). */
const MOUTH_R = 3;
/** Through the wormhole: seconds, and how far past the throat (in throat radii) we come out. */
const IN_TIME = 7.5;
// (Home is quicker: past the throat there is only our own sky to see until the Solar System
// takes over, so it does, soon after the throat, as close to the mouth as we went in.)
const OUT_TIME = 3.4;
/**
 * The way home runs without a halt: the flight up to the mouth arrives moving, the passage
 * sets off at that speed and comes out still moving, and the Solar System's camera carries
 * on at the same speed. These are the passage's easing slopes at its start and its end.
 */
const OUT_S0 = 0.8;
const OUT_S1 = 1.4;
/** Seconds before the passage ends that the hand-over (a quick dip to black) begins. */
const HANDOVER = 0.15;
const L_IN = 14;
const L_OUT = 2.4;
const FLY_TIME = 2.1;
/** Where a flight up to a wormhole stops (throat radii), as on our side. */
const MOUTH_RC = 2.6;

/** Light on the planets and orbits is hidden behind the hole's shadow and its disk. */
const OCCLUDE = /* glsl */ `
  float behindHole(vec3 C, vec3 X) {
    vec3 seg = X - C;
    float t = dot(-C, seg) / dot(seg, seg);
    float vis = 1.0;
    if (t > 0.0 && t < 1.0) vis = smoothstep(2.4, 3.1, length(C + seg * t));
    if (C.y * X.y < 0.0) {
      vec3 q = C + seg * (C.y / (C.y - X.y));
      float rq = length(q.xz);
      if (rq > ${R_IN.toFixed(1)} && rq < ${R_OUT.toFixed(1)}) vis *= 0.12;
    }
    return vis;
  }
`;

/**
 * The planets' look, shared by the ray tracer (which sees them lensed by the hole) and the
 * close-up meshes. kind: 0 Miller, 1 Mann, 2 Edmunds; o: unit position in the planet's own
 * turning frame; n: world normal; P: world position (the hole at the origin); view: towards
 * the camera. Needs NOISE.
 */
const PLANET_SHADE = /* glsl */ `
  float fbm(vec3 p) {
    return snoise(p) * 0.5 + snoise(p * 2.1) * 0.25 + snoise(p * 4.3) * 0.125 + snoise(p * 8.7) * 0.0625;
  }

  /**
   * Miller's planet: a shallow ocean world. What reads from orbit is light on water — the
   * disk's glint (with Fresnel), ripples breaking it up, and the giant tidal waves: long
   * crests running round the planet across the line to the hole (that is how tides lie),
   * capped with foam. Thin cloud above, blue haze at the limb.
   */
  vec3 shadeMiller(vec3 o, vec3 n, vec3 toHole, vec3 view, vec3 star, float diskLight, float time) {
    // Tidal waves: crests are circles round the planet–hole axis, bent a little by the sea floor.
    float u = dot(n, toHole);
    float warp = snoise(o * 1.7) * 0.6 + snoise(o * 4.1) * 0.15;
    float phase = u * 46.0 + warp * 2.2 - time * 0.22;
    float sw = 0.5 + 0.5 * sin(phase);
    float reach = smoothstep(0.0, 0.7, snoise(o * 0.9 + 11.0)) * smoothstep(-0.1, 0.5, snoise(o * vec3(5.0, 2.0, 5.0) + 4.0));
    float crest = pow(sw, 40.0) * reach;
    // The waves tilt the surface (towards / away from the hole), which moves the glint.
    vec3 across = toHole - n * u;
    vec3 nw = normalize(n - across * cos(phase) * pow(sw, 6.0) * reach * 0.35);
    // Ripples: fine, ever-shifting facets (only up close; from afar they average out).
  #ifndef PLANET_LOD
    vec3 rip = vec3(snoise(o * 46.0 + time * 0.3), snoise(o * 46.0 + 17.0 - time * 0.25), snoise(o * 46.0 + 31.0 + time * 0.2));
    rip += 0.5 * vec3(snoise(o * 120.0 + 3.0), snoise(o * 120.0 + 7.0), snoise(o * 120.0 + 13.0));
    nw = normalize(nw + (rip - nw * dot(rip, nw)) * 0.035);
  #endif

    float lh = max(dot(n, toHole) * 0.85 + 0.15, 0.0);
    float ls = max(dot(n, star), 0.0);
    // Water: dark teal, a little lighter where the shallow floor shows through.
    float floorShow = smoothstep(-0.4, 0.9, fbm(o * 1.8 + 5.0));
    vec3 water = mix(vec3(0.018, 0.045, 0.07), vec3(0.05, 0.1, 0.12), floorShow);
    vec3 col = water * (vec3(1.0, 0.8, 0.55) * (lh * 0.85 + 0.1) * diskLight + vec3(0.8, 0.9, 1.0) * ls * 0.3 + 0.02);
    // Glint of the disk on the water, sharp core and a broader sheen, stronger at grazing.
    vec3 hv = normalize(toHole + view);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nw, view), 0.0), 5.0);
    float g = pow(max(dot(nw, hv), 0.0), 260.0) * 3.5 + pow(max(dot(nw, hv), 0.0), 24.0) * 0.45;
    col += vec3(1.0, 0.86, 0.62) * g * (0.25 + fres) * diskLight * step(0.0, dot(n, toHole));
    // Haze of the atmosphere over the lit side.
    col += vec3(0.05, 0.09, 0.15) * lh * diskLight * 0.35;
    // The sky's own reflection: a cool sheen growing towards the limb.
    col += vec3(0.08, 0.12, 0.16) * fres * (0.4 + 0.6 * lh) * diskLight * 0.5;
    // Foam on the crests.
    float foam = crest * (0.55 + 0.45 * snoise(o * 30.0 + time * 0.1));
    col = mix(col, vec3(0.82, 0.86, 0.88) * (vec3(1.0, 0.82, 0.6) * (lh * 0.9 + 0.1) * diskLight + ls * 0.35), clamp(foam, 0.0, 1.0) * 0.4);
    // Cloud swirls: warped, stretched along the latitudes by the planet's spin.
  #ifdef PLANET_LOD
    vec3 wq = o;
    float cl = smoothstep(0.08, 0.5, fbm(vec3(wq.x * 1.8, wq.y * 5.0, wq.z * 1.8) + vec3(time * 0.01, 0.0, 0.0)));
  #else
    vec3 wq = o + 0.35 * vec3(fbm(o * 1.3 + 2.0), fbm(o * 1.3 + 7.0), fbm(o * 1.3 + 13.0));
    float cl = smoothstep(0.08, 0.5, fbm(vec3(wq.x * 1.8, wq.y * 5.0, wq.z * 1.8) + vec3(time * 0.01, 0.0, 0.0)) + fbm(o * 9.0) * 0.12);
  #endif
    vec3 cloud = vec3(0.9, 0.92, 0.95) * (vec3(1.0, 0.82, 0.6) * (lh * 0.9 + 0.08) * diskLight + vec3(0.8, 0.9, 1.0) * ls * 0.35);
    col = mix(col, cloud, cl * 0.75);
    return col;
  }

  /**
   * Mann's planet: a world of ice under clouds frozen solid. Glacier plains broken by long
   * pressure ridges, blue in the deep cracks; above them heavy, lumpy clouds of ice hanging
   * where they froze, bright on top and darkening the ice under them.
   */
  vec3 shadeMann(vec3 o, vec3 n, vec3 toHole, vec3 view, vec3 star, float diskLight) {
    // Lit by the disk on one side only: a hard, airless terminator.
    float lh = smoothstep(-0.12, 0.6, dot(n, toHole));
    float ls = max(dot(n, star), 0.0);
    vec3 light = vec3(1.0, 0.82, 0.6) * lh * diskLight + vec3(0.85, 0.92, 1.0) * ls * 0.3;
    // Ice: smooth blue-grey plains, a few long pale ridges pushed up where sheets collide.
    float plain = fbm(o * 1.6) * 0.5 + 0.5;
    float r1 = 1.0 - abs(snoise(o * vec3(2.6, 4.2, 2.6) + 2.0));
    float ridge = pow(r1, 14.0);
  #ifndef PLANET_LOD
    ridge += pow(1.0 - abs(snoise(o * 9.0 + 5.0)), 18.0) * 0.5 * smoothstep(0.3, 0.8, plain);
  #endif
    vec3 ice = mix(vec3(0.34, 0.43, 0.54), vec3(0.6, 0.68, 0.77), plain);
    ice = mix(ice, vec3(0.75, 0.82, 0.9), clamp(ridge, 0.0, 1.0) * 0.5);
    vec3 col = ice * (light + 0.015);
    // Glare off the ice.
    vec3 hv = normalize(toHole + view);
    col += vec3(1.0, 0.88, 0.7) * pow(max(dot(n, hv), 0.0), 50.0) * 0.4 * lh * diskLight;
    // The frozen clouds: big, lumpy masses; and (the same clouds, seen from a step towards
    // the light) their shadows on the ice.
    vec3 q = o * vec3(1.5, 2.4, 1.5) + 7.0;
    float c = fbm(q) + 0.3 * pow(1.0 - abs(snoise(q * 2.1)), 2.0);
  #ifndef PLANET_LOD
    c += 0.1 * fbm(o * 9.0);
  #endif
    float cloud = smoothstep(0.05, 0.3, c);
    vec3 qs = q + toHole * 0.1;
    float shade = smoothstep(0.05, 0.3, fbm(qs) + 0.3 * pow(1.0 - abs(snoise(qs * 2.1)), 2.0));
    col *= 1.0 - 0.35 * shade * (1.0 - cloud);
    // Bright and billowing on top, greyer in the folds.
    float top = smoothstep(0.25, 0.6, c);
    vec3 cloudCol = mix(vec3(0.72, 0.77, 0.84), vec3(1.0, 1.0, 1.0), top) * (light + 0.02);
    return mix(col, cloudCol, cloud * 0.9);
  }

  vec3 shadePlanet(float kind, vec3 o, vec3 n, vec3 P, vec3 view, vec3 star, float highlight, float time) {
    vec3 toHole = normalize(-P);
    float diskLight = 1.6 / (1.0 + length(P) / 40.0);
    vec3 albedo;
    float spec = 0.0;
    if (kind < 0.5) {
      vec3 col = shadeMiller(o, n, toHole, view, star, diskLight, time);
      // Blue haze at the limb, brightest where the disk's light grazes it.
      float rim = pow(1.0 - max(dot(n, view), 0.0), 2.6);
      float lit = smoothstep(-0.25, 0.4, dot(n, toHole));
      col += vec3(0.35, 0.55, 0.85) * rim * (lit * diskLight * 0.6 + max(dot(n, star), 0.0) * 0.25);
      col += vec3(0.6, 0.75, 1.0) * rim * highlight * 0.35;
      return col;
    } else if (kind < 1.5) {
      vec3 col = shadeMann(o, n, toHole, view, star, diskLight);
      // A thin, cold haze at the limb.
      float rim = pow(1.0 - max(dot(n, view), 0.0), 3.0);
      float lh = max(dot(n, toHole) * 0.85 + 0.15, 0.0);
      col += vec3(0.55, 0.65, 0.78) * rim * (lh * diskLight * 0.35 + max(dot(n, star), 0.0) * 0.2);
      col += vec3(0.6, 0.75, 1.0) * rim * highlight * 0.35;
      return col;
    } else {
      // Edmunds: dry rock and dust, ochre and grey.
      float rock = fbm(o * 2.6 + 3.0) * 0.5 + 0.5;
      float dark = smoothstep(0.55, 0.75, fbm(o * 5.0 - 2.0) * 0.5 + 0.5);
      albedo = mix(vec3(0.42, 0.3, 0.2), vec3(0.72, 0.58, 0.42), rock);
      albedo = mix(albedo, vec3(0.22, 0.18, 0.15), dark * 0.6);
    }
    // The disk's light falls off with distance; the far star is weak but steady.
    float lh = max(dot(n, toHole) * 0.85 + 0.15, 0.0);
    float ls = max(dot(n, star) * 0.9 + 0.1, 0.0);
    vec3 col = albedo * (vec3(1.0, 0.8, 0.55) * lh * diskLight + vec3(0.9, 0.95, 1.0) * ls * 0.35 + 0.03);
    col += pow(max(dot(n, normalize(toHole + view)), 0.0), 60.0) * spec * lh * diskLight * vec3(1.0, 0.85, 0.6);
    // A thin atmosphere at the rim (barely any on Mann's frozen world).
    float rim = pow(1.0 - max(dot(n, view), 0.0), 3.0);
    vec3 air = kind < 0.5 ? vec3(0.5, 0.65, 0.8) : kind < 1.5 ? vec3(0.25, 0.28, 0.32) : vec3(0.85, 0.65, 0.45);
    col += air * rim * (lh * diskLight * 0.5 + ls * 0.3) * 0.5;
    col += vec3(0.6, 0.75, 1.0) * rim * highlight * 0.35;
    return col;
  }
`;

const smoothstep5 = (k: number) => k * k * k * (k * (k * 6 - 15) + 10);
/** Cubic easing from 0 to 1 with slopes s0 at the start and s1 at the end. */
const hermite = (x: number, s0: number, s1: number) => ((s0 + s1 - 2) * x + (3 - 2 * s0 - s1)) * x * x + s0 * x;

/**
 * A tiling 3D noise texture (value noise, three octaves) for the disk's gas: sampled three
 * times per step it is far cheaper than computing noise in the shader, which matters inside
 * a loop that runs hundreds of steps per pixel.
 */
function makeGasNoise(size = 64): THREE.Data3DTexture {
  const rand = mulberry32(31415);
  const octave = (period: number) => {
    const lattice = new Float32Array(period * period * period).map(() => rand());
    const at = (x: number, y: number, z: number) =>
      lattice[((z % period) * period + (y % period)) * period + (x % period)];
    return (x: number, y: number, z: number) => {
      const fx = (x / size) * period, fy = (y / size) * period, fz = (z / size) * period;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const sx = smoothstep5(fx - ix), sy = smoothstep5(fy - iy), sz = smoothstep5(fz - iz);
      const l = THREE.MathUtils.lerp;
      return l(
        l(l(at(ix, iy, iz), at(ix + 1, iy, iz), sx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), sx), sy),
        l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), sx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), sx), sy),
        sz,
      );
    };
  };
  const o1 = octave(4), o2 = octave(8), o3 = octave(16);
  const data = new Uint8Array(size * size * size);
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = o1(x, y, z) * 0.55 + o2(x, y, z) * 0.3 + o3(x, y, z) * 0.15;
        data[i++] = Math.round(THREE.MathUtils.clamp((v - 0.5) * 1.6 + 0.5, 0, 1) * 255);
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** The streak texture spans ln r from the disk's inner edge (M) to beyond its outer edge. */
const STREAK_LR0 = Math.log(1.5);
const STREAK_LRR = Math.log(R_OUT * 2 * 1.05) - STREAK_LR0;

/**
 * The fine structure of the disk in polar form (x: azimuth, all the way round; y: ln r):
 * thin streaks drawn out along the orbits, as differential rotation shears gas. Mipmapped,
 * so the tracer can read it blurred by as much as one pixel covers there: fine detail up
 * close, an even glow where lensing squeezes it (sampled sharp, that turned into flickering
 * rings — the film's renderer filtered its disk the same way, by the width of each beam).
 */
function makeStreaks(w = 1024, h = 256): THREE.DataTexture {
  const rand = mulberry32(27182);
  const octave = (px: number, py: number) => {
    const lattice = new Float32Array(px * (py + 1)).map(() => rand());
    return (x: number, y: number) => {
      const fx = (x / w) * px, fy = (y / h) * py;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const sx = smoothstep5(fx - ix), sy = smoothstep5(fy - iy);
      const at = (i: number, j: number) => lattice[Math.min(j, py) * px + (i % px)];
      const l = THREE.MathUtils.lerp;
      return l(l(at(ix, iy), at(ix + 1, iy), sx), l(at(ix, iy + 1), at(ix + 1, iy + 1), sx), sy);
    };
  };
  // Far longer round the orbit than across it.
  const oct = [octave(5, 20), octave(9, 52), octave(17, 110), octave(31, 230)];
  const wts = [0.35, 0.3, 0.2, 0.15];
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let k = 0; k < 4; k++) n += oct[k](x, y) * wts[k];
      // Bright thin filaments on a softer bed.
      const ridge = Math.pow(1 - Math.abs(2 * oct[2](x, y) - 1), 4);
      const v = (n - 0.5) * 1.8 + 0.5 + (ridge - 0.2) * 0.45;
      data[y * w + x] = Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

interface Body {
  info: CardInfo;
  kind: number;
  r: number;
  orbit: number;
  speed: number;
  phase: number;
  incl: number;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  hit: THREE.Mesh;
  orbitLine: THREE.LineLoop<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

const GARGANTUA: CardInfo = {
  kicker: 'Надмасивна чорна діра · «Інтерстелар»',
  name: 'Гаргантюа',
  rows: [
    ['Маса', '≈ 100 млн мас Сонця'],
    ['Обертання', 'майже граничне, зі швидкістю світла на горизонті'],
    ['Горизонт подій', 'приблизно як орбіта Землі'],
    ['Диск', 'тонкий, гарячий газ, що кружляє довкола'],
  ],
  fact: 'Вигляд Гаргантюа для фільму розрахували за рівняннями Кіпа Торна: промені світла простежили крізь викривлений простір — і з цього вийшли наукові статті.',
};

const SHIP: CardInfo = {
  kicker: 'Корабель · за мотивами «Інтерстелара»',
  name: 'Корабель-кільце',
  rows: [
    ['Форма', 'кільце модулів довкола осі'],
    ['Гравітація', 'штучна, від обертання кільця'],
    ['Орбіта', 'далеко від діри, де час тече майже як на Землі'],
  ],
  fact: 'Обертове кільце притискає все до зовнішньої стінки — так у космосі можна мати «вагу» без планети під ногами.',
};
/** Docking: seconds for the whole approach, for matching the ring's spin, and the start (ship units ahead). */
const DOCK_TIME = 9;
const DOCK_SPIN = 5.5;
const DOCK_FROM = 3.2;
/** The ring ship's orbit round the hole (world units), and how fast it goes round. */
const SHIP_ORBIT = { r: 31, speed: 0.022, phase: 1.1, incl: 0.16 };

const BODIES: Omit<Body, 'mesh' | 'hit' | 'orbitLine'>[] = [
  {
    info: {
      kicker: 'Водний світ · «Інтерстелар»',
      name: 'Міллер',
      rows: [
        ['Відстань', 'найближча до Гаргантюа'],
        ['Час', '1 година тут — 7 років на Землі'],
        ['Хвилі', 'заввишки з гору, понад кілометр'],
        ['Поверхня', 'мілкий океан до колін'],
      ],
      fact: 'Так близько до діри час тече повільніше. А хвилі — це приплив: Гаргантюа ледь розгойдує планету, і океан перекочується горами.',
    },
    kind: 0, r: 1.4, orbit: 24, speed: 0.05, phase: 2.2, incl: 0.04,
  },
  {
    info: {
      kicker: 'Крижаний світ · «Інтерстелар»',
      name: 'Планета Манна',
      rows: [
        ['Відстань', 'далеко від Гаргантюа'],
        ['Поверхня', 'крига, замерзлі хмари'],
        ['Атмосфера', 'непридатна для дихання'],
        ['Світло', 'тьмяне, від диска діри'],
      ],
      fact: 'Доктор Манн надсилав обнадійливі дані, але планета виявилася мертвою крижаною пусткою з хмарами, що замерзли на льоту.',
    },
    kind: 1, r: 2.0, orbit: 55, speed: 0.013, phase: 4.1, incl: -0.07,
  },
  {
    info: {
      kicker: 'Кам’яний світ · «Інтерстелар»',
      name: 'Планета Едмундс',
      rows: [
        ['Відстань', 'найдалі з трьох'],
        ['Поверхня', 'скелі й пил'],
        ['Атмосфера', 'придатна для дихання'],
        ['Час', 'майже як на Землі'],
      ],
      fact: 'Наприкінці фільму саме тут Амелія Бренд розбиває табір: планета виявилася придатною для життя.',
    },
    kind: 2, r: 1.6, orbit: 85, speed: 0.008, phase: 0.6, incl: 0.1,
  },
];

/**
 * «Гаргантюа» — the easter egg behind the wormhole near Saturn, after «Інтерстелар»: we go
 * through the wormhole (traced through the Ellis space-time, as in the film) and come out in
 * another galaxy, in a system we can fly around freely. A spinning supermassive black hole
 * with a thin, bright disk — every pixel traces its ray back through the curved space-time;
 * the spin lets light going round with it come closer, so the shadow is flattened on that
 * side — and the planets of Miller, Mann and Edmunds on their orbits. Click a planet or the
 * hole for its card; the wormhole's mouth (or Esc) takes us home.
 */
export class Gargantua implements CuriousScene {
  readonly name = 'gargantua' as const;
  readonly group = new THREE.Group();
  readonly seamless = true;
  readonly interactive = true;
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};
  onHover: (name: string | null) => void = () => {};
  onFocus: (info: CardInfo | null) => void = () => {};
  /** Time near Miller's planet and on Earth meanwhile, or null when away from it. */
  onClock: (rows: [string, string][] | null) => void = () => {};
  /** The look the hole is shown in, while it can be switched (null otherwise). */
  onLook: (look: HoleLook | null) => void = () => {};
  /** Set by the app before entering: the camera as it reached the wormhole on our side. */
  entry = { quat: new THREE.Quaternion(), lc: 2.4 };
  /** Asked when leaving: the orientation of a camera coming out on our side. */
  exitQuat: () => THREE.Quaternion = () => new THREE.Quaternion();
  /** How far past the throat (throat radii from its centre) we come out on our side. */
  readonly exitRc = Math.sqrt(1 + L_OUT * L_OUT);
  /** And how fast we are going then, in throat radii a second. */
  readonly exitSpeed = ((Math.sqrt(MOUTH_RC * MOUTH_RC - 1) + L_OUT) * OUT_S1) / OUT_TIME;

  private phase: 'in' | 'explore' | 'fly' | 'out' | 'done' = 'in';
  private lookName: HoleLook = loadLook();
  /** 0 as in the film … 1 as in nature, easing towards the chosen look. */
  private lookK = this.lookName === 'physics' ? 1 : 0;
  private lookNow = 0;
  private humLevel = 0;
  private t = 0;
  private hole: THREE.ShaderMaterial;
  private holeQuad: THREE.Mesh;
  /**
   * The tracer is by far the heaviest thing on screen (up close, a hundred milliseconds a
   * frame at full size on a laptop), so it draws into its own target at a size that follows
   * the frame rate, and that is laid over the screen (holeView). Its light is soft, so a
   * smaller size hardly shows, while a stalling frame rate would.
   */
  private holeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private holeScene = new THREE.Scene();
  private holeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private holeView: THREE.Mesh;
  /**
   * Frames of the tracer averaged over time (two targets, read one, write the other): each
   * frame steps through the gas at a different offset, so while the view holds still the
   * average loses the grain the offsets leave in any one frame.
   */
  private accum = [
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }),
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }),
  ];
  private accumIndex = 0;
  private accumScene = new THREE.Scene();
  private accumMat: THREE.ShaderMaterial;
  private frames = 0;
  private lastCam = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 0 };
  /** The tracer's resolution as a fraction of the screen's, and the frame time it tracks. */
  private holeScale = 1;
  private frameMs = 16;
  private lastNow = 0;
  private scaleWait = 0;
  private transit: THREE.ShaderMaterial;
  private transitQuad: THREE.Mesh;
  private bodies: Body[] = [];
  private holeHit = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
  private mouth = new Wormhole(false, MOUTH_R);
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private hovered: number | 'hole' | 'mouth' | 'ship' | null = null;
  private focused: number | 'hole' | 'ship' | null = null;
  /** A ring ship of our own design, parked on a wide orbit. */
  private ship = new THREE.Group();
  private shipRing = new THREE.Group();
  private shipHit = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  private shipGlint = new Glow('#ffe6c4', 1.2, 3);
  private shipLights: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  private ranger = new THREE.Group();
  /** Docking: seconds since it began (−1: not yet), and whether it has finished. */
  private docking = { t: -1, done: false };
  private following = false;
  private overview: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private flight?: gsap.core.Tween;
  private lastFocusPos = new THREE.Vector3();
  private downAt = { x: 0, y: 0, t: 0 };
  private idle = 0;
  /** Seconds spent beside Miller's planet (shown against the years passing on Earth). */
  private millerTime = 0;
  /** Last closeness passed to the drone (it is only updated on a real change). */
  private nearSound = -1;
  private clockShown = false;
  private fwd = new THREE.Vector3();
  private fly = { from: new THREE.Vector3(), to: new THREE.Vector3(), target0: new THREE.Vector3(), s1: 0 };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector2();
  private camRot = new THREE.Matrix3();

  constructor(private ctx: Ctx) {
    // ---- The black hole: a full-screen pass behind everything. Light is traced back through
    // Kerr space-time (a spinning hole), in units of its mass M (half a world unit).
    this.hole = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms(),
        uTime: globalUniforms.uTime,
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCam: { value: new THREE.Vector3() },
        uPlanets: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uPlanetRot: { value: [new THREE.Matrix3(), new THREE.Matrix3(), new THREE.Matrix3()] },
        uPlanetHi: { value: [0, 0, 0] },
        uPlanetFade: { value: [1, 1, 1] },
        uStar: { value: STAR.clone() },
        uSteps: { value: 360 },
        uGas: { value: makeGasNoise() },
        uStreaks: { value: makeStreaks() },
        uPixel: { value: 0.001 },
        uFrame: { value: 0 },
        // The look (film → nature), set from LOOKS each frame.
        uSpin: { value: 0.6 },
        uRin: { value: 4 },
        uDoppler: { value: 0 },
        uBeam: { value: 3 },
        uHot: { value: 1 },
        uThick: { value: 1 },
        uSteep: { value: 0.5 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        ${SKIES}
        // From afar the planets need less detail (and the shader compiles faster).
        #define PLANET_LOD
        ${PLANET_SHADE}
        // The step limit comes in as a uniform so the shader compiler cannot unroll the loop
        // (on Direct3D that made compiling take tens of seconds).
        uniform int uSteps;
        uniform highp sampler3D uGas;
        uniform sampler2D uStreaks;
        uniform float uPixel;  // the angle one pixel spans
        uniform float uFrame;  // frame count, for a different step pattern every frame
        uniform float uTime;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform vec3 uCam;
        uniform vec4 uPlanets[3];    // centre and radius, in M
        uniform mat3 uPlanetRot[3];  // world → each planet's own frame
        uniform float uPlanetHi[3];
        uniform float uPlanetFade[3];  // 0 where the close-up mesh has taken over
        uniform vec3 uStar;
        // The look: spin, the disk's inner edge (M, at the ISCO), how much of the Doppler and
        // gravitational shift to show and the power the brightness goes with it, how hot the
        // colours run, the gas layer's thickness, the steepness of the brightness fall-off
        // and an overall tint.
        uniform float uSpin, uRin, uDoppler, uBeam, uHot, uThick, uSteep;
        uniform vec3 uTint;
        varying vec2 vNdc;

        #define A uSpin
        #define A2 (uSpin * uSpin)
        #define R_IN uRin
        const float R_OUT = ${(R_OUT * 2).toFixed(1)};
        const float STREAK_LR0 = ${STREAK_LR0.toFixed(4)};
        const float STREAK_LRR = ${STREAK_LRR.toFixed(4)};
        const float GAS_SPIN = 6.0;    // how fast the disk's pattern turns (× the Keplerian rate)
        const float GAS_FALL = 0.2;    // how fast it spirals in (in ln r per second, at r = 1)
        const float GAS_CYCLE = 8.0;   // seconds over which the pattern drifts before it fades

        // Warm, film-like palette: deep amber through gold to white-hot, and on (reached only
        // by gas blueshifted coming towards us, as in nature) to blue-white.
        vec3 heat(float t) {
          t = clamp(t, 0.0, 3.2);
          vec3 c = mix(vec3(0.2, 0.07, 0.025), vec3(0.95, 0.55, 0.26), smoothstep(0.0, 0.5, t));
          c = mix(c, vec3(1.0, 0.84, 0.68), smoothstep(0.45, 1.0, t));
          c = mix(c, vec3(1.0, 0.96, 0.9), smoothstep(0.95, 1.6, t));
          c = mix(c, vec3(0.92, 0.95, 1.0), smoothstep(1.6, 2.2, t));
          return mix(c, vec3(0.72, 0.82, 1.0), smoothstep(2.2, 3.2, t));
        }

        // Photon constants: angular momentum L and Carter's Q (energy 1); K = Q + (L − a)².
        float L, Q, K;
        float Rf(float r) { float P = r * r + A2 - A * L; return P * P - (r * r - 2.0 * r + A2) * K; }
        float dRf(float r) { return 4.0 * r * (r * r + A2 - A * L) - (2.0 * r - 2.0) * K; }
        float Tf(float th) { float c = cos(th), s = max(abs(sin(th)), 0.004); return Q + A2 * c * c - L * L * c * c / (s * s); }
        float dTf(float th) {
          float c = cos(th), s = sin(th);
          s = s >= 0.0 ? max(s, 0.004) : min(s, -0.004);
          return -2.0 * A2 * c * s + 2.0 * L * L * c / (s * s * s);
        }
        vec3 cart(float r, float th, float ph) {
          float q = sqrt(r * r + A2) * sin(th);
          return vec3(q * cos(ph), r * cos(th), q * sin(ph));
        }

        // How bright the disk is at radius r (M), 1 at the peak just outside the inner edge: the
        // flux of a thin disk, F ∝ x⁻³(1 − x^-½), with its contrast softened so the outer disk
        // still reads (more so for the film).
        float diskProfile(float r) {
          float x = r / R_IN;
          float f = max(pow(x, -3.0) * (1.0 - inversesqrt(x)), 0.0) / 0.0566;
          return pow(f, uSteep) * smoothstep(R_IN, R_IN * 1.06, r) * (1.0 - smoothstep(R_OUT * 0.55, R_OUT, r));
        }

        // Redshift factor of gas on a circular (Keplerian) orbit at radius r turning with the
        // hole, seen along a ray with angular momentum L: Doppler and gravitational shift
        // together, exactly, for Kerr. All of it for nature; none for the film, which left it out.
        float gasShift(float r) {
          float r15 = pow(r, 1.5);
          float om = 1.0 / (r15 + A);
          float ut = (r15 + A) / (pow(r, 0.75) * sqrt(max(r15 - 3.0 * sqrt(r) + 2.0 * A, 1e-4)));
          return mix(1.0, 1.0 / (ut * (1.0 - om * L)), uDoppler);
        }

        // The disk as a volume of gas: a thin, flaring slab whose density is turbulent — big
        // clumps, filaments and fine grit, all turning with the gas, so the differential
        // rotation shears them into long streaks.
        float gClump;  // how much of a clump the last gasDensity() sample was in, 0..1
        float gLod;    // how blurred to read the streaks: the mip level one pixel covers
        float slabHeight(float rho) { return (0.08 + 0.02 * rho) * uThick; }
        // The turbulence (and the faint streaks along the orbits) at one moment of the drift.
        float gasTurb(float ang, float lr, float zeta, vec3 o, out float streak) {
          // Nearly the same through the slab's thickness (each clump a column, the fine grain
          // varying more), so a ray grazing the thin disk keeps the contrast.
          // Clumps drawn out round the orbit (sheared), several times longer than wide.
          vec3 c = vec3(cos(ang) * 0.32, sin(ang) * 0.32, lr * 3.4) + o;
          float big = texture(uGas, c + vec3(0.0, 0.0, zeta * 0.05)).r;
          float fil = 1.0 - abs(2.0 * texture(uGas, c * vec3(2.3, 2.3, 2.9) + vec3(0.37, 0.11, 0.5)).r - 1.0);
          fil *= fil;
          float grit = texture(uGas, c * vec3(4.6, 4.6, 6.1) + vec3(0.71, 0.29, zeta * 0.18)).r;
          float dust = texture(uGas, c * vec3(9.0, 9.0, 13.0) + vec3(0.13, 0.57, zeta * 0.35)).r;
          streak = textureLod(uStreaks, vec2(ang * 0.15915494 + o.x, (lr - STREAK_LR0) / STREAK_LRR), gLod).r;
          return big * 0.42 + fil * 0.36 + grit * 0.22 + dust * 0.2;
        }
        float gasDensity(float rho, float hgt, float ph) {
          float H = slabHeight(rho);
          float v = exp(-hgt * hgt / (H * H));
          if (v < 0.03) return 0.0;
          float zeta = hgt / H;
          // The gas turns (Keplerian, far faster inside) and spirals slowly in, faster the
          // closer it gets. Followed for ever, the shear would wind every clump into a thin
          // ring, so the pattern drifts over a short cycle only: two copies half a cycle
          // apart, each faded out as it starts again.
          float om = GAS_SPIN / (pow(rho, 1.5) + A);
          float fall = GAS_FALL * inversesqrt(rho);
          float cyc = uTime / GAS_CYCLE;
          float ta = fract(cyc) * GAS_CYCLE, tb = fract(cyc + 0.5) * GAS_CYCLE;
          float wa = 1.0 - abs(2.0 * fract(cyc) - 1.0);
          float lr = log(rho);
          float sa, sb;
          float turbA = gasTurb(ph - ta * om, lr + ta * fall, zeta, vec3(0.0), sa);
          float turbB = gasTurb(ph - tb * om, lr + tb * fall, zeta, vec3(0.53, 0.29, 0.71), sb);
          float turb = mix(turbB, turbA, wa);
          float streak = mix(sb, sa, wa);
          // Two faded copies are flatter than one: stretch the contrast back.
          turb = 0.5 + (turb - 0.5) * (1.0 + 0.6 * (1.0 - abs(2.0 * wa - 1.0)));
          float clumpy = smoothstep(0.45, 0.95, turb);
          // Inside, hot gas sheared smooth, with only faint streaks along the orbits; further
          // out, clumps and thinner lanes. (Lensing squeezes the far side of the disk into the
          // arc over the hole, so any strong radial pattern there turns into rings.)
          float rough = smoothstep(8.0, 22.0, rho);
          gClump = mix(0.05 + 0.3 * streak, (0.1 + 0.5 * clumpy) * (0.6 + 0.8 * streak), rough);
          return v * mix(0.6 + 0.8 * streak, (0.45 + 0.9 * smoothstep(0.3, 0.9, turb)) * (0.7 + 0.6 * streak), rough);
        }

        // Which planet (if any, else −1) one straight piece of a ray runs into, and where.
        // Only the test: the shading is done once per pixel, after the ray is finished (the
        // shader compiler inlines every call, so calling the shading at each test site made
        // compiling take tens of seconds).
        int planetHit(vec3 a, vec3 b, out vec3 hitPos, out vec3 hitDir) {
          vec3 d = b - a;
          float len = length(d);
          if (len < 1e-4) return -1;
          d /= len;
          for (int k = 0; k < 3; k++) {
            vec3 oc = a - uPlanets[k].xyz;
            float bb = dot(oc, d);
            float cc = dot(oc, oc) - uPlanets[k].w * uPlanets[k].w;
            float h = bb * bb - cc;
            if (h < 0.0) continue;
            float t = -bb - sqrt(h);
            if (t < 0.0 || t > len) continue;
            hitPos = a + d * t;
            hitDir = d;
            return k;
          }
          return -1;
        }

        vec3 planetColour(int k, vec3 hitPos, vec3 hitDir) {
          vec3 n = normalize(hitPos - uPlanets[k].xyz);
          return shadePlanet(float(k), uPlanetRot[k] * n, n, hitPos * 0.5, -hitDir, uStar, uPlanetHi[k], uTime);
        }

        void main() {
          vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
          vec3 dir = normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));
          vec3 p = uCam * 2.0;
          // Boyer–Lindquist coordinates of the camera (spin axis +y).
          float b0 = dot(p, p) - A2;
          float r = sqrt(0.5 * (b0 + sqrt(b0 * b0 + 4.0 * A2 * p.y * p.y)));
          float th = acos(clamp(p.y / r, -1.0, 1.0));
          float ph = atan(p.z, p.x);
          float st = sin(th), ct = cos(th);
          vec3 er = vec3(st * cos(ph), ct, st * sin(ph));
          vec3 et = vec3(ct * cos(ph), -st, ct * sin(ph));
          vec3 ep = vec3(-sin(ph), 0.0, cos(ph));
          float nr = dot(dir, er), nt = dot(dir, et), np = dot(dir, ep);
          // Far from the hole the camera's own frame is nearly flat: read the constants off it.
          L = r * st * np;
          Q = r * r * nt * nt - A2 * ct * ct + L * L * ct * ct / max(st * st, 1e-4);
          K = Q + (L - A) * (L - A);
          float vr = sign(nr) * sqrt(max(Rf(r), 0.0));
          float vt = sign(nt) * sqrt(max(Tf(th), 0.0));
          float rPlus = 1.0 + sqrt(1.0 - A2);

          // Far from the hole (most of the sky) light bends only slightly: the weak-field
          // deflection 4M/b towards the hole, and the planets along a straight line.
          float bImpact = sqrt(max(Q + L * L, 0.0));
          bool farRay = bImpact > 44.0 || nr > 0.0 && r > R_OUT + 6.0;
          vec3 col = vec3(0.0);
          float through = 1.0;
          float near = 0.0;
          bool captured = false;
          int hitK = -1;
          vec3 hitPos, hitDir;
          vec3 skyDir = dir;
          if (farRay) {
            vec3 toHole = -p - dir * dot(-p, dir);
            float alpha = nr > 0.0 ? 0.0 : 4.0 / bImpact;
            skyDir = normalize(dir + normalize(toHole + vec3(1e-6)) * alpha);
            // Planets: straight in to the closest approach, then along the bent ray.
            vec3 q = p + dir * max(dot(-p, dir), 0.0);
            hitK = planetHit(p, q, hitPos, hitDir);
            if (hitK < 0) hitK = planetHit(q, q + skyDir * 600.0, hitPos, hitDir);
          }
          float rPrev = r, thPrev = th, phPrev = ph;
          bool inSlab = false;
          bool fine = false;  // in or just by the gas: small steps
          float travel = 0.0;  // how far the ray has come, M
          // A different step pattern in every pixel (and every frame), so sampling the thin
          // gas leaves only a fine, even grain rather than bands: interleaved gradient noise,
          // which spreads its values far more evenly between neighbours than a hash does.
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + fract(uFrame * 0.618034));
          // (A far ray skips the tracing and goes straight to the shading below.)
          for (int i = 0; i < (farRay ? 0 : uSteps); i++) {
            // Mino time: radial speed grows as r², so steps shrink as 1/r far out.
            // Finer in and by the gas, so the thin slab is sampled several times and where a
            // ray first meets it is not quantised to the long steps outside (that left bands).
            float dtau = (r > 8.0 ? 0.05 : 0.03) / max(r, 1.6) * clamp(abs(sin(th)) * 6.0, 0.3, 1.0) * (fine ? 0.2 * (0.7 + 0.6 * jitter) : 1.0);
            rPrev = r; thPrev = th; phPrev = ph;
            float vt0 = vt;
            // Leapfrog on r'' = R'/2, θ'' = Θ'/2 (so turning points take care of themselves).
            vr += 0.25 * dtau * dRf(r);
            vt += 0.25 * dtau * dTf(th);
            r += vr * dtau;
            th += vt * dtau;
            // Near the axis a step is far longer than the turning region, and Θ' there is huge:
            // stepping through it scatters rays. The closest a ray comes to the axis is where
            // Θ = 0 (with cos²θ ≈ 1 there), so a step that lands closer is folded back about
            // it, heading away. (The azimuth below counts that as a turning point.)
            float thMin = atan(abs(L), sqrt(max(Q + A2, 1e-6)));
            bool folded = false;
            if (thMin < 0.2 && th < thMin) { th = 2.0 * thMin - th; vt = 1.0; folded = true; }
            else if (thMin < 0.2 && th > 3.1415927 - thMin) { th = 2.0 * (3.1415927 - thMin) - th; vt = -1.0; folded = true; }
            // (Over the pole with a step too long even so: down the other side, half a turn round.)
            else if (th < 0.0) { th = -th; ph += 3.1415927; vt = -vt; }
            else if (th > 3.1415927) { th = 6.2831853 - th; ph += 3.1415927; vt = -vt; }
            vr += 0.25 * dtau * dRf(r);
            if (!folded) vt += 0.25 * dtau * dTf(th);
            // Back onto the constraint (r'² = R, θ'² = Θ), keeping the direction: the big
            // accelerations far out would otherwise pile up error.
            float Rn = Rf(r), Tn = Tf(th);
            if (Rn > 0.0) vr = (vr < 0.0 ? -1.0 : 1.0) * sqrt(Rn);
            if (Tn > 0.0 || folded) vt = (vt < 0.0 ? -1.0 : 1.0) * sqrt(max(Tn, 0.0));
            float s = max(sin(th), 0.004);
            float D = r * r - 2.0 * r + A2;
            if (r < rPlus * 1.02 || D < 1e-3) { captured = true; break; }
            float sPrev = max(sin(thPrev), 0.004);
            if (min(s, sPrev) < 0.25) {
              // Near the spin axis L / sin²θ is too steep to step through: its part of the
              // azimuth is integrated exactly instead. With u = cot θ (and cos²θ ≈ 1 there),
              // ∫ L / sin²θ dτ = ∓ asin(L u / √(Q + a²)); a turning point in θ is where that
              // reaches ±π/2. Passing the axis this way always sweeps half a turn, as it must.
              float kq = L / sqrt(max(Q + A2, 1e-6));
              float a0 = asin(clamp(kq * cos(thPrev) / sPrev, -1.0, 1.0));
              float a1 = asin(clamp(kq * cos(th) / s, -1.0, 1.0));
              float s0 = vt0 < 0.0 ? -1.0 : 1.0;
              float s1 = vt < 0.0 ? -1.0 : 1.0;
              float dphi;
              if (s0 == s1) dphi = -s0 * (a1 - a0);
              else {
                float at = (kq * cos(thPrev) >= 0.0 ? 1.0 : -1.0) * 1.5707963;
                dphi = -s0 * (at - a0) - s1 * (a1 - at);
              }
              ph += dphi + (A * (r * r + A2 - A * L) / D - A) * dtau;
            } else {
              ph += (A * (r * r + A2 - A * L) / D - A + L / (s * s)) * dtau;
            }
            if (r < 3.8) near += 1.0;
            float cth = cos(th);
            float hgt = r * cth;
            float rho = sqrt(r * r + A2) * s;
            float dl = (r * r + A2 * cth * cth) * dtau;
            travel += dl;
            // A thin, hot haze above and below the disk glows too (and is lensed with it).
            if (abs(hgt) < 4.0 && rho < R_OUT) {
              float haze = exp(-hgt * hgt / 0.6) * diskProfile(max(rho, R_IN * 1.06)) * smoothstep(R_IN * 0.7, R_IN * 1.1, rho);
              col += through * vec3(1.0, 0.62, 0.32) * haze * dl * 0.008;
            }
            // Inside the disk's gas: it glows (white-hot inside, amber out) and it absorbs,
            // so clumps stand out against dark lanes and hide what lies behind them.
            inSlab = abs(hgt) < 2.2 * slabHeight(rho) && rho > R_IN * 0.92 && rho < R_OUT;
            fine = abs(hgt) < 3.2 * slabHeight(rho) && rho > R_IN * 0.8 && rho < R_OUT * 1.05;
            if (inSlab) {
              float prof = diskProfile(rho);
              // The width this pixel's beam has spread to (wider still if it skimmed the
              // photon orbits, where neighbouring rays part fast), in texels of the streaks.
              float beam = travel * uPixel * (1.0 + 0.25 * near);
              gLod = clamp(log2(beam / (rho * ${(STREAK_LRR / 256).toFixed(5)})), 0.0, 8.0);
              float dens = prof > 0.0 ? gasDensity(rho, hgt, ph) : 0.0;
              if (dens > 0.002) {
                float shift = gasShift(rho);
                float T = 0.15 + 1.35 * pow(prof, 0.9);
                float k = dens * dl / uThick;  // (a thinner layer, as dense overall)
                // Outer gas is cooler and thinner: it glows far less and is nearly clear, so
                // edge-on the disk is still a bright line, and up close the hole's lower image
                // shows through it.
                col += through * uTint * heat(T * shift * uHot) * pow(shift, uBeam) * pow(prof, 1.1) * k * 3.6 * (0.3 + 1.5 * gClump);
                through *= exp(-k * 2.4 * (0.15 + 0.85 * prof));
                if (through < 0.02) break;
              }
            }
            // The planets all orbit well outside 40 M, so only look for them out there.
            if (r > 40.0 || rPrev > 40.0) {
              hitK = planetHit(cart(rPrev, thPrev, phPrev), cart(r, th, ph), hitPos, hitDir);
              if (hitK >= 0) break;
            }
            // Heading out beyond the disk, a ray can no longer turn back.
            if (r > R_OUT + 6.0 && vr > 0.0) break;
          }
          if (!farRay && !captured && hitK < 0) {
            vec3 pos = cart(r, th, ph);
            vec3 d = pos - cart(rPrev, thPrev, phPrev);
            skyDir = length(d) > 1e-5 ? normalize(d) : dir;
            // Out here light runs straight: the planets further out, then the sky.
            hitK = planetHit(pos, pos + skyDir * 600.0, hitPos, hitDir);
            // The photon ring: light that wound round the hole near the photon orbits.
            col += through * vec3(1.0, 0.88, 0.7) * smoothstep(70.0, 150.0, near) * 1.2;
          }
          // How far apart neighbouring pixels land on the sky (taken here, where every pixel
          // runs the same code again), so the stars can be filtered to it.
          float fp = length(fwidth(skyDir));
          // Shading, once per pixel: the (dimmer where strongly lensed) sky, and over it a
          // planet (fading out where its close-up mesh takes over).
          if (!captured) {
            vec3 sky = otherSky(hitK >= 0 ? hitDir : skyDir, fp) * (1.0 - 0.65 * smoothstep(8.0, 40.0, near));
            if (hitK >= 0) sky = mix(sky, planetColour(hitK, hitPos, hitDir), uPlanetFade[hitK]);
            col += through * sky;
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.holeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.hole);
    this.holeQuad.frustumCulled = false;
    this.holeScene.add(this.holeQuad);
    this.holeView = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uTex: { value: this.holeRT.texture } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uTex;
          varying vec2 vUv;
          void main() { gl_FragColor = texture2D(uTex, vUv); }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.holeView.frustumCulled = false;
    this.holeView.renderOrder = -2;
    this.accumMat = new THREE.ShaderMaterial({
      uniforms: { uCur: { value: null }, uPrev: { value: null }, uAlpha: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uCur, uPrev;
        uniform float uAlpha;
        varying vec2 vUv;
        void main() { gl_FragColor = mix(texture2D(uPrev, vUv), texture2D(uCur, vUv), uAlpha); }`,
      depthTest: false,
      depthWrite: false,
    });
    const accumQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.accumMat);
    accumQuad.frustumCulled = false;
    this.accumScene.add(accumQuad);

    // ---- Through the wormhole: a full-screen pass over everything.
    this.transit = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms(),
        uTime: globalUniforms.uTime,
        uInvProj: { value: new THREE.Matrix4() },
        uCamRot: { value: new THREE.Matrix3() },
        uFarRot: { value: new THREE.Matrix3() },
        uLc: { value: 0 },
        uAlpha: { value: 0 },
        uNearOurs: { value: 1 },
        uShake: { value: new THREE.Vector2() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        ${SKIES}
        ${ELLIS}
        uniform mat4 uInvProj;
        uniform mat3 uCamRot;
        uniform mat3 uFarRot;
        uniform float uLc;
        uniform float uAlpha;
        uniform float uNearOurs;
        uniform vec2 uShake;
        varying vec2 vNdc;
        void main() {
          vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
          vec3 dc = normalize(v.xyz / v.w);
          dc = normalize(dc + vec3(uShake, 0.0));
          vec3 d = uCamRot * dc;
          vec3 P = -(uCamRot * vec3(0.0, 0.0, -1.0));
          float far;
          vec3 E = ellisRay(d, P, uLc, far);
          if (far > 0.5) E = uFarRot * E;
          bool ours = (far > 0.5) != (uNearOurs > 0.5);
          gl_FragColor = vec4(ours ? ourSky(E) : otherSky(E), uAlpha);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.transitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.transit);
    this.transitQuad.frustumCulled = false;
    this.transitQuad.renderOrder = 10;
    // An unseen stand-in with the tracer's material, so the app's shader warm-up (which
    // walks this group) compiles it too.
    const warm = new THREE.Mesh(this.holeQuad.geometry, this.hole);
    const warmAccum = new THREE.Mesh(this.holeQuad.geometry, this.accumMat);
    for (const m of [warm, warmAccum]) {
      m.visible = false;
      m.frustumCulled = false;
    }
    this.group.add(this.holeView, warm, warmAccum, this.transitQuad, this.holeHit, this.mouth.group);

    // ---- The planets, lit by the disk (from the hole) and a far, faint star.
    const planetMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: globalUniforms.uTime,
        uStar: { value: STAR.clone() },
        uHighlight: { value: 0 },
        uKind: { value: 0 },
        uFade: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vObj;
        varying vec3 vN;
        varying vec3 vPosW;
        void main() {
          vObj = normalize(position);
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPosW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        ${PLANET_SHADE}
        uniform float uTime;
        uniform vec3 uStar;
        uniform float uHighlight;
        uniform float uKind;
        uniform float uFade;
        varying vec3 vObj;
        varying vec3 vN;
        varying vec3 vPosW;

        void main() {
          vec3 view = normalize(cameraPosition - vPosW);
          vec3 n = normalize(vN);
          gl_FragColor = vec4(shadePlanet(uKind, vObj, n, vPosW, view, uStar, uHighlight, uTime), uFade);
        }`,
      transparent: true,
    });
    const orbitMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.1 } },
      vertexShader: /* glsl */ `
        varying vec3 vPosW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPosW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${OCCLUDE}
        uniform float uOpacity;
        varying vec3 vPosW;
        void main() {
          gl_FragColor = vec4(vec3(0.75, 0.8, 0.95) * uOpacity * behindHole(cameraPosition, vPosW), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    BODIES.forEach((b, i) => {
      const mat = planetMat.clone();
      mat.uniforms.uTime = globalUniforms.uTime;
      mat.uniforms.uKind.value = b.kind;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r, 160, 120), mat);
      mesh.rotation.z = 0.3;
      const hit = new THREE.Mesh(new THREE.SphereGeometry(Math.max(b.r * 1.8, 2.5), 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.index = i;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < 256; k++) {
        const a = (k / 256) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * b.orbit, 0, -Math.sin(a) * b.orbit));
      }
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), orbitMat.clone());
      line.rotation.x = b.incl;
      line.frustumCulled = false;
      this.bodies.push({ ...b, mesh, hit, orbitLine: line });
      this.group.add(mesh, hit, line);
    });
    planetMat.dispose();
    orbitMat.dispose();
    this.buildShip();

    this.controls = new OrbitControls(ctx.camera, ctx.canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 16;
    this.controls.maxDistance = 260;
  }

  /**
   * The ring ship: ten modules on a ring that turns for gravity, joined by a tube, with
   * spokes to a hub along its axis. Lit, like the planets, by the disk and the far star.
   */
  private buildShip(): void {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uStar: { value: STAR.clone() }, uWindows: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vPosW;
        varying vec2 vUv;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPosW = w.xyz;
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${OCCLUDE}
        uniform vec3 uStar;
        uniform float uWindows;
        varying vec3 vN;
        varying vec3 vPosW;
        varying vec2 vUv;
        void main() {
          vec3 n = normalize(vN);
          vec3 view = normalize(cameraPosition - vPosW);
          vec3 toHole = normalize(-vPosW);
          float diskLight = 1.6 / (1.0 + length(vPosW) / 40.0);
          float lh = max(dot(n, toHole), 0.0) * diskLight;
          float ls = max(dot(n, uStar) * 0.85 + 0.15, 0.0) * 0.75;
          // Panel seams.
          float seam = step(0.94, fract(vUv.x * 4.0)) + step(0.94, fract(vUv.y * 3.0));
          vec3 base = vec3(0.62, 0.63, 0.66) * (1.0 - 0.35 * min(seam, 1.0));
          vec3 col = base * (vec3(1.0, 0.82, 0.6) * lh + vec3(0.9, 0.95, 1.0) * ls + 0.1);
          col += pow(max(dot(n, normalize(toHole + view)), 0.0), 40.0) * lh * 0.6;
          // A row of lit windows on each module.
          vec2 w = fract(vUv * vec2(5.0, 1.0));
          float lit = step(0.3, w.x) * step(w.x, 0.7) * step(0.42, vUv.y) * step(vUv.y, 0.58);
          col += vec3(1.0, 0.78, 0.45) * lit * uWindows * 0.9;
          gl_FragColor = vec4(col, behindHole(cameraPosition, vPosW));
        }`,
      transparent: true,
    });
    // As in the film: twelve modules round a ring (habitats with windows between squat
    // service cylinders), joined by a tube, four spokes to a hub with a docking collar at the
    // front and an engine bell behind; navigation lights on the ring, a strobe on the hub.
    const R = 0.45;
    const modules = mat.clone();
    modules.uniforms.uWindows.value = 1;
    const service = mat.clone();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const habitat = i % 2 === 0;
      const m = habitat
        ? new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.11, 0.24), modules)
        : new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.17, 12), service);
      m.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
      m.rotation.z = a;
      if (!habitat) m.rotation.x = Math.PI / 2;
      this.shipRing.add(m);
    }
    this.shipRing.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.014, 8, 96), mat));
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, R * 2, 6), mat);
      spoke.rotation.z = (i / 4) * Math.PI + Math.PI / 12;
      this.shipRing.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 20), mat);
    hub.rotation.x = Math.PI / 2;
    this.shipRing.add(hub);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 8, 24), mat);
    collar.position.z = 0.16;
    this.shipRing.add(collar);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.07, 0.08, 16, 1, true), service);
    bell.rotation.x = Math.PI / 2;
    bell.position.z = -0.19;
    this.shipRing.add(bell);
    // Navigation lights (bright enough to bloom), blinking in updateShip.
    const light = (color: THREE.Color, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      m.position.set(x, y, z);
      m.userData.base = color.clone();
      this.shipLights.push(m);
      return m;
    };
    this.shipRing.add(light(new THREE.Color(5, 0.25, 0.2), R + 0.08, 0, 0), light(new THREE.Color(0.25, 5, 0.6), -R - 0.08, 0, 0));
    this.ship.add(light(new THREE.Color(6, 6, 6), 0, 0.08, 0.17));
    // The Ranger, which docks when we visit (see updateDocking).
    const ranger = this.ranger;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.17), service);
    const wings = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.008, 0.07), mat);
    wings.position.z = -0.03;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.07, 4), mat);
    nose.rotation.x = -Math.PI / 2;
    nose.rotation.y = Math.PI / 4;
    nose.position.z = -0.12;
    ranger.add(body, wings, nose, light(new THREE.Color(5, 3.5, 1.5), 0, 0.02, 0.09));
    ranger.visible = false;
    this.ship.add(this.shipRing, this.shipGlint, ranger);
    this.group.add(this.ship, this.shipHit);
  }

  /**
   * Docking, as in the film (gentler): the Ranger comes in along the ship's axis, spins up
   * to turn with the ring, matches it, and closes on the collar.
   */
  private updateDocking(dt: number): void {
    const d = this.docking;
    const ranger = this.ranger;
    if (d.t < 0) return;
    d.t += dt;
    const ring = this.shipRing.rotation.z;
    // Spinning up to the ring's rate and angle over the first part, then locked to it.
    const match = smooth(0, DOCK_SPIN, d.t);
    ranger.rotation.set(0, 0, ring + (1 - match) * (1 - match) * 2.4);
    const k = hermite(Math.min(1, d.t / DOCK_TIME), 0.3, 0);
    ranger.position.set(0, 0, 0.29 + (DOCK_FROM - 0.29) * (1 - k));
    ranger.visible = true;
    if (d.t >= DOCK_TIME && !d.done) {
      d.done = true;
      this.ctx.audio.uiSelect();
      if (this.focused === 'ship') this.onCaption('Стикування завершено', 3);
    }
  }

  /** Where the ship is (or will be after `s` seconds). */
  private shipAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const a = SHIP_ORBIT.phase + (globalUniforms.uTime.value + s) * SHIP_ORBIT.speed;
    return out.set(Math.cos(a) * SHIP_ORBIT.r, 0, -Math.sin(a) * SHIP_ORBIT.r).applyAxisAngle(new THREE.Vector3(1, 0, 0), SHIP_ORBIT.incl);
  }

  private updateShip(dt: number): void {
    const cam = this.ctx.camera;
    this.shipAt(0, this.ship.position);
    // Fly nose first along the orbit; the ring turns about its axis.
    this.ship.lookAt(this.shipAt(0.5, this.tmp));
    this.shipRing.rotation.z += dt * 0.35;
    // Lights: the ring's red and green blink together, the hub's strobe double-flashes.
    const t = globalUniforms.uTime.value;
    const blink = (x: number) => (x % 1 < 0.08 ? 1 : 0.06);
    this.shipLights.forEach((m, i) => {
      const on = i < 2 ? blink(t * 0.8) : i === 2 ? Math.max(blink(t * 0.6), blink(t * 0.6 + 0.85)) : 1;
      m.material.color.copy(m.userData.base as THREE.Color).multiplyScalar(on);
    });
    this.updateDocking(dt);
    this.shipHit.position.copy(this.ship.position);
    // A glint to find it by from afar, gone up close.
    const d = cam.position.distanceTo(this.ship.position);
    this.shipGlint.intensity = smooth(4, 12, d) * (this.hovered === 'ship' ? 1.2 : 0.55);
    this.shipGlint.face(cam);
  }

  /** Where the focused body is now (null for the hole, which does not move). */
  private focusPos(): THREE.Vector3 | null {
    if (typeof this.focused === 'number') return this.bodies[this.focused].mesh.position;
    if (this.focused === 'ship') return this.ship.position;
    return null;
  }

  get finished(): boolean {
    return this.phase === 'done';
  }

  get wantsPointer(): boolean {
    return this.phase === 'explore' && this.hovered !== null;
  }

  enter(): void {
    const cam = this.ctx.camera;
    this.phase = 'in';
    this.t = 0;
    this.hovered = null;
    this.focused = null;
    this.following = false;
    this.overview = null;
    this.idle = 0;
    this.millerTime = 0;
    this.docking = { t: -1, done: false };
    this.ranger.visible = false;
    // We come out facing the way we went in; the hole is ahead, the mouth behind us.
    this.fwd.set(0, 0, -1).applyQuaternion(this.entry.quat);
    cam.quaternion.copy(this.entry.quat);
    cam.position.copy(this.fwd).multiplyScalar(-START_DIST);
    cam.up.set(0, 1, 0);
    cam.updateMatrixWorld();
    this.mouth.group.position.copy(cam.position).addScaledVector(this.fwd, -Math.sqrt(1 + L_IN * L_IN) * (MOUTH_R / LENS));
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 16;
    this.transit.uniforms.uNearOurs.value = 1;
    this.transit.uniforms.uFarRot.value.identity();
    this.camRot.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.entry.quat));
    this.ctx.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.ctx.canvas.addEventListener('pointerup', this.onPointerUp);
    this.ctx.canvas.addEventListener('pointermove', this.onActivity);
    this.ctx.canvas.addEventListener('wheel', this.onActivity, { passive: true });
    this.onCaption('Крізь кротову нору', 3.5);
    this.ctx.audio.wormhole(IN_TIME);
    this.update(0);
  }

  exit(): void {
    this.ctx.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.ctx.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.ctx.canvas.removeEventListener('pointermove', this.onActivity);
    this.ctx.canvas.removeEventListener('wheel', this.onActivity);
    this.flight?.kill();
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    if (this.hovered !== null) this.onHover(null);
    if (this.focused !== null) this.onFocus(null);
    this.hovered = null;
    this.focused = null;
    this.onClock(null);
    this.onLook(null);
    this.clockShown = false;
    this.ctx.audio.gargantua(false);
    this.humLevel = 0;
    this.ctx.audio.throatHum(0);
    this.ctx.audio.ambient(3);
  }

  /** Esc: first back out of a close-up, then home through the wormhole. */
  requestExit(): boolean {
    if (this.phase !== 'explore') return true;
    if (this.focused !== null) this.unfocus();
    else this.leave();
    return true;
  }

  /** The card's close button. */
  closeCard(): void {
    this.unfocus();
  }

  get look(): HoleLook {
    return this.lookName;
  }

  /** Shows the hole as in the film or as in nature (the change eases in over a moment). */
  setLook(look: HoleLook): void {
    if (look === this.lookName) return;
    this.lookName = look;
    try {
      localStorage.setItem(LOOK_KEY, look);
    } catch {
      // Storage may be blocked; the choice then lasts this visit.
    }
    this.onLook(look);
    this.ctx.audio.gargantuaLook(look === 'physics');
    this.onCaption(
      look === 'film'
        ? 'Як у фільмі: кругла тінь, без ефекту Доплера'
        : 'Як насправді: діра крутиться майже на межі, бік диска, що летить до нас, сліпучий',
      4,
    );
  }

  toggleLook(): void {
    if (this.phase === 'explore') this.setLook(this.lookName === 'film' ? 'physics' : 'film');
  }

  /** The look's settings, eased from film to nature by lookK. */
  private applyLook(): void {
    // On the wall clock, so the change runs its course even paused or on slow frames.
    const now = performance.now();
    const real = this.lookNow ? Math.min((now - this.lookNow) / 1000, 0.1) : 0;
    this.lookNow = now;
    const goal = this.lookName === 'physics' ? 1 : 0;
    const step = real / LOOK_TIME;
    this.lookK = goal > this.lookK ? Math.min(goal, this.lookK + step) : Math.max(goal, this.lookK - step);
    // Eased, but changing from the first moment (a softer start read as a delay).
    const k = this.lookK * this.lookK * (3 - 2 * this.lookK);
    const f = LOOKS.film, n = LOOKS.physics;
    const mix = (a: number, b: number) => a + (b - a) * k;
    const hu = this.hole.uniforms;
    hu.uSpin.value = mix(f.spin, n.spin);
    hu.uRin.value = isco(hu.uSpin.value) * 1.08;
    hu.uDoppler.value = mix(f.doppler, n.doppler);
    hu.uBeam.value = mix(f.beam, n.beam);
    hu.uHot.value = mix(f.hot, n.hot);
    hu.uThick.value = mix(f.thick, n.thick);
    hu.uSteep.value = mix(f.steep, n.steep);
    hu.uTint.value.set(mix(f.tint[0], n.tint[0]), mix(f.tint[1], n.tint[1]), mix(f.tint[2], n.tint[2]));
  }

  update(dt: number): void {
    this.t += dt;
    const cam = this.ctx.camera;
    for (const b of this.bodies) {
      const a = b.phase + globalUniforms.uTime.value * b.speed;
      b.mesh.position.set(Math.cos(a) * b.orbit, 0, -Math.sin(a) * b.orbit).applyAxisAngle(this.tmp.set(1, 0, 0), b.incl);
      b.hit.position.copy(b.mesh.position);
      b.mesh.rotation.y += dt * 0.05;
    }
    this.updateShip(dt);

    let transitAlpha = 0;
    const tu = this.transit.uniforms;
    if (this.phase === 'in') {
      // Through the throat: setting off at the speed we reached the mouth at, fastest at the
      // throat, easing out the far side.
      const s0 = (PASSAGE_SPEED * IN_TIME) / (this.entry.lc + L_IN);
      const k = hermite(Math.min(1, this.t / IN_TIME), Math.min(s0, 1.5), 0);
      const lc = this.entry.lc + (-L_IN - this.entry.lc) * k;
      tu.uLc.value = lc;
      tu.uCamRot.value.copy(this.camRot);
      // Past the throat the bending soon fades: hand over to the system itself, where the
      // camera carries on away from the mouth in step with l.
      transitAlpha = smooth(-7, -2, lc);
      const throat = MOUTH_R / LENS;
      cam.position.copy(this.mouth.group.position).addScaledVector(this.fwd, throat * Math.sqrt(1 + Math.min(lc, 0) ** 2));
      this.shake(lc);
      if (this.t >= IN_TIME) this.arrive();
    } else if (this.phase === 'fly') {
      // Up to the mouth on this side, turning to face it (arriving at the passage's speed).
      const k = hermite(Math.min(1, this.t / FLY_TIME), 0, this.fly.s1);
      cam.position.lerpVectors(this.fly.from, this.fly.to, k);
      this.controls.target.lerpVectors(this.fly.target0, this.mouth.group.position, smooth(0, 0.9, this.t));
      cam.lookAt(this.controls.target);
      if (this.t >= FLY_TIME) this.startOut();
    } else if (this.phase === 'out' || (this.phase === 'done' && this.t > 0)) {
      // (Past the end, while the app hands over, carry straight on at the same speed.)
      const lc0 = Math.sqrt(MOUTH_RC * MOUTH_RC - 1);
      const x = this.t / OUT_TIME;
      const k = x <= 1 ? hermite(x, OUT_S0, OUT_S1) : 1 + (x - 1) * OUT_S1;
      const lc = lc0 + (-L_OUT - lc0) * k;
      tu.uLc.value = lc;
      tu.uCamRot.value.copy(this.camRot);
      transitAlpha = 1;
      this.shake(lc);
      if (this.t >= OUT_TIME - HANDOVER) this.phase = 'done';
    } else if (this.phase === 'explore') {
      this.updateExplore(dt);
    }
    tu.uAlpha.value = transitAlpha;
    this.transitQuad.visible = transitAlpha > 0.002;
    // Nothing else shows while the transit covers the screen.
    this.holeView.visible = transitAlpha < 0.999;

    cam.updateMatrixWorld();
    const hu = this.hole.uniforms;
    this.bodies.forEach((b, i) => {
      // So close to so big a hole, light bends noticeably even far from it: the planets are
      // drawn by the ray tracer, lensed. Up close (a short, nearly straight path) the detailed
      // mesh takes over.
      b.mesh.updateMatrixWorld();
      hu.uPlanets.value[i].set(b.mesh.position.x * 2, b.mesh.position.y * 2, b.mesh.position.z * 2, b.r * 2);
      hu.uPlanetRot.value[i].setFromMatrix4(b.mesh.matrixWorld).transpose();
      hu.uPlanetHi.value[i] = b.mesh.material.uniforms.uHighlight.value;
      const near = 1 - smooth(b.r * 9, b.r * 13, cam.position.distanceTo(b.mesh.position));
      b.mesh.material.uniforms.uFade.value = near;
      b.mesh.visible = near > 0.002;
      hu.uPlanetFade.value[i] = 1 - near;
    });
    refreshSky(hu as unknown as Parameters<typeof refreshSky>[0]);
    refreshSky(tu as unknown as Parameters<typeof refreshSky>[0]);
    hu.uInvProj.value.copy(cam.projectionMatrixInverse);
    hu.uCamWorld.value.copy(cam.matrixWorld);
    hu.uCam.value.copy(cam.position);
    this.applyLook();
    tu.uInvProj.value.copy(cam.projectionMatrixInverse);
    // Flying home, the mouth glows and glints as if under the pointer, so the eye finds it;
    // close to it, it hums.
    const homeward = this.phase === 'fly';
    if (this.phase === 'explore' || homeward) {
      const k = 1 - smooth(MOUTH_R * 1.5, MOUTH_R * 14, cam.position.distanceTo(this.mouth.group.position));
      if (Math.abs(k - this.humLevel) > 0.02) {
        this.humLevel = k;
        this.ctx.audio.throatHum(k);
      }
    }
    this.mouth.update(dt, cam, this.phase === 'in' ? smooth(IN_TIME - 2, IN_TIME, this.t) : 1, this.hovered === 'mouth' || homeward, homeward ? 1.6 : 0.45);
    if (this.holeView.visible) this.renderHole();
  }

  /** Traces the hole into its target, at a size that keeps the frame rate up. */
  private renderHole(): void {
    const renderer = this.ctx.renderer;
    const now = performance.now();
    const ms = this.lastNow ? Math.min(now - this.lastNow, 250) : 16;
    this.lastNow = now;
    this.frameMs += (ms - this.frameMs) * 0.1;
    // Every half second or so: smaller while frames run slower than ~45 a second, larger
    // again once they are back near 60.
    this.scaleWait -= ms;
    if (this.scaleWait <= 0) {
      this.scaleWait = 400;
      if (this.frameMs > 22) this.holeScale = Math.max(HOLE_SCALE_MIN, this.holeScale * 0.85);
      else if (this.frameMs < 15) this.holeScale = Math.min(1, this.holeScale * 1.08);
    }
    const size = renderer.getDrawingBufferSize(this.tmp2);
    const w = Math.max(1, Math.round(size.x * this.holeScale));
    const h = Math.max(1, Math.round(size.y * this.holeScale));
    let resized = false;
    if (this.holeRT.width !== w || this.holeRT.height !== h) {
      this.holeRT.setSize(w, h);
      this.accum.forEach((t) => t.setSize(w, h));
      resized = true;
    }
    const cam = this.ctx.camera;
    this.hole.uniforms.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / h;
    this.hole.uniforms.uFrame.value = this.frames++ % 4096;
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(this.holeRT);
    renderer.render(this.holeScene, this.holeCam);

    // Average with the frames before while the view barely moves (a slow drift blurs no more
    // than a pixel); start afresh when it moves on, or the gas would smear.
    const last = this.lastCam;
    const turn = 2 * Math.acos(Math.min(1, Math.abs(last.quat.dot(cam.quaternion))));
    const shift = last.pos.distanceTo(cam.position) / Math.max(cam.position.length(), 1);
    const still = !resized && last.fov === cam.fov && turn + shift < 0.0025;
    last.pos.copy(cam.position);
    last.quat.copy(cam.quaternion);
    last.fov = cam.fov;
    const prev = this.accum[this.accumIndex];
    const next = this.accum[1 - this.accumIndex];
    this.accumMat.uniforms.uCur.value = this.holeRT.texture;
    this.accumMat.uniforms.uPrev.value = prev.texture;
    this.accumMat.uniforms.uAlpha.value = still ? ACCUM_ALPHA : 1;
    renderer.setRenderTarget(next);
    renderer.render(this.accumScene, this.holeCam);
    renderer.setRenderTarget(target);
    (this.holeView.material as THREE.ShaderMaterial).uniforms.uTex.value = next.texture;
    this.accumIndex = 1 - this.accumIndex;
  }

  /** A slight buffeting near the throat. */
  private shake(lc: number): void {
    const a = 0.006 * Math.exp(-lc * lc * 0.5) * (this.ctx.reducedMotion ? 0 : 1);
    const t = globalUniforms.uTime.value;
    this.transit.uniforms.uShake.value.set(Math.sin(t * 37.0) * a + Math.sin(t * 23.0) * a * 0.6, Math.cos(t * 31.0) * a);
  }

  private arrive(): void {
    this.phase = 'explore';
    this.t = 0;
    this.onLook(this.lookName);
    const cam = this.ctx.camera;
    cam.up.set(0, 1, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.enabled = true;
    this.controls.update();
    // Settle low over the disk, where the hole looks its most striking.
    const flat = cam.position.clone().setY(0);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1);
    const el = THREE.MathUtils.degToRad(9);
    const pose = flat.normalize().multiplyScalar(Math.cos(el) * 62).setY(Math.sin(el) * 62);
    this.flyTo(pose, new THREE.Vector3(), undefined, 4.5);
    this.ctx.audio.gargantua(true);
    this.ctx.audio.gargantuaLook(this.lookName === 'physics', false);
    this.nearSound = -1;
    this.onCaption('Система Гаргантюа · клік на планету чи діру — подробиці', 5);
  }

  // ---------------------------------------------------------------- exploring

  private updateExplore(dt: number): void {
    const cam = this.ctx.camera;
    this.idle += dt;
    this.updateHover();
    this.bodies.forEach((b, i) => {
      const lit = i === this.hovered ? 1 : i === this.focused ? 0.2 : 0;
      const u = b.mesh.material.uniforms;
      u.uHighlight.value += (lit - u.uHighlight.value) * Math.min(1, dt * 8);
      b.orbitLine.material.uniforms.uOpacity.value = i === this.hovered ? 0.3 : 0.1;
    });
    this.updateClock(dt);
    // The drone opens up as we get closer to the hole (after it has faded in).
    if (this.t > 4) {
      const k = 1 - smooth(25, 110, cam.position.length());
      if (Math.abs(k - this.nearSound) > 0.02) {
        this.nearSound = k;
        this.ctx.audio.gargantuaNear(k);
      }
    }
    // Ride along with a focused planet or the ship.
    const P = this.focusPos();
    if (P && this.following) {
      cam.position.add(this.tmp.copy(P).sub(this.lastFocusPos));
      this.controls.target.copy(P);
      this.lastFocusPos.copy(P);
    }
    if (!this.flight?.isActive()) {
      this.controls.autoRotate = this.focused === null && this.idle > 8;
      this.controls.autoRotateSpeed = 0.25;
      this.controls.update();
    }
  }

  /**
   * Beside Miller's planet one hour is seven years on Earth (×61 320): a clock for each, ticking
   * while we stay there.
   */
  private updateClock(dt: number): void {
    const there = this.focused === 0 && this.following;
    if (there) this.millerTime += dt;
    if (!there) {
      if (this.clockShown) this.onClock(null);
      this.clockShown = false;
      return;
    }
    this.clockShown = true;
    const t = this.millerTime;
    const en = lang === 'en';
    const here = `${Math.floor(t / 60)} ${en ? 'min' : 'хв'} ${String(Math.floor(t % 60)).padStart(2, '0')} ${en ? 's' : 'с'}`;
    const earthDays = (t * 61320) / 86400;
    const years = Math.floor(earthDays / 365.25);
    const months = Math.floor((earthDays - years * 365.25) / 30.44);
    const days = Math.floor(earthDays - years * 365.25 - months * 30.44);
    const earth = en ? `${years} yr ${months} mo ${days} d` : `${years} р. ${months} міс. ${days} дн.`;
    this.onClock([
      ['Тут минуло', here],
      ['На Землі', earth],
    ]);
  }

  private updateHover(): void {
    const { pointer, camera } = this.ctx;
    let h: Gargantua['hovered'] = null;
    if (pointer.inside && !this.flight?.isActive()) {
      this.raycaster.setFromCamera(pointer.ndc, camera);
      const targets = [...this.bodies.map((b) => b.hit), this.shipHit, this.holeHit, this.mouth.hit];
      const hits = this.raycaster.intersectObjects(targets, false);
      if (hits.length) {
        const o = hits[0].object;
        h = o === this.holeHit ? 'hole' : o === this.mouth.hit ? 'mouth' : o === this.shipHit ? 'ship' : (o.userData.index as number);
      }
    }
    if (h === this.hovered) return;
    this.hovered = h;
    const names = { hole: 'Гаргантюа', mouth: 'Кротова нора · додому', ship: 'Корабель-кільце' };
    this.onHover(h === null ? null : typeof h === 'number' ? this.bodies[h].info.name : names[h]);
  }

  private onActivity = () => {
    this.idle = 0;
  };

  private onPointerDown = (e: PointerEvent) => {
    this.idle = 0;
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.phase !== 'explore' || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    if (moved > 6 || performance.now() - this.downAt.t > 600) return; // that was a drag
    const h = this.hovered;
    if (h === 'mouth') this.leave();
    else if (h !== null) this.focus(h);
    else if (this.focused !== null) this.unfocus();
  };

  private focus(which: number | 'hole' | 'ship'): void {
    if (which === this.focused) return;
    const cam = this.ctx.camera;
    if (!this.overview) this.overview = { pos: cam.position.clone(), target: this.controls.target.clone() };
    this.focused = which;
    this.following = false;
    let pos: THREE.Vector3;
    let target: THREE.Vector3;
    if (which === 'hole') {
      // The classic view: low over the disk, close enough for the lensed arc to fill the view.
      const flat = cam.position.clone().setY(0);
      if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1);
      const el = THREE.MathUtils.degToRad(7);
      pos = flat.normalize().multiplyScalar(Math.cos(el) * 30).setY(Math.sin(el) * 30);
      target = new THREE.Vector3();
      this.onFocus(GARGANTUA);
    } else if (which === 'ship') {
      // Ahead of it and a little off its axis, as the Ranger comes in to dock: the ring
      // turning face-on, the Ranger closing on it from this side.
      const lead = this.ctx.reducedMotion ? 1.2 : 2.2;
      const P = this.shipAt(lead);
      const fwd = this.shipAt(lead + 0.5).sub(P).normalize();
      const out = P.clone().normalize();
      const dir = fwd.multiplyScalar(0.8).addScaledVector(out, 0.35).add(new THREE.Vector3(0, 0.3, 0)).normalize();
      pos = P.clone().addScaledVector(dir, 2.6);
      target = P;
      this.onFocus(SHIP);
    } else {
      const b = this.bodies[which];
      // Three-quarter view, with the hole behind the planet off to the left (the card is
      // on the right).
      const P = this.predict(which, this.ctx.reducedMotion ? 1.2 : 2.2);
      const out = P.clone().normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(out).normalize();
      const dir = out.multiplyScalar(0.55).addScaledVector(side, -0.8).add(new THREE.Vector3(0, 0.25, 0)).normalize();
      pos = P.clone().addScaledVector(dir, b.r * 5.5 + 2);
      target = P;
      this.onFocus(b.info);
    }
    this.flyTo(pos, target, () => {
      const P = this.focusPos();
      if (P) {
        this.following = true;
        this.lastFocusPos.copy(P);
        if (this.focused === 'ship' && this.docking.t < 0) {
          this.docking.t = this.ctx.reducedMotion ? DOCK_TIME : 0;
          if (!this.ctx.reducedMotion) this.onCaption('«Рейнджер» іде на стикування', 4);
        }
        this.controls.minDistance = typeof this.focused === 'number' ? this.bodies[this.focused].r * 1.8 : 0.8;
      } else {
        this.controls.minDistance = 16;
      }
    });
  }

  private unfocus(): void {
    if (this.focused === null) return;
    this.focused = null;
    this.following = false;
    this.onFocus(null);
    this.controls.minDistance = 16;
    const back = this.overview;
    this.overview = null;
    if (back) this.flyTo(back.pos, back.target);
  }

  /** Where a planet will be after `s` seconds (it keeps moving while we fly). */
  private predict(i: number, s: number): THREE.Vector3 {
    const b = this.bodies[i];
    const a = b.phase + (globalUniforms.uTime.value + s) * b.speed;
    return new THREE.Vector3(Math.cos(a) * b.orbit, 0, -Math.sin(a) * b.orbit).applyAxisAngle(new THREE.Vector3(1, 0, 0), b.incl);
  }

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, done?: () => void, duration = 2.2): void {
    const cam = this.ctx.camera;
    const from = { pos: cam.position.clone(), target: this.controls.target.clone() };
    // Arc round the hole rather than through it.
    const mid = from.pos.clone().add(pos).multiplyScalar(0.5);
    const bump = new THREE.Vector3();
    if (mid.length() < 22) bump.copy(mid.length() > 1e-3 ? mid.clone().normalize() : new THREE.Vector3(0, 1, 0)).multiplyScalar(22 - mid.length());
    const k = { t: 0 };
    this.flight?.kill();
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    this.flight = gsap.to(k, {
      t: 1,
      duration: this.ctx.reducedMotion ? 1.2 : duration,
      ease: 'power2.inOut',
      onUpdate: () => {
        cam.position.lerpVectors(from.pos, pos, k.t).addScaledVector(bump, Math.sin(Math.PI * k.t));
        this.controls.target.lerpVectors(from.target, target, k.t);
        cam.lookAt(this.controls.target);
      },
      onComplete: () => {
        this.controls.enabled = true;
        done?.();
      },
    });
  }

  // ---------------------------------------------------------------- home

  /** Fly into the mouth on this side, then back through the wormhole. */
  private leave(): void {
    if (this.phase !== 'explore') return;
    const cam = this.ctx.camera;
    this.flight?.kill();
    this.onLook(null);
    if (this.focused !== null) {
      this.focused = null;
      this.onFocus(null);
    }
    if (this.hovered !== null) this.onHover(null);
    this.hovered = null;
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    const M = this.mouth.group.position;
    this.fly.from.copy(cam.position);
    this.fly.target0.copy(this.controls.target);
    this.fly.to.copy(cam.position).sub(M).normalize().multiplyScalar(this.mouth.throat * MOUTH_RC).add(M);
    // Arrive at the speed the passage sets off at (l per second, near enough r per second).
    const lc0 = Math.sqrt(MOUTH_RC * MOUTH_RC - 1);
    const speed = ((lc0 + L_OUT) * OUT_S0 * this.mouth.throat * (lc0 / MOUTH_RC)) / OUT_TIME;
    const dist = this.fly.from.distanceTo(this.fly.to);
    this.fly.s1 = dist > 1e-3 ? Math.min(2.5, (speed * FLY_TIME) / dist) : 0;
    this.phase = 'fly';
    this.t = 0;
  }

  private startOut(): void {
    const cam = this.ctx.camera;
    cam.lookAt(this.mouth.group.position);
    cam.updateMatrixWorld();
    this.camRot.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(cam.quaternion));
    // The far side here is our sky: turn it so that, coming out, it lines up with the Solar
    // System's camera (which the app puts where this flight ends).
    const exit = this.exitQuat();
    const toOurs = new THREE.Matrix4().makeRotationFromQuaternion(exit.clone().multiply(cam.quaternion.clone().invert()));
    this.transit.uniforms.uFarRot.value.setFromMatrix4(toOurs);
    this.transit.uniforms.uNearOurs.value = 0;
    this.phase = 'out';
    this.t = 0;
    this.onCaption('Додому', 3);
    this.ctx.audio.gargantua(false);
    this.humLevel = 0;
    this.ctx.audio.throatHum(0);
    this.ctx.audio.wormhole(OUT_TIME);
  }

  dispose(): void {
    this.controls.dispose();
    this.holeRT.dispose();
    this.accum.forEach((t) => t.dispose());
    disposeObject(this.accumScene);
    disposeObject(this.holeScene);
    this.mouth.dispose();
    disposeObject(this.group);
  }
}
