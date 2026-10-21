import * as THREE from 'three';
import { config, particleCount } from '../config';
import {
  NOISE,
  POINT_FRAG,
  POINT_SIZE,
  additiveMaterial,
  colorUniform,
  gaussian,
  globalUniforms,
  mulberry32,
} from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import {
  GALAXY_VERT_COMMON,
  HERO_SHAPE,
  HERO_SPIN,
  randomQuaternion,
  sampleGalaxyParticle,
  type GalaxyShape,
} from './galaxy';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

const VOLUME = { x: 62, y: 30, zMin: -125, zMax: 48 };
const CAM_START_Z = 78;

interface Node {
  p: THREE.Vector3;
  ignite: number;
}

interface Ping {
  at: number;
  pan: number;
}

/**
 * Scene 3: first stars ignite one by one, then in clusters; matter gathers into
 * the filaments of the cosmic web; galaxies form at the knots; nebulae glow.
 */
export class Cosmos implements SceneModule {
  readonly name = 'cosmos' as const;
  readonly group = new THREE.Group();
  active = false;

  /** progress 0..1 is tweened by the timeline over the scene's duration. */
  params = { progress: 0, fade: 1, heroFade: 1 };
  duration = 14;

  private nodes: Node[] = [];
  private pings: Ping[] = [];
  /**
   * The very first stars and the bubbles they blow in the dark gas: their ultraviolet light
   * splits the hydrogen around them (reionization), a glowing sphere that swells and fades
   * as more and more of them join up.
   */
  private bubbles: { glow: Glow; ignite: number }[] = [];
  private nextPing = 0;
  private web: THREE.ShaderMaterial;
  private stars: THREE.ShaderMaterial;
  private galaxies: THREE.ShaderMaterial;
  private quasars!: THREE.ShaderMaterial;
  private merger!: THREE.ShaderMaterial;
  private galaxyInfo: { center: THREE.Vector3; quat: THREE.Quaternion; shape: GalaxyShape; size: number; appear: number; hero: boolean }[] = [];
  private nebulae: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  private nebulaTargets: THREE.WebGLRenderTarget[] = [];
  private starfield = createStarfield(5000, 320, 3);
  private unregister: (() => void)[] = [];
  private look = new THREE.Vector3();
  /** The massive cluster that bends background light mid-flight (picked once per run). */
  private lensNode: THREE.Vector3 | null = null;
  private ndc = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(private ctx: Ctx) {
    const rand = mulberry32(2024);
    this.buildNodes(rand);
    const edges = this.buildEdges();
    this.web = this.buildWeb(rand, edges);
    this.stars = this.buildStars(rand, edges);
    this.galaxies = this.buildGalaxies(rand);
    this.quasars = this.buildQuasars();
    this.merger = this.buildMerger();
    this.buildNebulae(rand);
    this.group.add(this.starfield);
  }

  // ---------------------------------------------------------------- build

  private buildNodes(rand: () => number): void {
    const hero = this.ctx.hero.position;
    this.nodes.push({ p: hero.clone(), ignite: 0.5 });
    let guard = 0;
    while (this.nodes.length < 34 && guard++ < 5000) {
      const p = new THREE.Vector3(
        (rand() * 2 - 1) * VOLUME.x,
        (rand() * 2 - 1) * VOLUME.y,
        lerp(VOLUME.zMin, VOLUME.zMax, rand()),
      );
      if (this.nodes.some((n) => n.p.distanceTo(p) < 17)) continue;
      // Keep the camera corridor clear so it flies between structures.
      if (Math.abs(p.x) < 7 && Math.abs(p.y - 3) < 6 && p.z > -10) continue;
      this.nodes.push({ p, ignite: 0.3 + rand() * 0.4 });
    }
  }

