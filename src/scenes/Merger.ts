import * as THREE from 'three';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

const DURATION = 26;
/** Seconds into the scene at which the two holes merge. */
const MERGE = 14;
/** Orbital angular speed (radians a second) at the start, and the starting separation. */
const W0 = 1.1;
const A0 = 3.2;
/** Speed of the waves across the grid (world units a second). */
const WAVE_C = 5;

/**
 * Inspiral as a function of time to merger, with the leading (Newtonian) chirp: separation
 * a ∝ (1 − t/tc)^¼, angular speed ω ∝ (1 − t/tc)^−⅜, so the phase is
 * φ = (8/5)·ω₀·tc·(1 − (1 − t/tc)^⅝). Clamped just short of the merger.
 */
function orbit(t: number): { phase: number; sep: number; omega: number } {
  const x = Math.min(t / MERGE, 0.996);
  const u = 1 - x;
  return {
    phase: (8 / 5) * W0 * MERGE * (1 - Math.pow(u, 5 / 8)),
    sep: A0 * Math.pow(u, 1 / 4),
    omega: W0 * Math.pow(u, -3 / 8),
  };
}

/**
 * «Злиття чорних дір»: two black holes circle each other, losing energy to gravitational
 * waves, so they close in ever faster (the "chirp" LIGO hears) and merge; the new hole rings
 * down and the last waves race away. Space is drawn as a grid sagging under the holes and
 * rippling with the waves (two crests per orbit, spiralling out at the speed of light).
 */
