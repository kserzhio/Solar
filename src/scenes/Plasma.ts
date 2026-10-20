import * as THREE from 'three';
import { config } from '../config';
import { NOISE, colorUniform } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import { disposeObject } from './util';

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function fullscreen(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, order: number) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return mesh;
}

/**
 * Scene 2: a glowing fog that cools white → orange → red, then recombination: the fog
 * dissolves, light streams free and the viewer is left inside the glowing shell of the
 * cosmic microwave background, which reddens and fades into the Dark Ages.
 */
export class Plasma implements SceneModule {
  readonly name = 'plasma' as const;
  readonly group = new THREE.Group();
  active = false;

  /**
   * Timeline-driven: temperature 1→0, fog intensity, recombination clear-out, CMB shell
   * visibility, the switch to today's false-colour map, redshift and the light-release streaks.
   */
  params = { temp: 1, intensity: 0, clear: 0, cmb: 0, falseColor: 0, redshift: 0, rays: 0 };
  private t = 0;
  private fog: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private shell: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private rays: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private shellT = 0;
  private size = new THREE.Vector2();

  constructor(private ctx: Ctx) {
    const c = config.colors;
    this.fog = fullscreen(
      /* glsl */ `
        ${NOISE}
        uniform float uTime;
        uniform float uTemp;
        uniform float uIntensity;
        uniform float uClear;
        uniform float uAspect;
        uniform vec3 uWhite;
        uniform vec3 uGold;
        uniform vec3 uOrange;
        uniform vec3 uRed;
        varying vec2 vUv;

        vec3 ramp(float t) {
          vec3 col = mix(vec3(0.0), uRed, smoothstep(0.0, 0.3, t));
          col = mix(col, uOrange, smoothstep(0.25, 0.55, t));
          col = mix(col, uGold, smoothstep(0.5, 0.78, t));
          return mix(col, uWhite, smoothstep(0.75, 1.0, t));
        }

        void main() {
          vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
          float t = uTime;

          // Three depths. Nearer layers stream outwards faster, which reads as flying
          // through an expanding medium (parallax without any real geometry).
          // Far: fine, cool, slow.
          vec2 pf = p / (1.0 + t * 0.05);
          float far = fbm3(vec3(pf * 6.0, t * 0.12 + 31.0));
          // Mid: the main warped body of the plasma.
          vec2 pm = p / (1.0 + t * 0.14);
          vec3 q = vec3(pm * 2.0, t * 0.1);
          vec2 warp = vec2(snoise(q), snoise(q + vec3(5.2, 1.3, 2.1)));
          float mid = fbm3(vec3(pm * 3.2 + warp * 0.7, t * 0.16));
          // Near: big soft wisps rushing past the camera.
          vec2 pn = p / (1.0 + t * 0.38);
          float near = snoise(vec3(pn * 1.1, t * 0.22 + 7.0)) * 0.65 + snoise(vec3(pn * 2.3, t * 0.3 + 3.0)) * 0.35;

          float clearMid = 1.0 - uClear * smoothstep(-0.4, 0.5, mid + uClear * 0.9);
          float clearFar = 1.0 - uClear * smoothstep(-0.5, 0.3, far + uClear * 1.1);
          float clearNear = 1.0 - uClear;
          float vign = 1.0 - 0.35 * dot(p, p);

          vec3 colFar = ramp(clamp(uTemp - 0.1 + far * 0.2, 0.0, 1.0)) * clamp(0.25 + far * 0.8, 0.0, 1.0) * 0.45 * clearFar;
          vec3 colMid = ramp(clamp(uTemp + mid * 0.25, 0.0, 1.0)) * clamp(0.35 + mid * 1.3, 0.05, 1.6) * clearMid;
          vec3 col = colFar + colMid;

          // Near wisps: dark silhouettes with hot rims in front of everything else.
          float body = smoothstep(0.05, 0.55, near);
          float rim = smoothstep(0.0, 0.12, near) * (1.0 - smoothstep(0.12, 0.3, near));
          col *= 1.0 - body * 0.5 * clearNear;
          col += ramp(clamp(uTemp + 0.12, 0.0, 1.0)) * rim * 0.35 * clearNear;

          gl_FragColor = vec4(col * uIntensity * vign * 0.6, 1.0);
        }`,
      {
        uTime: { value: 0 },
        uTemp: { value: 1 },
        uIntensity: { value: 0 },
        uClear: { value: 0 },
        uAspect: { value: 1 },
        uWhite: colorUniform(c.plasmaWhite),
        uGold: colorUniform(c.plasmaGold),
        uOrange: colorUniform(c.plasmaOrange),
        uRed: colorUniform(c.plasmaRed),
      },
      -10,
    );

    // The surface of last scattering: we sit inside it, so it is a sky sphere around the camera.
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(80, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: {
          uOpacity: { value: 0 },
          uFalse: { value: 0 },
          uRedshift: { value: 0 },
          uExpand: { value: 0 },
          uReveal: { value: 0 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          ${NOISE}
          uniform float uOpacity;
          uniform float uFalse;
          uniform float uRedshift;
          uniform float uExpand;
          uniform float uReveal;
          varying vec3 vDir;

          // Planck-style false colour: deep blue → cyan → cream → orange → red.
          vec3 planck(float t) {
            t = clamp(t * 0.5 + 0.5, 0.0, 1.0);
            vec3 a = vec3(0.0, 0.03, 0.32);
            vec3 b = vec3(0.05, 0.42, 0.95);
            vec3 c = vec3(0.95, 0.93, 0.82);
            vec3 d = vec3(1.0, 0.52, 0.08);
            vec3 e = vec3(0.6, 0.04, 0.01);
            if (t < 0.25) return mix(a, b, t / 0.25);
            if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
            if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
            return mix(d, e, (t - 0.75) / 0.25);
          }

          void main() {
            vec3 d = normalize(vDir);
            // Expansion stretches the pattern: spots grow as the shell recedes.
            vec3 q = d * (17.0 / (1.0 + uExpand * 0.35));
            // Multi-scale anisotropies: large modulation + the characteristic ~1° spots + fine grain.
            float n = snoise(q * 0.18 + 4.0) * 0.4;
            n += fbm5(q + 3.7) * 1.25;
            n += snoise(q * 2.7 + 11.0) * 0.2;
            n += snoise(q * 5.9 - 7.0) * 0.1;

            // Dissolve in from the fog's holes rather than fading uniformly.
            float reveal = smoothstep(n * 0.6 - 0.15, n * 0.6 + 0.25, uReveal * 1.6 - 0.6);

            // Real colour at ~3000 K: a warm glow with faint ripples.
            vec3 real = vec3(1.0, 0.5, 0.14) * clamp(0.62 + n * 0.9, 0.1, 1.6) * 1.35;
            // What our telescopes show today (Planck false colour).
            vec3 mapped = planck(n * 2.1) * 0.8;
            vec3 col = mix(real, mapped, uFalse);

            // Cosmological redshift: the glow reddens and dims into the Dark Ages.
            col = mix(col, col * vec3(0.7, 0.18, 0.1), uRedshift * (1.0 - uFalse * 0.6));
            col *= 1.0 - uRedshift * 0.7;

            gl_FragColor = vec4(col * reveal * uOpacity * 0.3, 1.0);
          }`,
        side: THREE.BackSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.shell.frustumCulled = false;
    this.shell.renderOrder = -9;

    // Light streaming free: thin radial streaks sweeping outwards once.
    this.rays = fullscreen(
      /* glsl */ `
        ${NOISE}
        uniform float uProgress;
        uniform float uAspect;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
          float r = length(p);
          vec2 dir = p / max(r, 1e-4);
          float streak = pow(clamp(snoise(vec3(dir * 34.0, 1.7)) * 0.5 + 0.5, 0.0, 1.0), 9.0) * 1.6;
          streak += pow(clamp(snoise(vec3(dir * 90.0, 5.3)) * 0.5 + 0.5, 0.0, 1.0), 14.0);
          float front = 0.08 + uProgress * 1.25;
          float band = smoothstep(front - 0.22, front, r) * smoothstep(front + 0.02, front - 0.01, r);
          float glowRing = exp(-(((r - front) / 0.03) * ((r - front) / 0.03))) * 0.25;
          float fade = sin(uProgress * 3.14159) * smoothstep(0.04, 0.25, r);
          vec3 col = vec3(1.0, 0.8, 0.56) * (streak * band + glowRing) * fade;
          gl_FragColor = vec4(col * 0.45, 1.0);
        }`,
      { uProgress: { value: 0 }, uAspect: { value: 1 } },
      -8,
    );

    this.group.add(this.fog, this.shell, this.rays);
  }

  enter(): void {
    this.t = 0;
    Object.assign(this.params, { temp: 1, intensity: 0, clear: 0, cmb: 0, falseColor: 0, redshift: 0, rays: 0 });
    this.shellT = 0;
    this.shell.rotation.set(0.3, 0, 0.15);
  }

  update(dt: number): void {
    this.t += dt;
    this.ctx.renderer.getSize(this.size);
    const aspect = this.size.x / Math.max(1, this.size.y);

    const f = this.fog.material.uniforms;
    f.uTime.value = this.t;
    f.uTemp.value = this.params.temp;
    f.uIntensity.value = this.params.intensity;
    f.uClear.value = this.params.clear;
    f.uAspect.value = aspect;
    this.fog.visible = this.params.intensity * (1 - this.params.clear) > 0.002;

    const { cmb, falseColor, redshift, rays } = this.params;
    const m = this.shell.material.uniforms;
    this.shell.visible = cmb > 0.002;
    if (this.shell.visible) this.shellT += dt;
    m.uOpacity.value = cmb;
    m.uReveal.value = this.params.clear;
    m.uFalse.value = falseColor;
    m.uRedshift.value = redshift;
    m.uExpand.value = this.shellT;
    // The shell surrounds the viewer; a slow drift makes it read as a sky, not a picture.
    this.shell.position.copy(this.ctx.camera.position);
    this.shell.rotation.y += dt * 0.035;

    this.rays.visible = rays > 0.001 && rays < 0.999;
    this.rays.material.uniforms.uProgress.value = rays;
    this.rays.material.uniforms.uAspect.value = aspect;
  }

  exit(): void {}

  applyConfig(): void {
    const f = this.fog.material.uniforms;
    const c = config.colors;
    f.uWhite.value.set(c.plasmaWhite);
    f.uGold.value.set(c.plasmaGold);
    f.uOrange.value.set(c.plasmaOrange);
    f.uRed.value.set(c.plasmaRed);
  }

  dispose(): void {
    disposeObject(this.group);
  }
}
