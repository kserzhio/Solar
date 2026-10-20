import * as THREE from 'three';
import { config } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, globalUniforms, mulberry32 } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

const DURATION = 18;
/** The core gives way here; the shell starts expanding a moment later. */
const COLLAPSE = 4.2;
const BLAST = 5;

/**
 * «Наднова»: a massive blue first-generation star collapses and blows itself apart.
 * The expanding shell breaks into fingers coloured by the elements it carries,
 * leaving a pulsar at the centre.
 */
export class Supernova implements CuriousScene {
  readonly name = 'supernova' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private blasted = false;
  private star: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private halo = new Glow('#9fc0ff', 9, 2.0);
  private flash = new Glow('#fff6ea', 46, 1.6);
  private pulsar = new Glow('#cfe0ff', 1.4, 2.6);
  private shell: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private stars: THREE.Points;
  private unregister: () => void;

  constructor(private ctx: Ctx) {
    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uTime: globalUniforms.uTime, uHeat: { value: 0 }, uFade: { value: 1 } },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vView = cameraPosition - wp.xyz;
            vLocal = position;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          ${NOISE}
          uniform float uTime;
          uniform float uHeat;
          uniform float uFade;
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
            float gran = snoise(vLocal * 5.0 + vec3(0.0, uTime * 0.25, 0.0)) * 0.5 + 0.5;
            float cells = snoise(vLocal * 14.0 - vec3(uTime * 0.4)) * 0.5 + 0.5;
            float limb = 0.35 + 0.65 * sqrt(mu);
            vec3 col = mix(vec3(0.5, 0.66, 1.0), vec3(0.88, 0.94, 1.0), gran * 0.7 + cells * 0.3);
            col = mix(col, vec3(1.0, 0.97, 0.92), uHeat);
            gl_FragColor = vec4(col * limb * (1.25 + uHeat * 3.0) * uFade, 1.0);
          }`,
      }),
    );

    const count = Math.max(4000, Math.round(36000 * config.particleScale));
    const rand = mulberry32(1987);
    const dirs = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.randomDirection();
      dirs.set([v.x, v.y, v.z], i * 3);
      // Most matter rides in a thin outer shell, the rest trails behind it.
      const speed = rand() < 0.75 ? 0.94 + rand() * 0.06 : 0.4 + rand() * 0.5;
      seeds.set([speed, rand(), rand(), rand()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(dirs, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${NOISE}
        ${POINT_SIZE}
        uniform float uR;
        uniform float uHot;
        uniform float uFade;
        uniform float uT;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float n = snoise(position * 2.2) * 0.5 + 0.5;
          float n2 = snoise(position * 6.5 + 4.0) * 0.5 + 0.5;
          // Rayleigh–Taylor fingers: some directions run ahead of the rest.
          float finger = 0.8 + 0.35 * n * n + 0.08 * n2;
          // Matter gathers into bright filaments with darker gaps between them.
          float fil = smoothstep(0.45, 0.85, snoise(position * 4.0 + 9.0) * 0.5 + 0.5);
          float r = uR * finger * aSeed.x;
          vec3 p = position * r + curlNoise(position * 1.8 + vec3(uT * 0.03)) * uR * 0.035;

          vec3 col = aSeed.y < 0.35 ? vec3(1.0, 0.3, 0.36)      // hydrogen
                   : aSeed.y < 0.62 ? vec3(0.3, 0.95, 0.85)     // oxygen
                   : aSeed.y < 0.82 ? vec3(1.0, 0.74, 0.34)     // carbon, sulphur
                   : vec3(0.68, 0.74, 1.0);                     // iron
          vColor = mix(col * (0.8 + 1.0 * fil), vec3(1.0, 0.96, 0.9) * 2.0, uHot);
          vAlpha = uFade * (0.22 + 0.3 * aSeed.z) * (0.3 + fil) * (aSeed.x > 0.93 ? 1.0 : 0.45);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = pointSize(0.12 * (0.5 + aSeed.w), -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      { uR: { value: 0 }, uHot: { value: 1 }, uFade: { value: 0 }, uT: { value: 0 } },
    );
    this.shell = new THREE.Points(geometry, material);
    this.shell.frustumCulled = false;
    this.unregister = ctx.quality.register(geometry, count);

    this.stars = createStarfield(1800, 90, 7);
    this.group.add(this.stars, this.star, this.halo, this.shell, this.pulsar, this.flash);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.blasted = false;
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const fade = smooth(0, 1.2, t) * (1 - smooth(DURATION - 1.2, DURATION, t));

    const captions: [number, string, number][] = [
      [0.6, 'Перша зоря: у сто разів масивніша за Сонце', 3.2],
      [7.2, 'Вибух розсіює вуглець, кисень і залізо', 3.6],
      [12.4, 'Ми зроблені із зоряного пилу', 4],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }

    // The star: a slow breath, then the core gives way and the envelope falls in.
    const fall = smooth(COLLAPSE, BLAST, t);
    const alive = t < BLAST;
    const su = this.star.material.uniforms;
    su.uHeat.value = fall;
    su.uFade.value = fade;
    this.star.visible = alive;
    this.star.scale.setScalar(lerp(1 + 0.025 * Math.sin(t * 2.4), 0.1, fall * fall));
    this.halo.intensity = alive ? (0.55 + fall * 1.6) * fade : 0;
    this.halo.scale.setScalar(lerp(1, 0.4, fall));

    if (!this.blasted && t >= BLAST) {
      this.blasted = true;
      this.onFlash();
      this.ctx.audio.boom();
    }
    const since = Math.max(0, t - BLAST);
    const shellU = this.shell.material.uniforms;
    shellU.uR.value = 14 * (1 - Math.exp(-since * 0.85)) + since * 0.5;
    shellU.uHot.value = Math.exp(-since * 1.3);
    shellU.uFade.value = alive ? 0 : fade * smooth(0, 0.25, since);
    shellU.uT.value = t;
    this.shell.visible = !alive;
    this.flash.intensity = alive ? 0 : 3 * Math.exp(-since * 2.6);
    this.flash.scale.setScalar(0.4 + since * 0.8);
    // What is left: a neutron star, spinning and blinking.
    this.pulsar.intensity = alive ? 0 : smooth(0.8, 2.5, since) * (0.55 + 0.45 * Math.abs(Math.sin(t * 9))) * fade;
    ((this.stars as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>).material).uniforms.uOpacity.value = 0.8 * fade;

    const cam = this.ctx.camera;
    // Pulls back fast enough to stay well outside the shell.
    const dist = 8.5 + 24 * (1 - Math.exp(-since * 0.9)) + since;
    const az = -0.5 + t * 0.03;
    cam.position.set(Math.sin(az) * dist, dist * 0.18, Math.cos(az) * dist);
    if (!this.ctx.reducedMotion && since > 0) {
      const amp = 0.35 * Math.exp(-since * 2.2);
      cam.position.x += Math.sin(t * 57.3) * amp;
      cam.position.y += Math.cos(t * 49.1) * amp;
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    this.stars.position.copy(cam.position);
    this.halo.face(cam);
    this.flash.face(cam);
    this.pulsar.face(cam);
  }

  exit(): void {}

  dispose(): void {
    this.unregister();
    disposeObject(this.group);
  }
}