export class Merger implements CuriousScene {
  readonly name = 'merger' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private merged = false;
  private grid: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private holes: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  private halos = [new Glow('#9fc0ff', 3.2, 2.6), new Glow('#9fc0ff', 3.2, 2.6)];
  private remnant: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private remnantHalo = new Glow('#b8ccff', 3.6, 2.4);
  private burst = new Glow('#e6eeff', 30, 1.6);
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(private ctx: Ctx) {
    // Space as a sheet: sagging into each hole, and lifted and lowered by the waves, which
    // carry the binary's phase out at WAVE_C (so they trail into a spiral).
    const geo = new THREE.PlaneGeometry(64, 64, 256, 256);
    geo.rotateX(-Math.PI / 2);
    this.grid = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: {
          uT: { value: 0 },
          uH0: { value: new THREE.Vector3() },
          uH1: { value: new THREE.Vector3() },
          uMass: { value: new THREE.Vector2(1, 1) },
          uFade: { value: 0 },
        },
        vertexShader: /* glsl */ `
          uniform float uT;
          uniform vec3 uH0, uH1;
          uniform vec2 uMass;
          varying vec2 vXZ;
          varying float vWave;
          varying float vDepth;
          const float MERGE = ${MERGE.toFixed(1)};
          const float W0 = ${W0.toFixed(2)};
          const float C = ${WAVE_C.toFixed(1)};
          // The binary's orbital phase and wave amplitude at (retarded) time tr.
          void source(float tr, out float phase, out float amp) {
            if (tr < MERGE) {
              float u = 1.0 - min(tr / MERGE, 0.996);
              phase = 1.6 * W0 * MERGE * (1.0 - pow(u, 0.625));
              amp = pow(u, -0.25) * 0.11;
            } else {
              // Ring-down: the merged hole's own note, dying away fast.
              float s = tr - MERGE;
              float u = 0.004;
              phase = 1.6 * W0 * MERGE * (1.0 - pow(u, 0.625)) + s * W0 * pow(u, -0.375) * 0.9;
              amp = pow(u, -0.25) * 0.11 * exp(-s * 2.2);
            }
          }
          void main() {
            vec3 p = position;
            float r = length(p.xz);
            float tr = uT - r / C;
            float phase, amp;
            source(tr, phase, amp);
            // Two crests per orbit (a quadrupole), spiralling with the phase; fading with distance.
            // (Capped, and calm right at the centre, where the holes and their wells are.)
            amp = min(amp, 0.16) * smoothstep(0.4, 2.2, r);
            float wave = tr > 0.0 ? amp * cos(2.0 * (atan(p.z, p.x) - phase)) / (1.0 + r * 0.18) : 0.0;
            // The wells of the holes.
            float well = -uMass.x * 1.1 / sqrt(dot(p.xz - uH0.xz, p.xz - uH0.xz) + 0.35)
                         -uMass.y * 1.1 / sqrt(dot(p.xz - uH1.xz, p.xz - uH1.xz) + 0.35);
            p.y += wave * 9.0 + well * 0.55;
            vXZ = p.xz;
            vWave = wave;
            vDepth = -well;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uFade;
          varying vec2 vXZ;
          varying float vWave;
          varying float vDepth;
          void main() {
            // Thin grid lines, kept the same width on screen.
            vec2 g = vXZ * 1.4;
            vec2 w = fwidth(g);
            vec2 l = 1.0 - smoothstep(vec2(0.0), w * 1.2, abs(fract(g - 0.5) - 0.5));
            float line = max(l.x, l.y);
            float r = length(vXZ);
            float edge = 1.0 - smoothstep(16.0, 30.0, r);
            // Crests glow warm, troughs cool; the wells brighten towards the holes.
            vec3 col = mix(vec3(0.25, 0.45, 1.0), vec3(1.0, 0.75, 0.45), smoothstep(-0.02, 0.06, vWave));
            float bright = 0.35 + abs(vWave) * 18.0 + vDepth * 0.25;
            gl_FragColor = vec4(col * line * bright * edge * uFade, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.grid.position.y = -1.4;
    this.grid.frustumCulled = false;

    // The holes: black spheres against their own halo of lensed starlight.
    for (let i = 0; i < 2; i++) {
      const hole = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      this.holes.push(hole);
      this.group.add(this.halos[i], hole);
    }
    this.remnant = new THREE.Mesh(new THREE.SphereGeometry(0.62, 40, 30), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.remnant.visible = false;
    this.stars = createStarfield(2600, 90, 61) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    this.group.add(this.stars, this.grid, this.remnantHalo, this.remnant, this.burst);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.merged = false;
    this.remnant.visible = false;
    this.holes.forEach((h) => (h.visible = true));
    this.ctx.audio.chirp(MERGE);
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const captions: [number, string, number][] = [
      [0.8, 'Дві чорні діри кружляють одна довкола одної', 4],
      [5.6, 'Вони випромінюють гравітаційні хвилі — брижі самого простору', 4.2],
      [10.6, 'Втрачаючи енергію, діри зближуються дедалі швидше', 3.4],
      [14.6, 'Злиття: на мить яскравіше за всі зорі Всесвіту разом', 4.4],
      [20.4, 'У 2015-му LIGO вперше «почув» такі хвилі на Землі', 4.4],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }
    const fade = smooth(0, 1.4, t) * (1 - smooth(DURATION - 1.4, DURATION, t));
    const cam = this.ctx.camera;

    // The binary.
    const o = orbit(t);
    const h0 = this.holes[0].position.set(Math.cos(o.phase) * o.sep * 0.5, 0, Math.sin(o.phase) * o.sep * 0.5);
    const h1 = this.holes[1].position.set(-h0.x, 0, -h0.z);
    if (t >= MERGE && !this.merged) {
      this.merged = true;
      this.holes.forEach((h) => (h.visible = false));
      this.remnant.visible = true;
    }
    const u = this.grid.material.uniforms;
    u.uT.value = t;
    u.uH0.value.copy(this.merged ? this.remnant.position : h0);
    u.uH1.value.copy(this.merged ? this.remnant.position : h1);
    u.uMass.value.set(this.merged ? 0.95 : 1, this.merged ? 0.95 : 1);
    u.uFade.value = fade;

    // Camera: above the plane, closing in as the orbit tightens, then easing back.
    const close = smooth(4, MERGE, t) * (1 - smooth(MERGE + 2, DURATION, t) * 0.6);
    const dist = lerp(15, 8.5, close);
    const el = THREE.MathUtils.degToRad(lerp(36, 24, close));
    const az = 0.6 + t * 0.06;
    cam.position.set(Math.cos(el) * Math.sin(az) * dist, Math.sin(el) * dist, Math.cos(el) * Math.cos(az) * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, -0.4, 0);

    this.halos.forEach((g, i) => {
      g.position.copy(this.holes[i].position);
      g.intensity = 0.55 * fade * (this.merged ? 0 : 1);
      g.face(cam);
    });
    this.remnantHalo.intensity = this.merged ? 0.7 * fade : 0;
    this.remnantHalo.face(cam);
    // The burst of the merger (gravitational waves cannot be seen, but the moment is marked).
    const flash = t > MERGE ? Math.exp(-(t - MERGE) * 3) : 0;
    this.burst.intensity = flash * 0.9 * fade;
    this.burst.face(cam);
    this.stars.material.uniforms.uOpacity.value = 0.7 * fade;
    this.stars.position.copy(cam.position);
  }

  exit(): void {
    this.ctx.audio.chirp(0);
  }

  dispose(): void {
    disposeObject(this.group);
  }
}
