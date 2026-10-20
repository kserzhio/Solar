import * as THREE from 'three';
import { config, particleCount } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, colorUniform, mulberry32 } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import { Glow, disposeObject, lerp } from './util';

/**
 * Scene 1: the flash, a shock ring, matter flying outwards and a faint coordinate
 * lattice that stretches with space itself. Its particles keep expanding and
 * cooling through scene 2 (the timeline drives `temp` and `fade`).
 */
export class BigBang implements SceneModule {
  readonly name = 'bang' as const;
  readonly group = new THREE.Group();
  active = false;

  params = { temp: 1, fade: 1 };
  private t = 0;
  private material: THREE.ShaderMaterial;
  private ring: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private lattice: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private streaks: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private core = new Glow('#fff8ec', 3.2, 2.6);
  private unregister: () => void;

  constructor(private ctx: Ctx) {
    const count = particleCount('bang');
    const rand = mulberry32(11);
    const dirs = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.randomDirection();
      dirs.set([v.x, v.y, v.z], i * 3);
      // Speed skewed so the volume fills evenly instead of forming a hollow shell.
      seeds.set([Math.cbrt(rand()), rand(), rand(), rand()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(dirs, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

    this.material = additiveMaterial(
      /* glsl */ `
        ${NOISE}
        ${POINT_SIZE}
        uniform float uT;
        uniform float uTemp;
        uniform float uFade;
        uniform vec3 uHot;
        uniform vec3 uCool;
        uniform vec3 uRed;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float speed = aSeed.x;
          // Explosive start that settles into a steady Hubble-like flow.
          float a = (1.0 - exp(-uT * 1.7)) * 13.0 + uT * 1.1;
          vec3 p = position * speed * a;
          float turb = min(uT * 0.8, 1.0);
          p += curlNoise(position * 1.6 + vec3(uT * 0.08)) * 0.35 * turb * (0.4 + speed);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vec3 col = uTemp > 0.5
            ? mix(uCool, uHot, (uTemp - 0.5) * 2.0)
            : mix(uRed * 0.6, uCool, uTemp * 2.0);
          float burst = 1.0 + 5.0 * exp(-uT * 2.6);
          vColor = col * burst * (0.8 + aSeed.y * 1.2);
          vAlpha = uFade * (0.3 + 0.5 * aSeed.z);
          gl_PointSize = pointSize(0.05 * (0.4 + aSeed.w), -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uT: { value: 0 },
        uTemp: { value: 1 },
        uFade: { value: 1 },
        uHot: colorUniform(config.colors.bangHot),
        uCool: colorUniform(config.colors.bangCool),
        uRed: colorUniform(config.colors.plasmaRed),
      },
    );
    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    this.group.add(points);
    this.unregister = ctx.quality.register(geometry, count);

    this.ring = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 18),
      new THREE.ShaderMaterial({
        uniforms: { uR: { value: 0 }, uIntensity: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uR;
          uniform float uIntensity;
          varying vec2 vUv;
          void main() {
            float d = length(vUv - 0.5) * 2.0;
            float w = 0.012 + uR * 0.05;
            float ring = exp(-(((d - uR) / w) * ((d - uR) / w)));
            float ring2 = exp(-(((d - uR * 0.82) / (w * 2.5)) * ((d - uR * 0.82) / (w * 2.5)))) * 0.35;
            float inner = smoothstep(uR, 0.0, d) * 0.035;
            vec3 col = vec3(1.0, 0.93, 0.8) * (ring + ring2) + vec3(1.0, 0.75, 0.45) * inner;
            gl_FragColor = vec4(col * uIntensity, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.ring.frustumCulled = false;
    this.group.add(this.ring);

    this.lattice = this.buildLattice();
    this.streaks = this.buildStreaks();
    this.group.add(this.lattice, this.streaks);
    this.group.add(this.core);
  }

  /**
   * Light streaks for the fastest matter: each segment runs from where a particle was a
   * moment ago to where it is now, so streaks are long while expansion is violent and
   * shrink to dots as it calms down.
   */
  private buildStreaks() {
    const count = Math.round(4500 * Math.min(1.5, config.particleScale));
    const rand = mulberry32(31);
    const dirs = new Float32Array(count * 2 * 3);
    const data = new Float32Array(count * 2 * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.randomDirection();
      const speed = 0.6 + Math.sqrt(rand()) * 0.5;
      const tint = rand();
      for (let k = 0; k < 2; k++) {
        dirs.set([v.x, v.y, v.z], (i * 2 + k) * 3);
        data.set([speed, tint, k], (i * 2 + k) * 3); // k = 0 tail, 1 head
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(dirs, 3));
    geometry.setAttribute('aData', new THREE.BufferAttribute(data, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uFade: { value: 1 }, uHot: colorUniform(config.colors.bangHot), uCool: colorUniform(config.colors.bangCool) },
      vertexShader: /* glsl */ `
        uniform float uT;
        attribute vec3 aData;
        varying float vHead;
        varying float vTint;
        float expansion(float t) { return (1.0 - exp(-t * 1.7)) * 13.0 + t * 1.1; }
        void main() {
          float t = aData.z > 0.5 ? uT : max(uT - 0.07, 0.0);
          vec3 p = position * aData.x * expansion(t);
          vHead = aData.z;
          vTint = aData.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uT;
        uniform float uFade;
        uniform vec3 uHot;
        uniform vec3 uCool;
        varying float vHead;
        varying float vTint;
        void main() {
          float life = exp(-uT * 1.1) * smoothstep(0.0, 0.05, uT);
          vec3 col = mix(uHot, uCool, vTint * 0.6 + (1.0 - vHead) * 0.4) * 1.4;
          gl_FragColor = vec4(col, vHead * vHead * life * uFade * 0.6);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    return lines;
  }

  private buildLattice() {
    const n = 4;
    const pts: number[] = [];
    for (let a = -n; a <= n; a++) {
      for (let b = -n; b <= n; b++) {
        pts.push(-n, a, b, n, a, b); // along x
        pts.push(a, -n, b, a, n, b); // along y
        pts.push(a, b, -n, a, b, n); // along z
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 }, uOpacity: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uScale;
        varying float vFall;
        void main() {
          vFall = 1.0 - smoothstep(1.5, 4.2, length(position));
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position * uScale, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vFall;
        void main() { gl_FragColor = vec4(vec3(0.75, 0.82, 1.0), uOpacity * vFall); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.rotation.set(0.42, 0.62, 0.1);
    lines.frustumCulled = false;
    return lines;
  }

  enter(): void {
    this.t = 0;
    this.params.temp = 1;
    this.params.fade = 1;
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const u = this.material.uniforms;
    u.uT.value = t;
    u.uTemp.value = this.params.temp;
    u.uFade.value = this.params.fade;
    this.streaks.material.uniforms.uT.value = t;
    this.streaks.material.uniforms.uFade.value = this.params.fade;
    this.streaks.visible = t < 4;

    // Shock ring: fast ease-out expansion.
    const rp = 1 - Math.exp(-t * 1.5);
    this.ring.material.uniforms.uR.value = rp * 0.95;
    this.ring.material.uniforms.uIntensity.value = Math.max(0, 1.7 * Math.exp(-t * 1.1) - 0.02);

    // Space itself stretches: the lattice scales up and dissolves.
    const lu = this.lattice.material.uniforms;
    lu.uScale.value = 0.5 + (1 - Math.exp(-t * 0.9)) * 9 + t * 0.6;
    lu.uOpacity.value = Math.min(1, t * 6) * Math.max(0, 1 - t / 2.6) * 0.22;
    this.lattice.rotation.y += dt * 0.05;

    this.core.intensity = 3 * Math.exp(-t * 3.2) * this.params.fade;
    this.core.scale.setScalar(1 + t * 0.6);

    // Camera pulls back with a decaying shake.
    const cam = this.ctx.camera;
    const back = lerp(6, 15, 1 - Math.exp(-t * 0.5));
    cam.position.set(0, 0, back);
    if (!this.ctx.reducedMotion) {
      const amp = 0.22 * Math.exp(-t * 2.6);
      cam.position.x += Math.sin(t * 61.3) * amp + Math.sin(t * 23.1) * amp * 0.5;
      cam.position.y += Math.cos(t * 53.7) * amp + Math.sin(t * 31.7) * amp * 0.5;
    }
    cam.lookAt(0, 0, 0);
    this.ring.quaternion.copy(cam.quaternion);
    this.core.face(cam);
  }

  exit(): void {}

  applyConfig(): void {
    const u = this.material.uniforms;
    u.uHot.value.set(config.colors.bangHot);
    u.uCool.value.set(config.colors.bangCool);
    u.uRed.value.set(config.colors.plasmaRed);
    this.streaks.material.uniforms.uHot.value.set(config.colors.bangHot);
    this.streaks.material.uniforms.uCool.value.set(config.colors.bangCool);
  }

  dispose(): void {
    this.unregister();
    disposeObject(this.group);
  }
}
