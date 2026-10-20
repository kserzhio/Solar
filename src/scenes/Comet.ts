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
  private flying = false;
  private wait = 7;
  private k: number;
  private rand = mulberry32(404);
  private pos = new THREE.Vector3();
  private prev = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private anti = new THREE.Vector3();
  private announced = false;
  /** Fired once per pass as the comet swings round the Sun (x: -1..1 on screen). */
  onPerihelion: (screenX: number) => void = () => {};

  constructor() {
    // Kepler-like pacing (faster near the Sun), softened so the far ends don't drag.
    let sum = 0;
    for (let t = -THETA_MAX; t < THETA_MAX; t += 0.01) sum += Math.pow(radiusAt(t), 1.25) * 0.01;
    this.k = sum / PASSAGE_SECONDS;

    const count = 2600;
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
          vAlpha = uFade * pow(1.0 - s, 1.4) * (ion ? 0.7 : 0.5);
          gl_PointSize = min(pointSize((ion ? 0.12 : 0.18) * (1.0 - s * 0.3), -mv.z, vAlpha), 12.0);
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
    this.group.add(points, this.head);
    this.group.visible = false;
  }

  reset(firstDelay = 7): void {
    this.flying = false;
    this.wait = firstDelay;
    this.group.visible = false;
  }

  update(dt: number, camera: THREE.Camera, fade: number): void {
    if (!this.flying) {
      this.wait -= dt;
      if (this.wait > 0) return;
      this.flying = true;
      this.theta = -THETA_MAX;
      this.announced = false;
      // Each visit comes in on a slightly different plane.
      this.plane.setFromEuler(new THREE.Euler(0.25 + this.rand() * 0.4, this.rand() * Math.PI * 2, (this.rand() - 0.5) * 0.4));
    }
    const r = radiusAt(this.theta);
    this.theta += (dt * this.k) / Math.pow(r, 1.25);
    if (this.theta > THETA_MAX) {
      this.flying = false;
      this.wait = 30 + this.rand() * 30;
      this.group.visible = false;
      return;
    }
    if (!this.announced && this.theta > -0.45) {
      this.announced = true;
      const x = this.pos.clone().project(camera).x;
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
    this.head.face(camera);
    this.group.visible = brightness > 0.01;
  }
}
