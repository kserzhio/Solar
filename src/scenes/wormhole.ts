import * as THREE from 'three';
import { NOISE, globalUniforms } from '../shaders/common';
import { GALACTIC, Glow, SKY } from './util';

/**
 * The two skies a wormhole joins, as GLSL (needs NOISE): our own (the Milky Way panorama,
 * with stars made up here since the scene's star points are not lensed) and the sky of the
 * galaxy on the far side — a rich star field, faint wisps of gas and one large neighbouring
 * spiral seen at a slant. Uniforms come from skyUniforms().
 */
export const SKIES = /* glsl */ `
  uniform sampler2D uSky;
  uniform float uSkyOn;
  uniform vec3 uGalX;
  uniform vec3 uGalY;
  uniform vec3 uGalN;

  float skyHash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }

  // One layer of stars: at most one per cell of a grid laid over the directions. fp is the
  // angle one pixel spans there (large where a lens spreads neighbouring pixels across the
  // sky): each star is widened to it, keeping its light, and where a pixel spans whole cells
  // they merge into their even average glow, instead of flickering in and out as dashes.
  vec3 skyStars(vec3 d, float scale, float density, float size, float fp) {
    vec3 q = d * scale;
    vec3 c = floor(q);
    float h = skyHash(c);
    float w = fp * scale;
    float se = sqrt(size * size + 0.3 * w * w);
    float merge = smoothstep(0.25, 0.6, se);
    vec3 glow = vec3(0.9, 0.85, 0.8) * density * 3.1416 * size * size * 0.75 * merge;
    if (h > density) return glow;
    vec3 sp = vec3(skyHash(c + 1.3), skyHash(c + 2.7), skyHash(c + 5.1)) * 0.6 + 0.2;
    float r = length(fract(q) - sp) / se;
    vec3 tint = mix(vec3(1.0, 0.78, 0.55), vec3(0.75, 0.85, 1.0), skyHash(c + 9.7));
    return glow + tint * exp(-r * r) * (0.35 + 1.4 * pow(h / density, 3.0)) * (size * size) / (se * se) * (1.0 - merge);
  }
  vec3 skyStars(vec3 d, float scale, float density, float size) { return skyStars(d, scale, density, size, 0.0); }

  vec3 ourSky(vec3 d) {
    vec3 col = vec3(0.006, 0.008, 0.012) + skyStars(d, 160.0, 0.2, 0.14) * 0.8;
    if (uSkyOn < 0.5) return col;
    float l = atan(dot(d, uGalY), dot(d, uGalX));
    float b = asin(clamp(dot(d, uGalN), -1.0, 1.0));
    vec3 c = textureLod(uSky, vec2(fract(0.5 - l / 6.2831853), 0.5 - b / 3.1415927), 0.0).rgb;
    return col + 6.0 * pow(c, vec3(2.2)) * 0.18; // decoded as in util.ts, then 2.2/12 of its lift
  }

  vec3 otherSky(vec3 d, float fp) {
    vec3 col = skyStars(d, 140.0, 0.22, 0.13, fp) + skyStars(d, 330.0, 0.3, 0.16, fp) * 0.5;
    float n = snoise(d * 2.2) * 0.6 + snoise(d * 5.1) * 0.3 + snoise(d * 11.0) * 0.1;
    float m = snoise(d * 1.6 + 7.0);
    float wisps = pow(1.0 - abs(snoise(d * 7.0 + n)), 4.0);
    // (Faded where a lens smears it: drawn out into a long red arc it looked like a fault.)
    col += mix(vec3(0.05, 0.11, 0.13), vec3(0.16, 0.07, 0.05), smoothstep(-0.4, 0.5, m)) * smoothstep(0.1, 0.8, n) * (0.12 + 0.3 * wisps) * clamp(1.0 - fp * 150.0, 0.0, 1.0);
    // The neighbouring spiral galaxy.
    vec3 g = normalize(vec3(0.62, 0.22, -0.75));
    vec3 u = normalize(cross(g, vec3(0.2, 1.0, 0.1)));
    vec3 v = cross(u, g);
    float facing = dot(d, g);
    if (facing > 0.0) {
      float ca = cos(0.5), sa = sin(0.5);
      vec2 p = vec2(dot(d, u), dot(d, v)) / facing;
      p = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
      p = vec2(p.x / 0.2, p.y / 0.075);
      float r = length(p);
      float arms = 0.5 + 0.5 * cos(2.0 * atan(p.y, p.x) - 4.5 * log(r + 0.04));
      float disk = exp(-r * 2.6) * (0.35 + 0.65 * arms * smoothstep(0.08, 0.35, r));
      float bulge = exp(-r * r * 40.0);
      col += vec3(0.62, 0.72, 1.0) * disk * 0.55 + vec3(1.0, 0.82, 0.55) * bulge * 0.9;
    }
    return col * 1.3;
  }
  vec3 otherSky(vec3 d) { return otherSky(d, 0.0); }
`;

