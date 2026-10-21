import * as THREE from 'three';
import { NOISE, globalUniforms } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

const DURATION = 26;
/** World units per astronomical unit, and seconds of scene per day. */
const AU = 100;
const DAY = 2;
/**
 * The seven planets (b…h): orbit (AU), radius (Earths), period (days), and a guess at a look:
 * the inner two hot and hazy, then rock, then the temperate three (e, f, g), then ice.
 */
const PLANETS = [
  { name: 'b', a: 0.0115, r: 1.12, p: 1.51, color: [0.78, 0.62, 0.45], ice: 0, water: 0 },
  { name: 'c', a: 0.0158, r: 1.1, p: 2.42, color: [0.72, 0.6, 0.5], ice: 0, water: 0 },
  { name: 'd', a: 0.0223, r: 0.79, p: 4.05, color: [0.66, 0.5, 0.38], ice: 0, water: 0.15 },
  { name: 'e', a: 0.0293, r: 0.92, p: 6.1, color: [0.45, 0.5, 0.42], ice: 0.15, water: 0.55 },
  { name: 'f', a: 0.0385, r: 1.05, p: 9.21, color: [0.55, 0.6, 0.66], ice: 0.45, water: 0.4 },
  { name: 'g', a: 0.0469, r: 1.13, p: 12.35, color: [0.62, 0.68, 0.74], ice: 0.6, water: 0.25 },
  { name: 'h', a: 0.0619, r: 0.76, p: 18.77, color: [0.8, 0.84, 0.88], ice: 0.9, water: 0 },
];
/** Where liquid water could be (AU), roughly: e, f and g fall inside. */
const HZ = [0.025, 0.05];

/**
 * «TRAPPIST-1»: a cool red dwarf 40 light-years away and its seven Earth-sized planets, all
 * closer to their star than Mercury is to the Sun, three in the zone where water could stay
 * liquid. Orbits and years are to scale with each other (a day here is two seconds). The
 * planets keep one face to the star, as such close planets do.
 */
