import * as THREE from 'three';
import { NOISE, globalUniforms } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

const DURATION = 24;
/** Angle between the spin axis and the magnetic axis. */
const TILT = THREE.MathUtils.degToRad(38);

/**
 * «Пульсар»: a neutron star, the collapsed core left by a supernova — a city-sized ball
 * heavier than the Sun, spinning many times a second. Charged particles race along its
 * magnetic axis, which is tilted to the spin axis, so two beams sweep around like a
 * lighthouse; each time one crosses us we see a pulse. The spin here is slowed right down.
 */
export class Pulsar implements CuriousScene {
  readonly name = 'pulsar' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private spin = 0;
  /** Everything that turns with the star; the magnetic frame is tilted inside it. */
  private rotor = new THREE.Group();
  private magnetic = new THREE.Group();
  private star: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private beams: THREE.ShaderMaterial;
  private field: THREE.LineBasicMaterial;
  private glow = new Glow('#bcd4ff', 3.2, 2.2);
  private pulse = new Glow('#e8f0ff', 16, 1.8);
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private tmp = new THREE.Vector3();

  constructor(private ctx: Ctx) {
    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uTime: globalUniforms.uTime, uFade: { value: 0 } },
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
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
            // Million-degree surface: blue-white, with hot spots where the field lines come in.
            float pole = pow(abs(vLocal.y), 18.0);
            float crust = snoise(vLocal * 9.0 + uTime * 0.2) * 0.5 + 0.5;
            vec3 col = mix(vec3(0.62, 0.74, 1.0), vec3(0.92, 0.96, 1.0), crust * 0.4 + pole);
            col *= 1.3 + pole * 3.0;
            col *= 0.55 + 0.45 * sqrt(mu);
            gl_FragColor = vec4(col * uFade, 1.0);
          }`,
      }),
    );

    // Two beams along the magnetic axis: long, open cones that glow along their axis.
    this.beams = new THREE.ShaderMaterial({
      uniforms: { uTime: globalUniforms.uTime, uFade: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vLocal;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vLocal = position;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vView = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        uniform float uTime;
        uniform float uFade;
        varying vec3 vLocal;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          float along = abs(vLocal.y) / 26.0;
          // Brightest along the beam's core (where we look straight through the cone).
          float core = pow(abs(dot(normalize(vN), vView)), 2.5);
          float flicker = 0.75 + 0.25 * snoise(vec3(vLocal.y * 0.4 - uTime * 6.0, atan(vLocal.z, vLocal.x), 0.0));
          float a = core * (1.0 - smoothstep(0.1, 1.0, along)) * smoothstep(0.0, 0.03, along) * flicker;
          gl_FragColor = vec4(vec3(0.62, 0.76, 1.0) * a * uFade * 1.4, 1.0);
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (const sign of [1, -1]) {
      const geo = new THREE.CylinderGeometry(3.2, 0.05, 26, 48, 1, true);
      geo.translate(0, 13 + 0.45, 0);
      const cone = new THREE.Mesh(geo, this.beams);
      cone.rotation.x = sign > 0 ? 0 : Math.PI;
      cone.frustumCulled = false;
      this.magnetic.add(cone);
    }

    // Dipole field lines r = L sin^2(theta) around the magnetic axis.
    const pts: number[] = [];
    for (const L of [1.4, 2.2, 3.4, 5]) {
      for (let k = 0; k < 8; k++) {
        const az = (k / 8) * Math.PI * 2;
        let prev: THREE.Vector3 | null = null;
        for (let i = 0; i <= 64; i++) {
          const th = 0.12 + (i / 64) * (Math.PI - 0.24);
          const r = L * Math.sin(th) ** 2;
          if (r < 0.5) {
            prev = null;
            continue;
          }
          const p = new THREE.Vector3(Math.sin(th) * Math.cos(az) * r, Math.cos(th) * r, Math.sin(th) * Math.sin(az) * r);
          if (prev) pts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
          prev = p;
        }
      }
    }
    const fieldGeo = new THREE.BufferGeometry();
    fieldGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.field = new THREE.LineBasicMaterial({ color: 0x7fa6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.magnetic.add(new THREE.LineSegments(fieldGeo, this.field));
    this.magnetic.rotation.z = TILT;

    this.rotor.add(this.star, this.magnetic);
    this.stars = createStarfield(2400, 90, 33) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    this.group.add(this.stars, this.rotor, this.glow, this.pulse);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.spin = 0;
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const captions: [number, string, number][] = [
      [0.8, 'Нейтронна зоря: Сонце, стиснуте до 20 км', 3.8],
      [6.8, 'Ложка її речовини важить мільярди тонн', 3.6],
      [12.4, 'Промені — як маяк: спалах на кожному оберті', 4],
      [18.4, 'Найшвидші обертаються 716 разів на секунду', 4],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }
    const fade = smooth(0, 1.4, t) * (1 - smooth(DURATION - 1.4, DURATION, t));

    // Spin (slowed a thousandfold and more): about 0.8 turns a second.
    this.spin += dt * Math.PI * 2 * 0.8;
    this.rotor.rotation.y = this.spin;

    // The camera sits at the beam's tilt from the spin axis, so a beam sweeps across it
    // once per turn; it drifts slowly round and pulls back a little.
    const cam = this.ctx.camera;
    const dist = lerp(11, 15, smooth(0, DURATION, t));
    const pol = Math.PI / 2 - TILT;
    const az = 0.4 + t * 0.05;
    cam.position.set(Math.cos(pol) * Math.sin(az) * dist, Math.sin(pol) * dist * 0.98, Math.cos(pol) * Math.cos(az) * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);

    // How closely a beam points at us right now.
    this.magnetic.updateMatrixWorld();
    const axis = this.tmp.set(0, 1, 0).applyQuaternion(this.magnetic.getWorldQuaternion(new THREE.Quaternion()));
    const toCam = cam.position.clone().normalize();
    const facing = Math.abs(axis.dot(toCam));
    const flash = Math.pow(smooth(0.9, 1.0, facing), 2);

    this.star.material.uniforms.uFade.value = fade;
    this.beams.uniforms.uFade.value = fade;
    this.field.opacity = 0.22 * fade;
    this.glow.intensity = (0.8 + flash * 1.2) * fade;
    this.glow.face(cam);
    this.pulse.intensity = flash * 1.6 * fade;
    this.pulse.face(cam);
    this.stars.material.uniforms.uOpacity.value = 0.75 * fade;
    this.stars.position.copy(cam.position);
  }

  exit(): void {}

  dispose(): void {
    disposeObject(this.group);
  }
}