  private buildEdges(): [THREE.Vector3, THREE.Vector3][] {
    const edges: [THREE.Vector3, THREE.Vector3][] = [];
    const seen = new Set<string>();
    this.nodes.forEach((n, i) => {
      const nearest = this.nodes
        .map((m, j) => ({ j, d: m.p.distanceTo(n.p) }))
        .filter((e) => e.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { j } of nearest) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([n.p, this.nodes[j].p]);
      }
    });
    return edges;
  }

  /** Picks a point on the web: along a filament or in a knot. */
  private sampleWeb(rand: () => number, edges: [THREE.Vector3, THREE.Vector3][], out: THREE.Vector3, tight = 1): void {
    if (rand() < 0.22) {
      const n = this.nodes[Math.floor(rand() * this.nodes.length)];
      out.set(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(2.4 * tight).add(n.p);
      return;
    }
    const [a, b] = edges[Math.floor(rand() * edges.length)];
    const t = rand();
    const thick = (0.55 + 0.6 * Math.abs(t - 0.5)) * tight;
    out.lerpVectors(a, b, t);
    out.x += gaussian(rand) * thick;
    out.y += gaussian(rand) * thick;
    out.z += gaussian(rand) * thick;
  }

  private buildWeb(rand: () => number, edges: [THREE.Vector3, THREE.Vector3][]): THREE.ShaderMaterial {
    const count = particleCount('cosmicWeb');
    const start = new Float32Array(count * 3);
    const target = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      start.set(
        [(rand() * 2 - 1) * VOLUME.x * 1.1, (rand() * 2 - 1) * VOLUME.y * 1.2, lerp(VOLUME.zMin, VOLUME.zMax + 30, rand())],
        i * 3,
      );
      this.sampleWeb(rand, edges, v);
      target.set([v.x, v.y, v.z], i * 3);
      seeds.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(start, 3));
    geometry.setAttribute('aTarget', new THREE.BufferAttribute(target, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${NOISE}
        ${POINT_SIZE}
        uniform float uGather;
        uniform float uFade;
        uniform float uTime;
        uniform vec3 uColor;
        attribute vec3 aTarget;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float delay = aSeed.x * 0.45;
          float g = smoothstep(delay, delay + 0.55, uGather);
          vec3 p = mix(position, aTarget, g);
          p += curlNoise(p * 0.035 + vec3(uTime * 0.02)) * (1.2 - g * 0.8);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float near = smoothstep(0.5, 4.0, -mv.z);
          vColor = mix(uColor, vec3(1.0, 0.82, 0.62), aSeed.y * aSeed.y * g * 0.6) * (0.5 + g * 0.9);
          vAlpha = uFade * near * (0.1 + 0.6 * g) * (0.4 + aSeed.z);
          gl_PointSize = min(pointSize(0.16 * (0.5 + aSeed.w), -mv.z, vAlpha), 12.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      { uGather: { value: 0 }, uFade: { value: 0 }, uTime: globalUniforms.uTime, uColor: colorUniform(config.colors.filament) },
    );
    this.addPoints(geometry, material, count);
    return material;
  }

  private buildStars(rand: () => number, edges: [THREE.Vector3, THREE.Vector3][]): THREE.ShaderMaterial {
    const count = particleCount('firstStars');
    const positions = new Float32Array(count * 3);
    const data = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    const pioneers = 9;
    for (let i = 0; i < count; i++) {
      let ignite: number;
      let size: number;
      if (i < pioneers) {
        // The very first stars appear one by one, in front of the camera.
        v.set((rand() * 2 - 1) * 20, (rand() * 2 - 1) * 10 + 3, lerp(18, 46, rand()));
        ignite = 0.03 + i * 0.03;
        size = 0.55;
        const glow = new Glow(i % 3 === 0 ? '#9fb6ff' : '#b8a8ff', 1, 2.4);
        glow.position.copy(v);
        glow.visible = false;
        this.bubbles.push({ glow, ignite });
        this.group.add(glow);
        this.pings.push({ at: ignite, pan: THREE.MathUtils.clamp(v.x / 20, -1, 1) });
      } else {
        const node = this.nodes[Math.floor(rand() * this.nodes.length)];
        if (rand() < 0.7) {
          v.set(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(3.2).add(node.p);
          ignite = node.ignite + gaussian(rand) * 0.025;
        } else {
          this.sampleWeb(rand, edges, v, 1.4);
          ignite = 0.32 + rand() * 0.5;
        }
        size = 0.12 + rand() ** 3 * 0.35;
      }
      positions.set([v.x, v.y, v.z], i * 3);
      data.set([ignite, size, rand(), rand()], i * 4);
    }
    // One crystalline ping per cluster.
    for (const n of this.nodes) {
      this.pings.push({ at: n.ignite, pan: THREE.MathUtils.clamp(n.p.x / 50, -1, 1) });
    }
    this.pings.sort((a, b) => a.at - b.at);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform float uProgress;
        uniform float uDuration;
        uniform float uFlash;
        uniform float uFade;
        uniform float uTime;
        uniform vec3 uWarm;
        uniform vec3 uCool;
        attribute vec4 aData;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float age = (uProgress - aData.x) * uDuration;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          if (age < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }
          float flash = exp(-age * 2.2) * uFlash;
          float twinkle = 0.8 + 0.2 * sin(uTime * (1.0 + aData.w * 3.0) + aData.z * 6.28);
          float on = smoothstep(0.0, 0.08, age);
          vColor = mix(uCool, uWarm, aData.z) * (1.2 + flash * 7.0) * twinkle;
          vAlpha = uFade * on;
          gl_PointSize = min(pointSize(aData.y * (1.0 + flash * 2.5), -mv.z, vAlpha), 40.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uProgress: { value: 0 },
        uDuration: { value: 14 },
        uFlash: { value: this.ctx.reducedMotion ? 0.25 : 1 },
        uFade: { value: 1 },
        uTime: globalUniforms.uTime,
        uWarm: colorUniform(config.colors.starWarm),
        uCool: colorUniform(config.colors.starCool),
      },
    );
    this.addPoints(geometry, material, count);
    return material;
  }

  /**
   * Quasars: a few young galaxies host a blazing nucleus with two opposite jets
   * along the spin axis; plasma streams outward along them.
   */
  private buildQuasars(): THREE.ShaderMaterial {
    const hosts = this.galaxyInfo
      .filter((g) => !g.hero && g.shape.kind === 'spiral')
      .sort((a, b) => b.size - a.size)
      .slice(0, 3);
    const perJet = Math.round(700 * Math.min(1.5, config.particleScale));
    const count = hosts.length * (perJet * 2 + 1);
    const rand = mulberry32(606);
    const centers = new Float32Array(count * 3);
    const axes = new Float32Array(count * 3);
    const data = new Float32Array(count * 4);
    const sizes = new Float32Array(count);
    let i = 0;
    const axis = new THREE.Vector3();
    for (const g of hosts) {
      axis.set(0, 1, 0).applyQuaternion(g.quat);
      for (let k = 0; k < perJet * 2 + 1; k++, i++) {
        centers.set([g.center.x, g.center.y, g.center.z], i * 3);
        axes.set([axis.x, axis.y, axis.z], i * 3);
        const side = k === 0 ? 0 : k % 2 ? 1 : -1;
        data.set([rand(), side, rand(), g.appear], i * 4);
        sizes[i] = g.size;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(centers, 3));
    geometry.setAttribute('aAxis', new THREE.BufferAttribute(axes, 3));
    geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    geometry.setAttribute('aGsize', new THREE.BufferAttribute(sizes, 1));
    const material = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform float uProgress;
        uniform float uTime;
        uniform float uFade;
        attribute vec3 aAxis;
        attribute vec4 aData;
        attribute float aGsize;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float on = smoothstep(aData.w + 0.08, aData.w + 0.22, uProgress);
          vec3 p = position;
          float size;
          if (abs(aData.y) < 0.5) {
            // Nucleus: a tiny, blinding core.
            size = 0.22 * aGsize;
            vColor = vec3(0.85, 0.92, 1.0) * 5.0;
            vAlpha = uFade * on;
          } else {
            float s = fract(aData.x + uTime * (0.25 + aData.z * 0.2));
            vec3 side1 = normalize(cross(aAxis, vec3(0.31, 0.9, 0.17)));
            vec3 side2 = cross(aAxis, side1);
            float ang = aData.z * 6.2832;
            float spread = (0.015 + s * s * 0.14) * aGsize * fract(aData.z * 7.13);
            p += aAxis * aData.y * s * aGsize * 4.5 + (side1 * cos(ang) + side2 * sin(ang)) * spread;
            size = 0.06 * aGsize * (1.0 - s * 0.4);
            vColor = mix(vec3(0.8, 0.88, 1.0), vec3(0.45, 0.55, 1.0), s) * (2.8 - s * 1.8);
            vAlpha = uFade * on * pow(1.0 - s, 1.1) * 0.8;
          }
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = min(pointSize(size, -mv.z, vAlpha), 28.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      { uProgress: { value: 0 }, uTime: globalUniforms.uTime, uFade: { value: 1 } },
    );
    this.addPoints(geometry, material, count);
    return material;
  }

  /**
   * Two spirals caught in a merger: a stellar bridge between them and long curved tidal
   * tails flung out by gravity, dotted with pink knots of new star formation.
   */
  private buildMerger(): THREE.ShaderMaterial {
    const count = Math.round(8000 * config.particleScale);
    const rand = mulberry32(808);
    const center = new THREE.Vector3(-7, 15, -14);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0.4, -0.3));
    const scale = 5.2;
    const shape: GalaxyShape = { kind: 'spiral', arms: 2, wind: 1.7, roundness: 0 };
    const offsets = [new THREE.Vector3(-1.05, 0, 0.15), new THREE.Vector3(1.05, 0, -0.15)];
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const roll = rand();
      const g = i % 2;
      let slot: number;
      if (roll < 0.46) {
        // Galaxy bodies, slightly distorted towards each other.
        const [r, a, h, c] = sampleGalaxyParticle(rand, shape);
        const flip = g ? -1 : 1;
        v.set(Math.cos(a * flip) * r * 0.75, h, Math.sin(a * flip) * r * 0.75);
        v.x += -offsets[g].x * 0.12 * r;
        v.add(offsets[g]);
        slot = c;
      } else if (roll < 0.92) {
        // Tidal tails: long arcs swinging away on opposite sides.
        const s = Math.pow(rand(), 0.8);
        const dir = g ? -1 : 1;
        const ang = (g ? Math.PI : 0) + dir * (0.4 + s * 2.4);
        const r = 0.5 + s * 2.6;
        v.set(Math.cos(ang) * r, gaussian(rand) * 0.04 + s * 0.35 * dir, Math.sin(ang) * r * 0.8);
        v.add(offsets[g]);
        v.x += gaussian(rand) * 0.08 * (1 + s);
        v.z += gaussian(rand) * 0.08 * (1 + s);
        slot = rand() < 0.09 ? 2 : 0.75 + s * 0.25;
      } else {
        // Bridge of stars pulled between the two cores.
        const t = rand();
        v.lerpVectors(offsets[0], offsets[1], t);
        v.z += Math.sin(t * Math.PI) * 0.35;
        v.x += gaussian(rand) * 0.06;
        v.y += gaussian(rand) * 0.05;
        v.z += gaussian(rand) * 0.08;
        slot = 0.7;
      }
      v.multiplyScalar(scale).applyQuaternion(quat).add(center);
      positions.set([v.x, v.y, v.z], i * 3);
      colors.set([slot, rand(), rand(), 0], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aInfo', new THREE.BufferAttribute(colors, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform float uProgress;
        uniform float uFade;
        uniform float uTime;
        uniform vec3 uCore;
        uniform vec3 uArm;
        uniform vec3 uHII;
        attribute vec4 aInfo;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float on = smoothstep(0.38, 0.52, uProgress);
          float tw = 0.85 + 0.15 * sin(uTime * (0.8 + aInfo.z * 2.0) + aInfo.y * 6.28);
          vColor = (aInfo.x > 1.5 ? uHII * 1.8 : mix(uCore * 1.4, uArm, aInfo.x)) * (0.7 + aInfo.y * 0.9) * tw;
          vAlpha = uFade * on * 0.75;
          gl_PointSize = min(pointSize(0.085 * (0.5 + aInfo.z), -mv.z, vAlpha), 12.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uProgress: { value: 0 },
        uFade: { value: 1 },
        uTime: globalUniforms.uTime,
        uCore: colorUniform(config.colors.galaxyCore),
        uArm: colorUniform(config.colors.galaxyArm),
        uHII: colorUniform(config.colors.galaxyHII),
      },
    );
    this.addPoints(geometry, material, count);
    return material;
  }

  private buildGalaxies(rand: () => number): THREE.ShaderMaterial {
    const count = particleCount('galaxies');
    const hero = this.ctx.hero;
    interface Gal {
      center: THREE.Vector3;
      quat: THREE.Quaternion;
      shape: GalaxyShape;
      size: number;
      spin: number;
      appear: number;
      weight: number;
      hero: boolean;
    }
    const gals: Gal[] = [];
    this.nodes.forEach((n, i) => {
      const isHero = i === 0;
      if (!isHero && rand() < 0.2) return;
      const elliptical = !isHero && rand() < 0.3;
      gals.push({
        center: n.p,
        quat: isHero ? hero.quaternion : randomQuaternion(rand),
        shape: isHero ? HERO_SHAPE : {
          kind: elliptical ? 'elliptical' : 'spiral',
          arms: rand() < 0.6 ? 2 : 3,
          wind: 1.6 + rand() * 1.0,
          roundness: 0.4 + rand() * 0.5,
        },
        size: isHero ? hero.radius : 2.6 + rand() * 3,
        spin: isHero ? HERO_SPIN : elliptical ? 0.02 : 0.05 + rand() * 0.04,
        appear: isHero ? 0.5 : 0.42 + rand() * 0.32,
        weight: isHero ? 4 : elliptical ? 0.7 : 1,
        hero: isHero,
      });
    });
    this.galaxyInfo = gals;
    const total = gals.reduce((s, g) => s + g.weight, 0);
    const pick = () => {
      let r = rand() * total;
      for (const g of gals) if ((r -= g.weight) <= 0) return g;
      return gals[gals.length - 1];
    };

    const centers = new Float32Array(count * 3);
    const quats = new Float32Array(count * 4);
    const local = new Float32Array(count * 4);
    const misc = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const g = pick();
      centers.set([g.center.x, g.center.y, g.center.z], i * 3);
      quats.set([g.quat.x, g.quat.y, g.quat.z, g.quat.w], i * 4);
      local.set(sampleGalaxyParticle(rand, g.shape), i * 4);
      misc.set([g.appear, g.spin, g.size, g.hero ? 1 : 0], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(centers, 3));
    geometry.setAttribute('aQuat', new THREE.BufferAttribute(quats, 4));
    geometry.setAttribute('aLocal', new THREE.BufferAttribute(local, 4));
    geometry.setAttribute('aMisc', new THREE.BufferAttribute(misc, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${GALAXY_VERT_COMMON}
        uniform float uProgress;
        uniform float uFade;
        uniform float uHeroFade;
        uniform float uTime;
        uniform vec3 uCore;
        uniform vec3 uArm;
        uniform vec3 uHII;
        attribute vec4 aQuat;
        attribute vec4 aLocal;
        attribute vec4 aMisc;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float form = smoothstep(aMisc.x, aMisc.x + 0.16, uProgress);
          vec3 lp = galaxyLocal(aLocal, aMisc.y, uTime) * aMisc.z;
          lp *= mix(1.8, 1.0, form);             // gas cloud contracts into a disk
          lp.y *= mix(4.0, 1.0, form);
          vec3 p = position + rotateByQuat(lp, aQuat);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float heroK = mix(1.0, uHeroFade, aMisc.w);
          vColor = galaxyColor(aLocal.w, uCore, uArm, uHII) * (aLocal.x < 0.15 ? 1.8 : 1.0);
          vAlpha = uFade * heroK * form * 0.55;
          gl_PointSize = pointSize(0.09 * aMisc.z * 0.35, -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uProgress: { value: 0 },
        uFade: { value: 1 },
        uHeroFade: { value: 1 },
        uTime: globalUniforms.uTime,
        uCore: colorUniform(config.colors.galaxyCore),
        uArm: colorUniform(config.colors.galaxyArm),
        uHII: colorUniform(config.colors.galaxyHII),
      },
    );
    this.addPoints(geometry, material, count);
    return material;
  }

  private buildNebulae(rand: () => number): void {
    // Bake three noise textures once so the billboards stay cheap to fill.
    for (let i = 0; i < 3; i++) this.nebulaTargets.push(bakeNebula(this.ctx.renderer, 11 + i * 7.3));
    const palette = () => {
      const c = config.colors;
      return [c.nebulaViolet, c.nebulaTeal, c.nebulaPink];
    };
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 9; i++) {
      const node = this.nodes[1 + Math.floor(rand() * (this.nodes.length - 1))];
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: this.nebulaTargets[i % 3].texture },
          uColor: { value: new THREE.Color(palette()[i % 3]) },
          uOpacity: { value: 0 },
          uRot: { value: rand() * 6.28 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying float vDepthFade;
          void main() {
            vUv = uv;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vDepthFade = smoothstep(2.0, 18.0, -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          uniform vec3 uColor;
          uniform float uOpacity;
          uniform float uRot;
          varying vec2 vUv;
          varying float vDepthFade;
          void main() {
            vec2 c = vUv - 0.5;
            float s = sin(uRot); float co = cos(uRot);
            vec2 uv = mat2(co, -s, s, co) * c + 0.5;
            vec4 t = texture2D(uMap, uv);
            vec3 col = uColor * t.r + mix(uColor, vec3(1.0), 0.5) * t.g * 0.6;
            gl_FragColor = vec4(col * uOpacity * vDepthFade, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(node.p).add(new THREE.Vector3(gaussian(rand), gaussian(rand), gaussian(rand)).multiplyScalar(5));
      mesh.scale.setScalar(26 + rand() * 26);
      mesh.userData = { appear: 0.35 + rand() * 0.35, strength: 0.22 + rand() * 0.2, colorIndex: i % 3 };
      this.nebulae.push(mesh);
      this.group.add(mesh);
    }
  }

  private addPoints(geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial, count: number): void {
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.group.add(points);
    this.unregister.push(this.ctx.quality.register(geometry, count));
  }

  // ---------------------------------------------------------------- lifecycle

  enter(): void {
    this.params.progress = 0;
    this.params.fade = 1;
    this.params.heroFade = 1;
    this.nextPing = 0;
    this.stars.uniforms.uDuration.value = this.duration;
    this.look.set(0, 0, 0);
    this.lensNode = null;
  }

  update(_dt: number, time: number): void {
    const p = this.params.progress;
    const fade = this.params.fade;

    this.web.uniforms.uGather.value = smooth(0.08, 0.75, p);
    this.quasars.uniforms.uProgress.value = p;
    this.quasars.uniforms.uFade.value = this.params.fade;
    this.merger.uniforms.uProgress.value = p;
    this.merger.uniforms.uFade.value = this.params.fade;
    // The gas is there from the first moment, dim (the Dark Ages), then gathers into the web.
    this.web.uniforms.uFade.value = (0.45 + 0.55 * smooth(0.0, 0.3, p)) * fade;
    this.stars.uniforms.uProgress.value = p;
    this.stars.uniforms.uFade.value = fade;
    this.galaxies.uniforms.uProgress.value = p;
    this.galaxies.uniforms.uFade.value = fade;
    this.galaxies.uniforms.uHeroFade.value = this.params.heroFade;
    (this.starfield.material as THREE.ShaderMaterial).uniforms.uOpacity.value = smooth(0.1, 0.5, p) * 0.7 * fade;

    const cam = this.ctx.camera;
    const duration = this.stars.uniforms.uDuration.value as number;
    for (const b of this.bubbles) {
      const age = (p - b.ignite) * duration;
      b.glow.visible = age > 0 && fade > 0.01;
      if (!b.glow.visible) continue;
      b.glow.scale.setScalar(lerp(1.5, 22, 1 - Math.exp(-age * 0.3)));
      b.glow.intensity = 0.32 * smooth(0, 0.6, age) * Math.exp(-age * 0.16) * fade;
      b.glow.quaternion.copy(cam.quaternion);
    }
    for (const n of this.nebulae) {
      const { appear, strength } = n.userData as { appear: number; strength: number };
      n.material.uniforms.uOpacity.value = smooth(appear, appear + 0.25, p) * strength * fade;
      n.material.uniforms.uRot.value += 0.0004;
      n.quaternion.copy(cam.quaternion);
    }

    // Audio: crystalline pings as stars and clusters ignite.
    while (this.nextPing < this.pings.length && this.pings[this.nextPing].at <= p) {
      const ping = this.pings[this.nextPing++];
      if (p - ping.at < 0.03) this.ctx.audio.ping(ping.pan);
    }

    // Camera glides forward through the web; parallax comes from real depth.
    const speed = THREE.MathUtils.clamp(config.cameraSpeed, 0.2, 1.6);
    const e = p * p * (3 - 2 * p);
    const zEnd = CAM_START_Z - 84 * speed;
    cam.position.set(Math.sin(p * 2.2) * 6, 3 + Math.sin(p * 3.1 + 0.4) * 2.2, lerp(CAM_START_Z, zEnd, e));
    this.tmp.copy(cam.position).add(new THREE.Vector3(Math.sin(time * 0.05) * 3, -1.5, -40));
    this.look.lerpVectors(this.tmp, this.ctx.hero.position, smooth(0.55, 1.0, p));
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    this.starfield.position.copy(cam.position);
    this.updateLens(p);
  }

  /** Gravitational lensing around a rich cluster ahead of the camera. */
  private updateLens(p: number): void {
    const cam = this.ctx.camera;
    if (p < 0.5 || p > 0.97) return;
    if (!this.lensNode) {
      // Pick the cluster nearest a pleasing spot in the frame, in front and not too close.
      let best: THREE.Vector3 | null = null;
      let bestScore = Infinity;
      for (const n of this.nodes.slice(1)) {
        const dist = n.p.distanceTo(cam.position);
        if (dist < 28 || dist > 95) continue;
        this.ndc.copy(n.p).project(cam);
        if (this.ndc.z > 1 || Math.abs(this.ndc.x) > 0.7 || Math.abs(this.ndc.y) > 0.6) continue;
        const score = Math.hypot(this.ndc.x + 0.35, this.ndc.y - 0.2);
        if (score < bestScore) {
          bestScore = score;
          best = n.p;
        }
      }
      if (!best) return;
      this.lensNode = best;
    }
    this.ndc.copy(this.lensNode).project(cam);
    if (this.ndc.z > 1) return;
    const edge = 1 - smooth(0.75, 1.0, Math.max(Math.abs(this.ndc.x), Math.abs(this.ndc.y)));
    const dist = this.lensNode.distanceTo(cam.position);
    const l = this.ctx.lens;
    l.center.set(this.ndc.x * 0.5 + 0.5, this.ndc.y * 0.5 + 0.5);
    l.radius = 3.2 / (dist * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
    // Kept well below the folding threshold: arcs and magnification, no glowing ring.
    l.strength = 0.4 * smooth(0.5, 0.62, p) * (1 - smooth(0.88, 0.97, p)) * edge * this.params.fade;
  }

  exit(): void {}

  applyConfig(): void {
    const c = config.colors;
    this.web.uniforms.uColor.value.set(c.filament);
    this.stars.uniforms.uWarm.value.set(c.starWarm);
    this.stars.uniforms.uCool.value.set(c.starCool);
    this.galaxies.uniforms.uCore.value.set(c.galaxyCore);
    this.galaxies.uniforms.uArm.value.set(c.galaxyArm);
    this.galaxies.uniforms.uHII.value.set(c.galaxyHII);
    const palette = [c.nebulaViolet, c.nebulaTeal, c.nebulaPink];
    for (const n of this.nebulae) n.material.uniforms.uColor.value.set(palette[n.userData.colorIndex as number]);
  }

  dispose(): void {
    this.unregister.forEach((u) => u());
    this.nebulaTargets.forEach((t) => t.dispose());
    disposeObject(this.group);
  }
}

/** Renders an fbm cloud into a small texture once (R = body, G = bright wisps). */
function bakeNebula(renderer: THREE.WebGLRenderer, seed: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { uSeed: { value: seed } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform float uSeed;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        vec3 q = vec3(p * 2.6, uSeed);
        float warp = fbm5(q);
        float n = fbm5(vec3(p * 4.0 + warp * 1.2, uSeed * 1.37));
        float body = smoothstep(1.0, 0.15, r + warp * 0.55) * clamp(0.55 + n * 1.1, 0.0, 1.0);
        float wisps = pow(clamp(1.0 - abs(n) * 3.2, 0.0, 1.0), 4.0) * smoothstep(0.95, 0.3, r);
        gl_FragColor = vec4(body * body, wisps * body, 0.0, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prev);
  quad.geometry.dispose();
  material.dispose();
  return target;
}
