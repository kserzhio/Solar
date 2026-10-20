import * as THREE from 'three';
import { config, particleCount } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, colorUniform, gaussian, mulberry32 } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import { Glow, disposeObject } from './util';

const RADIUS = 1.7;

/** Scene 0: a breathing grey gas mass that follows the cursor and collapses on click. */
export class Singularity implements SceneModule {
  readonly name = 'singularity' as const;
  readonly group = new THREE.Group();
  active = false;

  /** Driven by the master timeline: 0 = calm, 1 = collapsed into a point. */
  /** collapse: into a point; inflate: the point inflates beyond the screen. */
  params = { collapse: 0, inflate: 0 };
  hovered = false;

  private material: THREE.ShaderMaterial;
  private core = new Glow('#fff6e8', 1.6, 3.0);
  private haze = new Glow('#8e95a8', 6.5, 1.8);
  private foam: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private ray = new THREE.Raycaster();
  private mouse = new THREE.Vector3();
  private mouseTarget = new THREE.Vector3();
  private hoverSmooth = 0;
  private strengthSmooth = 0;
  private unregister: () => void;

  constructor(private ctx: Ctx) {
    const count = particleCount('singularity');
    const rand = mulberry32(7);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Dense core with a soft gaussian fall-off.
      // Isotropic cloud: random direction, radius with a soft gaussian-like fall-off.
      const v = new THREE.Vector3().randomDirection();
      v.multiplyScalar(Math.min(1.1, Math.abs(gaussian(rand)) * 0.45 + rand() * 0.1));
      positions.set([v.x, v.y, v.z], i * 3);
      seeds.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

    this.material = additiveMaterial(
      /* glsl */ `
        ${NOISE}
        ${POINT_SIZE}
        uniform float uTime;
        uniform float uCollapse;
        uniform float uHover;
        uniform float uOpacity;
        uniform vec3 uMouse;
        uniform float uMouseStrength;
        uniform vec3 uColor;
        uniform float uRadius;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          float r0 = length(position);
          vec3 p = position * uRadius;
          float t = uTime * 0.11;

          // Slow volumetric churn.
          // Bounded churn: raw curl magnitude varies a lot, so normalise it, and calm the
          // rim so the silhouette stays round instead of growing lobes.
          vec3 c1 = curlNoise(p * 0.9 + vec3(0.0, t, t * 0.6));
          vec3 c2 = curlNoise(p * 2.3 - vec3(t * 1.3));
          float rim = 1.0 - smoothstep(0.35, 1.0, r0);
          p += c1 / (1.0 + length(c1)) * 0.16 * (0.35 + 0.65 * rim);
          p += c2 / (1.0 + length(c2)) * 0.06;

          float spin = uTime * 0.04 * (1.4 - r0);
          float cs = cos(spin); float sn = sin(spin);
          p.xz = mat2(cs, -sn, sn, cs) * p.xz;

          float breath = 1.0 + 0.045 * sin(uTime * 0.85) + 0.018 * sin(uTime * 2.1 + aSeed.y * 6.283) * aSeed.z;
          p *= breath;

          // Cursor: stretch towards it and swirl around it.
          vec3 toM = uMouse - p;
          float d2 = dot(toM, toM);
          float infl = uMouseStrength * exp(-d2 * 0.75) * (0.4 + 0.6 * aSeed.x);
          vec3 swirl = cross(normalize(toM + 1e-5), vec3(0.0, 0.0, 1.0));
          p += toM * infl * 0.22 + swirl * infl * 0.3;

          // Collapse: spiral into a single bright point.
          float k = uCollapse * uCollapse;
          float twist = k * (3.0 + aSeed.w * 4.0);
          float ct = cos(twist); float st = sin(twist);
          p.xy = mat2(ct, -st, st, ct) * p.xy;
          p *= mix(1.0, 0.012 + aSeed.x * 0.02, k);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float pulse = 0.88 + 0.12 * sin(uTime * 0.85 - r0 * 2.0);
          float bright = (0.32 + 0.5 * exp(-r0 * r0 * 4.0)) * pulse * (1.0 + uHover * 0.55) * (1.0 + k * 9.0);
          vColor = mix(uColor, vec3(1.0, 0.96, 0.88), k) * bright;
          vAlpha = uOpacity * (0.08 + 0.22 * aSeed.w);
          gl_PointSize = pointSize(0.05 * (0.4 + aSeed.x) * mix(1.0, 0.5, k), -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uTime: { value: 0 },
        uCollapse: { value: 0 },
        uHover: { value: 0 },
        uOpacity: { value: 1 },
        uMouse: { value: new THREE.Vector3(99, 99, 0) },
        uMouseStrength: { value: 0 },
        uColor: colorUniform(config.colors.singularity),
        uRadius: { value: RADIUS },
      },
    );

    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    this.group.add(points);
    // Inflation: quantum foam drawn in the quad's own UV space, so as the quad inflates
    // the fluctuations are stretched to cosmic size (the seeds of later structure).
    this.foam = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uInflate: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          ${NOISE}
          uniform float uInflate;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - 0.5) * 2.0;
            float d = length(p);
            if (d > 1.0) discard;
            float n = fbm3(vec3(p * 9.0, 1.7)) * 0.85 + snoise(vec3(p * 42.0, 4.2)) * 0.22;
            vec3 col = mix(vec3(0.5, 0.56, 1.0), vec3(1.0, 0.93, 0.82), smoothstep(-0.45, 0.5, n));
            float body = smoothstep(1.0, 0.0, d) * (0.45 + 0.65 * n);
            float rim = exp(-(((d - 0.965) / 0.03) * ((d - 0.965) / 0.03)));
            float a = (max(body, 0.0) * 0.85 + rim * 1.1) * smoothstep(0.0, 0.08, uInflate);
            gl_FragColor = vec4(col * a * (0.55 + uInflate * 0.75), 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.foam.frustumCulled = false;
    this.foam.visible = false;
    this.group.add(this.haze, this.core, this.foam);
    this.unregister = ctx.quality.register(geometry, count);
  }

  enter(): void {
    this.params.collapse = 0;
    this.params.inflate = 0;
    this.hoverSmooth = 0;
    this.strengthSmooth = 0;
    this.material.uniforms.uOpacity.value = 1;
    const cam = this.ctx.camera;
    cam.position.set(0, 0, 7);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
  }

  update(dt: number, time: number): void {
    const u = this.material.uniforms;
    const { pointer, camera } = this.ctx;
    const k = Math.min(1, dt * 4);

    // Cursor on the z = 0 plane.
    this.ray.setFromCamera(pointer.ndc, camera);
    const hit = this.ray.ray.intersectPlane(this.plane, this.mouseTarget);
    const live = pointer.inside && !!hit && this.params.collapse === 0;
    if (live) this.mouse.lerp(this.mouseTarget, Math.min(1, dt * 6));
    this.strengthSmooth += ((live ? 1 : 0) - this.strengthSmooth) * k;

    this.hovered = live && this.mouseTarget.length() < RADIUS * 0.95;
    this.hoverSmooth += ((this.hovered ? 1 : 0) - this.hoverSmooth) * k;

    u.uTime.value = time;
    u.uMouse.value.copy(this.mouse);
    u.uMouseStrength.value = this.strengthSmooth;
    u.uHover.value = this.hoverSmooth;
    u.uCollapse.value = this.params.collapse;

    const c = this.params.collapse;
    this.core.intensity = c * c * c * 2.2 * (1 - this.params.inflate);
    this.core.scale.setScalar(0.4 + c * 0.8);
    this.core.face(camera);
    // Exponential growth: from a speck to far beyond the frame in half a second.
    const inf = this.params.inflate;
    this.foam.visible = inf > 0.001;
    this.foam.material.uniforms.uInflate.value = inf;
    this.foam.scale.setScalar(0.04 * Math.pow(1200, inf));
    this.foam.quaternion.copy(camera.quaternion);
    const breath = 1 + 0.05 * Math.sin(time * 0.85);
    this.haze.intensity = (0.16 + this.hoverSmooth * 0.08) * (1 - c) * breath;
    this.haze.scale.setScalar(breath * (1 - c * 0.8));
    this.haze.face(camera);
  }

  exit(): void {
    this.hovered = false;
  }

  applyConfig(): void {
    this.material.uniforms.uColor.value.set(config.colors.singularity);
  }

  dispose(): void {
    this.unregister();
    disposeObject(this.group);
  }
}