/**
 * Light through an Ellis wormhole, the space-time the film's wormhole was built on
 * (ds² = −dt² + dl² + (b₀² + l²) dΩ², throat radius b₀ = 1). A ray keeps its impact
 * parameter b; with b < 1 it passes the throat to the other side, otherwise it swings round
 * and goes back out. The angle it sweeps is an elliptic integral (Carlson's R_F), so no
 * stepping is needed.
 *
 * ellisRay(d, P, lc, far): the camera sits at l = lc on the axis P (its angular position;
 * "forward", towards smaller l, is −P; lc > 0 is the near side). Returns the direction to
 * look up in the sky of the side the ray ends on, and far = 1 when that is the far side.
 */
export const ELLIS = /* glsl */ `
  float carlsonRF(float x, float y, float z) {
    for (int i = 0; i < 7; i++) {
      float sx = sqrt(x), sy = sqrt(y), sz = sqrt(z);
      float l = sx * sy + sy * sz + sz * sx;
      x = (x + l) * 0.25;
      y = (y + l) * 0.25;
      z = (z + l) * 0.25;
    }
    float a = (x + y + z) / 3.0;
    float dx = 1.0 - x / a, dy = 1.0 - y / a, dz = -(dx + dy);
    float e2 = dx * dy - dz * dz, e3 = dx * dy * dz;
    return (1.0 - e2 / 10.0 + e3 / 14.0 + e2 * e2 / 24.0 - 3.0 * e2 * e3 / 44.0) / sqrt(a);
  }

  vec3 ellisRay(vec3 d, vec3 P, float lc, out float far) {
    float ca = -dot(d, P);                 // cosine of the angle to "forward"
    vec3 e = d + ca * P;                   // the sideways part
    float el = length(e);
    e = el > 1e-6 ? e / el : vec3(0.0);
    float rc = sqrt(1.0 + lc * lc);
    float b = rc * el;
    float side = lc >= 0.0 ? 1.0 : -1.0;
    bool toward = (ca > 0.0) == (side > 0.0);
    // Swept angle: b·∫du/√((1−b²u²)(1−u²)), u = 1/r, as F(ψ|m), K(m).
    float factor, m, s;
    if (b < 1.0) { factor = b; m = b * b; s = 1.0 / rc; }
    else { factor = 1.0; m = 1.0 / (b * b); s = b / rc; }
    m = min(m, 0.99995);
    s = clamp(s, 0.0, 1.0);
    float K = carlsonRF(0.0, 1.0 - m, 1.0);
    float F = s * carlsonRF(1.0 - s * s, 1.0 - m * s * s, 1.0);
    float phi = factor * (toward ? 2.0 * K - F : F);
    vec3 E = cos(phi) * P + sin(phi) * e;
    if (toward && b < 1.0) side = -side;
    far = side < 0.0 ? 1.0 : 0.0;
    // The far side's sky is set up mirrored along the axis, so far from the throat a ray
    // looks where it points, on both sides.
    if (far > 0.5) E -= 2.0 * dot(E, P) * P;
    return E;
  }
`;

/** Uniforms for SKIES. */
export function skyUniforms() {
  return {
    uSky: { value: null as THREE.Texture | null },
    uSkyOn: { value: 0 },
    uGalX: { value: GALACTIC.x },
    uGalY: { value: GALACTIC.y },
    uGalN: { value: GALACTIC.n },
  };
}

/** Points SKIES' uniforms at the panorama once it has loaded. */
export function refreshSky(u: { uSky: { value: unknown }; uSkyOn: { value: number } }): void {
  u.uSky.value = SKY.photo;
  u.uSkyOn.value = SKY.photo ? 1 : 0;
}

/**
 * How fast (throat radii a second) the camera goes as it reaches a wormhole's mouth and the
 * passage takes over: both sides use it, so the flight runs on through the hand-over.
 */
