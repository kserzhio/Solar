import * as THREE from 'three';
import { NOISE, globalUniforms } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

const DURATION = 28;
/** The Sun's radius today and as a red giant, and the white dwarf's (world units). */
const R_SUN = 0.45;
const R_GIANT = 4.1;
const R_DWARF = 0.06;
/** Mercury, Venus and Earth: orbit radius, size, colour. */
const PLANETS = [
  { orbit: 1.5, r: 0.12, color: '#a39a90', speed: 0.9 },
  { orbit: 2.6, r: 0.18, color: '#e3c89a', speed: 0.55 },
  { orbit: 4.6, r: 0.19, color: '#5a86c8', speed: 0.4 },
];

/**
 * «Майбутнє Сонця»: the Sun today; in some five billion years, out of hydrogen in its core,
 * it swells into a red giant that swallows Mercury and Venus (Earth's fate is still debated);
 * then it puffs off its outer layers as a planetary nebula, leaving its core, a white dwarf
 * the size of the Earth, to cool for ever.
 */
export class SunFuture implements CuriousScene {
  readonly name = 'sunfuture' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private star: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private nebula: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private glow = new Glow('#ffcf8a', 3, 2.2);
  private dwarf = new Glow('#e8f0ff', 1.6, 2.8);
  /** `left`: how much of each planet is still there (0 once swallowed). */
  private planets: { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>; orbit: number; speed: number; line: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>; left: number }[] = [];
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(private ctx: Ctx) {
    // The star: granulation whose cells grow with the star (a giant's are huge), limb
    // darkening, and a colour from yellow-white to deep orange-red as it swells and cools.
    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uTime: globalUniforms.uTime, uGiant: { value: 0 }, uFade: { value: 0 } },
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
          uniform float uGiant;
          uniform float uFade;
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
            float scale = mix(14.0, 3.2, uGiant);
            float cells = snoise(vLocal * scale + uTime * 0.05) * 0.6 + snoise(vLocal * scale * 2.3 - uTime * 0.08) * 0.4;
            vec3 hot = mix(vec3(1.0, 0.93, 0.78), vec3(1.0, 0.45, 0.16), uGiant);
            vec3 cool = mix(vec3(0.95, 0.6, 0.3), vec3(0.55, 0.12, 0.04), uGiant);
            vec3 col = mix(cool, hot, smoothstep(-0.6, 0.6, cells));
            col *= mix(0.45, 1.0, pow(mu, mix(0.5, 0.8, uGiant)));
            col *= mix(2.2, 1.4, uGiant);
            gl_FragColor = vec4(col * uFade, 1.0);
          }`,
      }),
    );

    // The planetary nebula: a thin expanding shell, bright at its rim (where we look through
    // the most of it), blue-green inside (oxygen) and red at the edge (hydrogen), in tatters.
    this.nebula = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uTime: globalUniforms.uTime, uAlpha: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vView = normalize(cameraPosition - wp.xyz);
            vLocal = position;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          ${NOISE}
          uniform float uTime;
          uniform float uAlpha;
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            float mu = abs(dot(normalize(vN), vView));
            // A shell seen through: a ring, bright where we look along its edge, the middle
            // almost clear.
            float rim = pow(1.0 - mu, 2.2);
            // Filaments and knots, drawn out radially as the gas streams away.
            vec3 q = vLocal * vec3(3.0, 3.0, 3.0);
            float fil = pow(1.0 - abs(snoise(q * 1.7 + uTime * 0.02)), 4.0) * 0.6 + pow(1.0 - abs(snoise(q * 4.1 - 3.0)), 6.0) * 0.4;
            float knots = smoothstep(0.1, 0.8, snoise(q * 0.9 + 5.0) * 0.5 + 0.5);
            vec3 col = mix(vec3(0.25, 0.85, 0.8), vec3(1.0, 0.32, 0.26), smoothstep(0.25, 0.7, rim));
            float a = (0.04 + rim * 0.95) * (0.35 + 0.65 * fil) * (0.55 + 0.45 * knots);
            gl_FragColor = vec4(col * a * uAlpha, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.nebula.visible = false;

    // The inner planets, lit by the star, on faint orbits.
    for (const p of PLANETS) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(p.r, 24, 16),
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(p.color) }, uFade: { value: 1 } },
          vertexShader: /* glsl */ `
            varying vec3 vN;
            varying vec3 vPos;
            void main() {
              vec4 wp = modelMatrix * vec4(position, 1.0);
              vN = normalize(mat3(modelMatrix) * normal);
              vPos = wp.xyz;
              gl_Position = projectionMatrix * viewMatrix * wp;
            }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor;
            uniform float uFade;
            varying vec3 vN;
            varying vec3 vPos;
            void main() {
              float lit = max(dot(normalize(vN), normalize(-vPos)), 0.0);
              gl_FragColor = vec4(uColor * (lit * 1.3 + 0.04) * uFade, 1.0);
            }`,
        }),
      );
      const pts: number[] = [];
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(Math.cos(a) * p.orbit, 0, Math.sin(a) * p.orbit);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0x8fa4c8, transparent: true, opacity: 0.18, depthWrite: false }));
      this.planets.push({ mesh, orbit: p.orbit, speed: p.speed, line, left: 1 });
      this.group.add(mesh, line);
    }
    this.stars = createStarfield(2400, 90, 47) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    this.group.add(this.stars, this.glow, this.star, this.nebula, this.dwarf);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.planets.forEach((p) => (p.left = 1));
    this.ctx.audio.sunFuture(DURATION);
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const captions: [number, string, number][] = [
      [0.8, 'Сонце сьогодні: йому 4,6 мільярда років — середина життя', 4.2],
      [5.6, 'Через 5 мільярдів років у ядрі скінчиться водень', 3.6],
      [9.6, 'Сонце роздметься в червоного гіганта', 3.2],
      [13.2, 'Меркурій і Венеру буде поглинуто', 3.6],
      [18.4, 'Зовнішні шари злетять: планетарна туманність', 4],
      [23.2, 'Залишиться білий карлик — завбільшки із Землю', 4.2],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }
    const fade = smooth(0, 1.4, t) * (1 - smooth(DURATION - 1.4, DURATION, t));

    // Swelling (with a slow pulse once a giant), then the core laid bare.
    const swell = smooth(6, 14, t);
    const shed = smooth(18, 21, t);
    const pulse = 1 + 0.03 * Math.sin(t * 2.1) * swell * (1 - shed);
    const R = lerp(lerp(R_SUN, R_GIANT, swell * swell), R_DWARF, shed) * pulse;
    this.star.scale.setScalar(R);
    const su = this.star.material.uniforms;
    su.uGiant.value = swell * (1 - shed);
    su.uFade.value = fade * (1 - smooth(19.5, 21, t));
    this.star.visible = su.uFade.value > 0.01;
    this.glow.scale.setScalar(R / R_SUN * 0.9);
    this.glow.intensity = fade * (1 - shed) * lerp(0.9, 0.6, swell);
    (this.glow.material.uniforms.uColor.value as THREE.Color).set(swell > 0.5 ? '#ff8a4a' : '#ffcf8a');

    // The white dwarf: tiny, blue-white, very bright.
    this.dwarf.intensity = fade * smooth(19.5, 21.5, t) * 1.3;

    // The nebula grows from the giant's surface outwards and slowly fades.
    const neb = t - 18;
    this.nebula.visible = neb > 0;
    if (neb > 0) {
      this.nebula.scale.setScalar(R_GIANT + 8 * (1 - Math.exp(-neb * 0.22)));
      this.nebula.material.uniforms.uAlpha.value = fade * smooth(0, 1.5, neb) * (1 - smooth(6, 10, neb) * 0.5) * 0.9;
    }

    // Planets: swallowed (gone for good) as the star's surface reaches their orbit.
    for (const p of this.planets) {
      const a = p.speed * t + p.orbit;
      p.mesh.position.set(Math.cos(a) * p.orbit, 0, -Math.sin(a) * p.orbit);
      p.left = Math.min(p.left, 1 - smooth(p.orbit * 0.8, p.orbit * 0.98, R));
      p.mesh.material.uniforms.uFade.value = fade * p.left;
      p.line.material.opacity = 0.18 * fade * p.left;
    }

    const cam = this.ctx.camera;
    // Close on the Sun and its planets, back for the giant, further for the nebula.
    const dist = lerp(6.5, 14, smooth(4, 15, t)) + 6 * smooth(18, 26, t);
    const el = THREE.MathUtils.degToRad(lerp(22, 30, smooth(0, DURATION, t)));
    const az = 0.3 + t * 0.04;
    cam.position.set(Math.cos(el) * Math.sin(az) * dist, Math.sin(el) * dist, Math.cos(el) * Math.cos(az) * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    this.glow.face(cam);
    this.dwarf.face(cam);
    this.stars.material.uniforms.uOpacity.value = 0.7 * fade;
    this.stars.position.copy(cam.position);
  }

  exit(): void {
    this.ctx.audio.sunFuture(0);
  }

  dispose(): void {
    disposeObject(this.group);
  }
}
