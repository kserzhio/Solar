import * as THREE from 'three';
import { POINT_FRAG, POINT_SIZE, additiveMaterial, gaussian, globalUniforms, mulberry32 } from '../shaders/common';
import { Glow } from './util';

/** Perihelion distance, eccentricity and the visible arc of the orbit. */
const Q = 4.6;
const E = 0.965;
const P = Q * (1 + E); // semi-latus rectum
const THETA_MAX = 2.55;
const PASSAGE_SECONDS = 26;

const radiusAt = (theta: number) => P / (1 + E * Math.cos(theta));

/**
 * A comet that sweeps through the inner system every so often: a glowing coma,
 * a straight blue ion tail pointing away from the Sun and a curved dusty tail.
 */
export class Comet {
  readonly group = new THREE.Group();
  private head = new Glow('#dff0ff', 1, 2.4);
  private tail: THREE.ShaderMaterial;
  private plane = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42, 0.7, 0.18));
  private theta = -THETA_MAX;
  private passing = false;
  /** Slows the pass down while the camera rides along. */
  timeScale = 1;
  private wait = 7;
  private k: number;
  private rand = mulberry32(404);
  private pos = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private anti = new THREE.Vector3();
  private announced = false;
  /** Up close: the dark, irregular nucleus and the gas jets boiling off its sunlit side. */
  private nucleus: THREE.Mesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
  private jets: THREE.ShaderMaterial;
  /** Fired once per pass as the comet swings round the Sun (x: -1..1 on screen). */
  onPerihelion: (screenX: number) => void = () => {};

  constructor() {
    // Kepler-like pacing (faster near the Sun), softened so the far ends don't drag.
    let sum = 0;
    for (let t = -THETA_MAX; t < THETA_MAX; t += 0.01) sum += Math.pow(radiusAt(t), 1.25) * 0.01;
    this.k = sum / PASSAGE_SECONDS;

    const count = 7200;
    const rand = mulberry32(77);
    const data = new Float32Array(count * 4);
    const off = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      data.set([rand(), rand() < 0.45 ? 0 : 1, rand(), rand()], i * 4);
      off.set([gaussian(rand), gaussian(rand)], i * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    geometry.setAttribute('aOff', new THREE.BufferAttribute(off, 2));
    this.tail = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform vec3 uHead;
        uniform vec3 uAnti;
        uniform vec3 uVel;
        uniform float uLen;
        uniform float uFade;
        uniform float uTime;
        attribute vec4 aData;
        attribute vec2 aOff;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          bool ion = aData.y < 0.5;
          // Particles stream outwards along the tail and recycle at the head.
          float s = fract(aData.x + uTime * (ion ? 0.35 : 0.12) * (0.7 + aData.z * 0.6));
          vec3 axis = ion ? uAnti : normalize(uAnti - uVel * 0.55);
          float len = uLen * (ion ? 1.0 : 0.7);
          vec3 side1 = normalize(cross(axis, vec3(0.0, 1.0, 0.0) + uVel * 0.01));
          vec3 side2 = normalize(cross(axis, side1));
          float spread = ion ? 0.03 + s * 0.12 : 0.05 + s * 0.45;
          vec3 p = uHead + axis * s * len + (side1 * aOff.x + side2 * aOff.y) * spread;
          if (!ion) p -= uVel * s * s * len * 0.22; // dust lags behind along the orbit
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vColor = ion ? vec3(0.45, 0.68, 1.0) : vec3(1.0, 0.88, 0.68);
          vAlpha = uFade * pow(1.0 - s, 1.4) * (ion ? 0.42 : 0.3);
          gl_PointSize = min(pointSize((ion ? 0.16 : 0.26) * (1.0 - s * 0.3), -mv.z, vAlpha), 22.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uHead: { value: new THREE.Vector3() },
        uAnti: { value: new THREE.Vector3(1, 0, 0) },
        uVel: { value: new THREE.Vector3(0, 0, 1) },
        uLen: { value: 3 },
        uFade: { value: 0 },
        uTime: globalUniforms.uTime,
      },
    );
    const points = new THREE.Points(geometry, this.tail);
    points.frustumCulled = false;

    // A lumpy, coal-dark nucleus a few km across (here a speck you only see up close).
    const ng = new THREE.IcosahedronGeometry(0.07, 4);
    const np = ng.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < np.count; i++) {
      v.fromBufferAttribute(np, i);
      const n = Math.sin(v.x * 61 + 1.3) * Math.sin(v.y * 47 + 0.4) * Math.sin(v.z * 53 + 2.1);
      v.multiplyScalar(0.82 + n * 0.22).multiply(new THREE.Vector3(1.25, 0.85, 0.95));
      np.setXYZ(i, v.x, v.y, v.z);
    }
    ng.computeVertexNormals();
    this.nucleus = new THREE.Mesh(
      ng,
      new THREE.ShaderMaterial({
        uniforms: { uFade: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vW;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uFade;
          varying vec3 vN;
          varying vec3 vW;
          void main() {
            float diff = max(dot(normalize(vN), normalize(-vW)), 0.0);
            gl_FragColor = vec4(vec3(0.22, 0.2, 0.19) * (0.04 + diff * 1.4), uFade);
          }`,
        transparent: true,
      }),
    );

    // Jets: gas and dust bursting from the sunlit side, then pushed back by sunlight.
    const jc = 900;
    const jd = new Float32Array(jc * 4);
    const jr = mulberry32(909);
    for (let i = 0; i < jc; i++) jd.set([jr(), jr() * 2 - 1, jr() * 2 - 1, Math.floor(jr() * 4)], i * 4);
    const jg = new THREE.BufferGeometry();
    jg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(jc * 3), 3));
    jg.setAttribute('aData', new THREE.BufferAttribute(jd, 4));
    this.jets = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform vec3 uHead;
        uniform vec3 uAnti;
        uniform float uFade;
        uniform float uTime;
        attribute vec4 aData;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float s = fract(aData.x + uTime * 0.6);
          // Four active vents on the day side, each a narrow fan.
          vec3 sun = -uAnti;
          vec3 side1 = normalize(cross(sun, vec3(0.0, 1.0, 0.0)));
          vec3 side2 = cross(sun, side1);
          float vent = aData.w;
          vec3 base = normalize(sun + side1 * (vent < 2.0 ? 0.55 : -0.5) * (mod(vent, 2.0) < 1.0 ? 1.0 : 0.3) + side2 * (mod(vent, 2.0) < 1.0 ? 0.3 : -0.6));
          vec3 dir = normalize(base + (side1 * aData.y + side2 * aData.z) * 0.18);
          vec3 p = uHead + dir * s * 0.55 + uAnti * s * s * 0.9;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vColor = vec3(0.86, 0.92, 1.0);
          vAlpha = uFade * (1.0 - s) * (1.0 - s) * 0.9;
          gl_PointSize = min(pointSize(0.03 * (0.6 + s * 1.4), -mv.z, vAlpha), 10.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      { uHead: { value: new THREE.Vector3() }, uAnti: { value: new THREE.Vector3(1, 0, 0) }, uFade: { value: 0 }, uTime: globalUniforms.uTime },
    );
    const jets = new THREE.Points(jg, this.jets);
    jets.frustumCulled = false;
    this.group.add(points, this.head, this.nucleus, jets);
    this.group.visible = false;
  }

  /** True while a pass is under way. */
  get flying(): boolean {
    return this.passing;
  }

  get headPosition(): THREE.Vector3 {
    return this.pos;
  }

  get tailDirection(): THREE.Vector3 {
    return this.anti;
  }

  /** Starts a pass now, a little before it swings round the Sun (for a close look). */
  launch(): void {
    if (this.flying) return;
    this.wait = 0;
    this.update(0, null, 1);
    this.theta = -1.1;
  }

  reset(firstDelay = 7): void {
    this.passing = false;
    this.wait = firstDelay;
    this.group.visible = false;
  }

  update(dt: number, camera: THREE.Camera | null, fade: number): void {
    if (!this.passing) {
      this.wait -= dt;
      if (this.wait > 0) return;
      this.passing = true;
      this.theta = -THETA_MAX;
      this.announced = false;
      // Each visit comes in on a slightly different plane.
      this.plane.setFromEuler(new THREE.Euler(0.25 + this.rand() * 0.4, this.rand() * Math.PI * 2, (this.rand() - 0.5) * 0.4));
    }
    const r = radiusAt(this.theta);
    this.theta += (dt * this.timeScale * this.k) / Math.pow(r, 1.25);
    if (this.theta > THETA_MAX) {
      this.passing = false;
      this.wait = 30 + this.rand() * 30;
      this.group.visible = false;
      return;
    }
    if (!this.announced && this.theta > -0.45) {
      this.announced = true;
      const x = camera ? this.pos.clone().project(camera).x : 0;
      this.onPerihelion(THREE.MathUtils.clamp(x, -1, 1));
    }
    this.prev.copy(this.pos);
    this.pos.set(Math.cos(this.theta) * r, 0, -Math.sin(this.theta) * r).applyQuaternion(this.plane);
    this.vel.subVectors(this.pos, this.prev);
    if (this.vel.lengthSq() > 1e-8) this.vel.normalize();
    this.anti.copy(this.pos).normalize();

    // Brighter and longer-tailed close to the Sun; fades in and out at the far ends.
    const edge = Math.min(1, (THETA_MAX - Math.abs(this.theta)) / 0.5);
    const brightness = THREE.MathUtils.clamp(18 / r, 0.55, 1.6) * edge * fade;
    const u = this.tail.uniforms;
    u.uHead.value.copy(this.pos);
    u.uAnti.value.copy(this.anti);
    u.uVel.value.copy(this.vel);
    u.uLen.value = THREE.MathUtils.clamp(70 / r, 3.5, 11);
    u.uFade.value = brightness;
    this.head.position.copy(this.pos);
    this.head.scale.setScalar(1.2 + brightness * 0.8);
    this.head.intensity = brightness * 1.4;
    if (camera) this.head.face(camera);
    this.group.visible = brightness > 0.01;
    // Nucleus and jets only matter (and only show) from close by.
    const near = camera ? 1 - THREE.MathUtils.smoothstep(camera.position.distanceTo(this.pos), 3, 9) : 0;
    this.nucleus.position.copy(this.pos);
    this.nucleus.rotation.y += dt * 0.4;
    this.nucleus.rotation.x += dt * 0.13;
    this.nucleus.material.uniforms.uFade.value = Math.min(1, fade);
    this.nucleus.visible = near > 0.01;
    this.jets.uniforms.uHead.value.copy(this.pos);
    this.jets.uniforms.uAnti.value.copy(this.anti);
    this.jets.uniforms.uFade.value = brightness * near;
    // Near the Sun the coma glows less overwhelmingly when we are right next to the nucleus.
    this.head.intensity *= 1 - near * 0.8;
  }
}
