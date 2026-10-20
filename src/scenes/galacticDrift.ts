import * as THREE from 'three';
import { mulberry32 } from '../shaders/common';

/** Points kept per trail, and the distance travelled between two of them (scene units). */
const TRAIL_POINTS = 1400;
const TRAIL_STEP = 0.3;
/** Size of the box of interstellar dust that streams past (scene units). */
const DUST_BOX = 140;

/**
 * «Політ крізь Галактику»: the Sun is not at rest. It circles the centre of the Milky Way
 * at ~230 km/s, ~7.7 times faster than Earth goes round the Sun, heading about 60° out of
 * the plane of the planets' orbits. Seen from the Galaxy, every planet therefore draws a
 * helix trailing behind the Sun.
 *
 * The Sun stays at the origin (everything else in the scene relies on that). The trails are
 * stored in galactic coordinates (position + distance travelled) and the whole trail group
 * is shifted back by the distance travelled, so old points recede behind the Sun. Local
 * dust, at rest in the Galaxy, streams past at the same speed.
 */
export class GalacticDrift {
  readonly group = new THREE.Group();
  /** 0..1 fade of the whole effect. */
  weight = 0;
  active = false;
  /** Direction of travel in the Solar System's frame. */
  readonly direction: THREE.Vector3;
  private travelled = new THREE.Vector3();
  private trails: {
    positions: Float32Array;
    count: number;
    last: THREE.Vector3;
    geometry: THREE.BufferGeometry;
    material: THREE.ShaderMaterial;
  }[] = [];
  private trailGroup = new THREE.Group();
  private dust: THREE.ShaderMaterial;
  private tmp = new THREE.Vector3();

  /**
   * @param colors one colour per body, the Sun first.
   * @param speed scene units per unit of orbit clock.
   */
  constructor(colors: string[], readonly speed: number, direction: THREE.Vector3) {
    this.direction = direction.clone().normalize();
    colors.forEach((c, i) => {
      const positions = new Float32Array(TRAIL_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setDrawRange(0, 0);
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(c).lerp(new THREE.Color('#ffffff'), 0.25) },
          uCount: { value: 0 },
          uFade: { value: 0 },
          uBright: { value: i === 0 ? 0.5 : 1 },
        },
        vertexShader: /* glsl */ `
          uniform float uCount;
          varying float vFrac;
          void main() {
            // Newest point last: 1 at the body, fading to 0 far behind it.
            vFrac = float(gl_VertexID) / max(uCount - 1.0, 1.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uFade;
          uniform float uBright;
          varying float vFrac;
          void main() {
            float a = vFrac * vFrac * uFade * uBright;
            gl_FragColor = vec4(uColor * a, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      this.trailGroup.add(line);
      this.trails.push({ positions, count: 0, last: new THREE.Vector3(Infinity, 0, 0), geometry, material });
    });
    this.group.add(this.trailGroup);

    // Interstellar dust at rest in the Galaxy: wraps around in a box centred on the Sun.
    const rand = mulberry32(230);
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos.set([(rand() - 0.5) * DUST_BOX, (rand() - 0.5) * DUST_BOX, (rand() - 0.5) * DUST_BOX], i * 3);
      seed[i] = rand();
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dust = new THREE.ShaderMaterial({
      uniforms: { uOffset: { value: new THREE.Vector3() }, uFade: { value: 0 }, uDir: { value: this.direction } },
      vertexShader: /* glsl */ `
        uniform vec3 uOffset;
        attribute float aSeed;
        varying float vAlpha;
        void main() {
          vec3 p = mod(position - uOffset + ${(DUST_BOX / 2).toFixed(1)}, ${DUST_BOX.toFixed(1)}) - ${(DUST_BOX / 2).toFixed(1)};
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float edge = 1.0 - smoothstep(${(DUST_BOX * 0.32).toFixed(1)}, ${(DUST_BOX * 0.5).toFixed(1)}, length(p));
          vAlpha = edge * (0.35 + 0.65 * aSeed);
          gl_PointSize = clamp(170.0 / max(-mv.z, 1.0), 1.5, 6.0) * (0.6 + aSeed);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFade;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float d = dot(c, c);
          if (d > 1.0) discard;
          gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * exp(-d * 3.0) * vAlpha * uFade * 1.1, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dg, this.dust);
    dust.frustumCulled = false;
    this.group.add(dust);
    this.group.visible = false;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) this.reset();
  }

  /** Forget the trails (start a fresh flight). */
  reset(): void {
    this.travelled.set(0, 0, 0);
    for (const t of this.trails) {
      t.count = 0;
      t.last.set(Infinity, 0, 0);
      t.geometry.setDrawRange(0, 0);
    }
  }

  /**
   * @param clockStep how far the orbit clock moved this frame.
   * @param bodies current positions (Solar System frame), the Sun first.
   */
  update(dt: number, clockStep: number, bodies: THREE.Vector3[]): void {
    this.weight += ((this.active ? 1 : 0) - this.weight) * Math.min(1, (dt || 1 / 60) * 2);
    if (this.weight < 0.002 && !this.active) {
      this.weight = 0;
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    if (this.active && clockStep > 0) this.travelled.addScaledVector(this.direction, this.speed * clockStep);

    // Keep numbers small: re-centre everything once the Sun has gone a long way.
    if (this.travelled.lengthSq() > 4e6) {
      for (const t of this.trails) {
        for (let i = 0; i < t.count; i++) {
          t.positions[i * 3] -= this.travelled.x;
          t.positions[i * 3 + 1] -= this.travelled.y;
          t.positions[i * 3 + 2] -= this.travelled.z;
        }
        t.last.sub(this.travelled);
        t.geometry.attributes.position.needsUpdate = true;
      }
      this.travelled.set(0, 0, 0);
    }

    this.trails.forEach((t, i) => {
      const g = this.tmp.copy(bodies[i]).add(this.travelled);
      if (this.active && g.distanceToSquared(t.last) > TRAIL_STEP * TRAIL_STEP) {
        if (t.count === TRAIL_POINTS) {
          t.positions.copyWithin(0, 3);
          t.count--;
        }
        t.positions.set([g.x, g.y, g.z], t.count * 3);
        t.count++;
        t.last.copy(g);
        t.geometry.setDrawRange(0, t.count);
        t.geometry.attributes.position.needsUpdate = true;
      }
      t.material.uniforms.uCount.value = t.count;
      t.material.uniforms.uFade.value = this.weight;
    });
    // Galactic coordinates → Solar System frame.
    this.trailGroup.position.copy(this.travelled).negate();
    this.dust.uniforms.uOffset.value.copy(this.travelled);
    this.dust.uniforms.uFade.value = this.weight;
  }

  dispose(): void {
    this.trails.forEach((t) => {
      t.geometry.dispose();
      t.material.dispose();
    });
    this.dust.dispose();
  }
}