export class Trappist implements CuriousScene {
  readonly name = 'trappist' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private star: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private glow = new Glow('#ff7a3a', 4, 2.2);
  private flare = new Glow('#ffb48a', 3, 3);
  private zone: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private planets: { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>; orbit: number; period: number; phase: number }[] = [];
  private orbitMat = new THREE.LineBasicMaterial({ color: 0xffb07a, transparent: true, opacity: 0, depthWrite: false });
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(private ctx: Ctx) {
    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uTime: globalUniforms.uTime, uFade: { value: 0 }, uFlare: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vView = cameraPosition - wp.xyz;
            vLocal = normalize(position);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          ${NOISE}
          uniform float uTime;
          uniform float uFade;
          uniform float uFlare;
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
            float cells = snoise(vLocal * 7.0 + uTime * 0.04) * 0.5 + 0.5;
            // Big dark spots: red dwarfs are heavily spotted.
            float spots = smoothstep(0.45, 0.7, snoise(vLocal * 2.2 + 4.0));
            vec3 col = mix(vec3(0.75, 0.16, 0.05), vec3(1.0, 0.45, 0.18), cells);
            col *= 1.0 - spots * 0.55;
            col *= mix(0.35, 1.0, pow(mu, 0.6));
            col += vec3(1.0, 0.6, 0.4) * uFlare * smoothstep(0.55, 0.9, snoise(vLocal * 3.0 + 9.0));
            gl_FragColor = vec4(col * 1.6 * uFade, 1.0);
          }`,
      }),
    );

    // The temperate zone: a faint green band, softest at its edges.
    this.zone = new THREE.Mesh(
      new THREE.RingGeometry(HZ[0] * AU, HZ[1] * AU, 160, 1),
      new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: 0 } },
        vertexShader: /* glsl */ `
          varying float vR;
          void main() {
            vR = length(position.xy);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uAlpha;
          varying float vR;
          void main() {
            float x = (vR - ${(HZ[0] * AU).toFixed(2)}) / ${((HZ[1] - HZ[0]) * AU).toFixed(2)};
            float a = smoothstep(0.0, 0.25, x) * (1.0 - smoothstep(0.75, 1.0, x));
            gl_FragColor = vec4(vec3(0.2, 0.7, 0.4) * a * uAlpha, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.zone.rotation.x = -Math.PI / 2;

    const planetMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uIce: { value: 0 }, uWater: { value: 0 }, uFade: { value: 0 }, uSeed: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vPos;
        varying vec3 vLocal;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vPos = wp.xyz;
          vLocal = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        uniform vec3 uColor;
        uniform float uIce;
        uniform float uWater;
        uniform float uFade;
        uniform float uSeed;
        varying vec3 vN;
        varying vec3 vPos;
        varying vec3 vLocal;
        void main() {
          vec3 n = normalize(vN);
          vec3 toStar = normalize(-vPos);
          float lit = max(dot(n, toStar), 0.0);
          float land = snoise(vLocal * 3.0 + uSeed) * 0.5 + snoise(vLocal * 7.0 + uSeed * 2.0) * 0.25;
          vec3 col = uColor * (0.75 + 0.5 * land);
          col = mix(col, vec3(0.08, 0.2, 0.35), uWater * smoothstep(0.05, -0.2, land));
          col = mix(col, vec3(0.88, 0.92, 0.96), uIce * smoothstep(0.55, 0.95, abs(vLocal.y) + land * 0.3 + (1.0 - lit) * 0.4));
          // Lit in the star's red light; the night side keeps a faint glow of its own.
          vec3 light = vec3(1.0, 0.55, 0.32) * lit * 1.6 + vec3(0.05, 0.02, 0.02);
          float rim = pow(1.0 - max(dot(n, normalize(cameraPosition - vPos)), 0.0), 3.0);
          gl_FragColor = vec4((col * light + vec3(1.0, 0.5, 0.3) * rim * lit * 0.25) * uFade, 1.0);
        }`,
    });
    PLANETS.forEach((p, i) => {
      const mat = planetMat.clone();
      mat.uniforms.uColor.value.setRGB(p.color[0], p.color[1], p.color[2]);
      mat.uniforms.uIce.value = p.ice;
      mat.uniforms.uWater.value = p.water;
      mat.uniforms.uSeed.value = i * 3.7;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.19 * p.r, 32, 24), mat);
      this.planets.push({ mesh, orbit: p.a * AU, period: p.p * DAY, phase: i * 2.1 });
      const pts: number[] = [];
      for (let k = 0; k < 160; k++) {
        const a = (k / 160) * Math.PI * 2;
        pts.push(Math.cos(a) * p.a * AU, 0, Math.sin(a) * p.a * AU);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.group.add(mesh, new THREE.LineLoop(geo, this.orbitMat));
    });
    planetMat.dispose();
    this.stars = createStarfield(2600, 90, 77) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    this.group.add(this.stars, this.zone, this.glow, this.star, this.flare);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const captions: [number, string, number][] = [
      [0.8, 'TRAPPIST-1: червоний карлик за 40 світлових років', 4],
      [5.6, 'Довкола нього — сім планет завбільшки із Землю', 4],
      [10.4, 'Усі вони ближче до зорі, ніж Меркурій до Сонця', 4],
      [15.2, 'Три — у зоні, де може триматися рідка вода', 4],
      [20.2, 'Рік на найближчій планеті триває півтора дня', 4.2],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }
    const fade = smooth(0, 1.4, t) * (1 - smooth(DURATION - 1.4, DURATION, t));

    // A flare now and then (red dwarfs are restless).
    const f = Math.max(0, Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.2));
    const flare = Math.pow(f, 6);
    this.star.material.uniforms.uFade.value = fade;
    // (Opaque bodies faded right out would be black disks over the stars: hide them.)
    this.star.visible = fade > 0.01;
    this.star.material.uniforms.uFlare.value = flare;
    this.glow.intensity = fade * (0.85 + flare * 0.6);
    this.flare.intensity = fade * flare * 0.8;

    for (const p of this.planets) {
      const a = p.phase + (t / p.period) * Math.PI * 2;
      p.mesh.position.set(Math.cos(a) * p.orbit, 0, -Math.sin(a) * p.orbit);
      p.mesh.material.uniforms.uFade.value = fade;
      p.mesh.visible = fade > 0.01;
      // Tidally locked: one face always to the star.
      p.mesh.rotation.y = a;
    }
    this.orbitMat.opacity = 0.16 * fade;
    this.zone.material.uniforms.uAlpha.value = fade * smooth(14.6, 16.4, t) * 0.16;

    const cam = this.ctx.camera;
    const dist = lerp(7.5, 5.2, smooth(8, 22, t));
    const el = THREE.MathUtils.degToRad(lerp(34, 14, smooth(6, 24, t)));
    const az = 0.8 + t * 0.07;
    cam.position.set(Math.cos(el) * Math.sin(az) * dist, Math.sin(el) * dist, Math.cos(el) * Math.cos(az) * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    this.glow.face(cam);
    this.flare.face(cam);
    this.stars.material.uniforms.uOpacity.value = 0.7 * fade;
    this.stars.position.copy(cam.position);
  }

  exit(): void {}

  dispose(): void {
    disposeObject(this.group);
  }
}