export const PASSAGE_SPEED = 1.1;

/** Radius of the wormhole's mesh (its lensing reaches this far), in its parent's units. */
export const WORMHOLE_R = 0.65;
/** Mesh radius over the throat radius. */
export const LENS = 2.3;

/**
 * A wormhole's mouth: a sphere in which every pixel is traced through the Ellis wormhole.
 * Seen from outside it shows the far side's sky in the middle and our own sky, bent round
 * it, towards the rim. `nearIsOurs`: which sky is on the camera's side.
 */
export class Wormhole {
  readonly group = new THREE.Group();
  /** Invisible, generous target for the pointer. */
  readonly hit: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private glow = new Glow('#a9ccff', 5.2, 2.6);
  private mouth: THREE.Mesh;
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private hover = 0;

  constructor(nearIsOurs = true, private radius = WORMHOLE_R) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms(),
        uTime: globalUniforms.uTime,
        uFade: { value: 0 },
        uHover: { value: 0 },
        uCentre: { value: new THREE.Vector3() },
        uThroat: { value: radius / LENS },
        uNearOurs: { value: nearIsOurs ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPosW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPosW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        ${SKIES}
        ${ELLIS}
        uniform float uTime;
        uniform float uFade;
        uniform float uHover;
        uniform vec3 uCentre;
        uniform float uThroat;
        uniform float uNearOurs;
        varying vec3 vPosW;

        void main() {
          vec3 d = normalize(vPosW - cameraPosition);
          vec3 rel = (cameraPosition - uCentre) / uThroat;
          float rc = max(length(rel), 1.0001);
          vec3 P = rel / length(rel);
          float far;
          vec3 E = ellisRay(d, P, sqrt(rc * rc - 1.0), far);
          bool ours = (far > 0.5) != (uNearOurs > 0.5);
          vec3 col = ours ? ourSky(E) : otherSky(E);
          // Impact parameter in throat radii: 1 at the edge of the far side's view.
          float b = rc * length(d + dot(d, -P) * P);
          // A faint glint where the views meet, brighter under the pointer.
          col += vec3(0.55, 0.72, 1.0) * exp(-pow((b - 1.0) / 0.05, 2.0)) * uHover;
          // Further out the bending fades, so the scene behind takes over.
          float alpha = (1.0 - smoothstep(${(LENS * 0.62).toFixed(3)}, ${(LENS * 0.95).toFixed(3)}, b)) * uFade;
          gl_FragColor = vec4(col, alpha);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mouth = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), this.material);
    this.mouth.onBeforeRender = () => {
      const u = this.material.uniforms;
      refreshSky(u as unknown as Parameters<typeof refreshSky>[0]);
      this.mouth.getWorldPosition(u.uCentre.value);
      u.uThroat.value = (this.radius / LENS) * this.mouth.getWorldScale(this.tmpS).x;
    };
    this.hit = new THREE.Mesh(new THREE.SphereGeometry(radius * 2.2, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.group.add(this.glow, this.mouth, this.hit);
  }

  /** Throat radius in world units. */
  get throat(): number {
    return (this.radius / LENS) * this.mouth.getWorldScale(this.tmpS).x;
  }

  /**
   * @param fade 0..1 visibility
   * @param hovered whether the pointer is on it
   * @param glow strength of the soft halo that makes it easy to spot from afar
   */
  update(dt: number, camera: THREE.Camera, fade: number, hovered: boolean, glow = 1): void {
    this.hover += ((hovered ? 1 : 0) - this.hover) * Math.min(1, (dt || 1 / 60) * 8);
    this.material.uniforms.uFade.value = fade;
    const t = globalUniforms.uTime.value;
    // The halo only helps to spot it from afar; close up it would sit behind the mouth.
    const dist = camera.getWorldPosition(this.tmpC).distanceTo(this.mouth.getWorldPosition(this.tmpP)) / this.mouth.getWorldScale(this.tmpS).x;
    const far = THREE.MathUtils.smoothstep(dist, this.radius * 6, this.radius * 22);
    this.glow.intensity = fade * glow * far * (0.5 + 0.1 * Math.sin(t * 1.3) + 0.35 * this.hover);
    // The glint at the edge of the far side's view: there from afar, and under the pointer.
    this.material.uniforms.uHover.value = Math.max(far * 0.25, this.hover * 0.95);
    this.glow.face(camera);
    this.group.visible = fade > 0.002;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }
}
