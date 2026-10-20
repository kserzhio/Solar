import * as THREE from 'three';
import { mulberry32 } from '../shaders/common';

/** 4D simplex noise (Ashima Arts / Stefan Gustavson, MIT licence). */
const SIMPLEX4 = /* glsl */ `
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
float permute(float x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float taylorInvSqrt(float r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec4 grad4(float j, vec4 ip) {
  const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
  vec4 p, s;
  p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
  s = vec4(lessThan(p, vec4(0.0)));
  p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
  return p;
}
float snoise4(vec4 v) {
  const vec4 C = vec4(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);
  vec4 i = floor(v + dot(v, vec4(0.309016994374947451)));
  vec4 x0 = v - i + dot(i, C.xxxx);
  vec4 i0;
  vec3 isX = step(x0.yzw, x0.xxx);
  vec3 isYZ = step(x0.zww, x0.yyz);
  i0.x = isX.x + isX.y + isX.z;
  i0.yzw = 1.0 - isX;
  i0.y += isYZ.x + isYZ.y;
  i0.zw += 1.0 - isYZ.xy;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;
  vec4 i3 = clamp(i0, 0.0, 1.0);
  vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
  vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);
  vec4 x1 = x0 - i1 + C.xxxx;
  vec4 x2 = x0 - i2 + C.yyyy;
  vec4 x3 = x0 - i3 + C.zzzz;
  vec4 x4 = x0 + C.wwww;
  i = mod289(i);
  float j0 = permute(permute(permute(permute(i.w) + i.z) + i.y) + i.x);
  vec4 j1 = permute(permute(permute(permute(
      i.w + vec4(i1.w, i2.w, i3.w, 1.0))
    + i.z + vec4(i1.z, i2.z, i3.z, 1.0))
    + i.y + vec4(i1.y, i2.y, i3.y, 1.0))
    + i.x + vec4(i1.x, i2.x, i3.x, 1.0));
  vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
  vec4 p0 = grad4(j0, ip);
  vec4 p1 = grad4(j1.x, ip);
  vec4 p2 = grad4(j1.y, ip);
  vec4 p3 = grad4(j1.z, ip);
  vec4 p4 = grad4(j1.w, ip);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  p4 *= taylorInvSqrt(dot(p4, p4));
  vec3 m0 = max(0.6 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  vec2 m1 = max(0.6 - vec2(dot(x3, x3), dot(x4, x4)), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  return 49.0 * (dot(m0 * m0, vec3(dot(p0, x0), dot(p1, x1), dot(p2, x2)))
    + dot(m1 * m1, vec2(dot(p3, x3), dot(p4, x4))));
}
`;

/**
 * Boiling plasma, baked every frame into a small cube map: four octaves of 4D simplex
 * noise (time is the fourth axis, so the pattern evolves in place instead of sliding).
 * The Sun's surface shader samples it three times through slowly counter-rotating frames,
 * which reads as churning convection for the price of three texture lookups per pixel.
 * R: churn, G: a second, independent field; R also carries a low-frequency mask that
 * brightens whole active patches now and then.
 */
export class SunNoiseCube {
  readonly texture: THREE.CubeTexture;
  private target: THREE.WebGLCubeRenderTarget;
  private camera: THREE.CubeCamera;
  private scene = new THREE.Scene();
  private material: THREE.ShaderMaterial;

  constructor(size = 192) {
    this.target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false });
    this.texture = this.target.texture;
    this.camera = new THREE.CubeCamera(0.1, 10, this.target);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${SIMPLEX4}
        uniform float uTime;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir) + 12.45;
          vec4 p = vec4(d * 3.2, uTime * 0.07);
          float a = 1.0;
          float f = 1.0;
          vec2 sum = vec2(0.0);
          for (int i = 0; i < 4; i++) {
            sum.x += snoise4(p * f) * a;
            sum.y += snoise4((p + vec4(0.0, 0.0, 0.0, 100.0)) * f) * a;
            a *= 0.62;
            f *= 2.0;
          }
          vec2 v = sum * 0.32 + 0.5;
          // Low-frequency patches that flare up and calm down.
          float patches = max(snoise4(vec4(d * 1.6, uTime * 0.05)), 0.0);
          v.x *= mix(1.0, 0.75 + patches * 0.9, 0.6);
          gl_FragColor = vec4(clamp(v, 0.0, 1.0), 0.0, 1.0);
        }`,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.material));
  }

  update(renderer: THREE.WebGLRenderer, time: number): void {
    this.material.uniforms.uTime.value = time;
    this.camera.update(renderer, this.scene);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}

/**
 * Magnetic "hair": hundreds of thin, camera-facing ribbons rooted in the photosphere,
 * densest over the active regions. Each one grows outwards, writhes along a cheap
 * layered-sine flow field that strengthens with height, then shrinks back, on its own
 * cycle; all motion happens in the vertex shader.
 */
export function createSunStrands(opts: {
  radius: number;
  groups: THREE.Vector3[][];
  count: number;
  uTime: THREE.IUniform<number>;
  intensity: THREE.IUniform<number>;
  sunR: THREE.IUniform<number>;
}): THREE.Mesh {
  const SEG = 24;
  const rand = mulberry32(777);
  const verts = (SEG + 1) * 2;
  const root = new Float32Array(opts.count * verts * 3);
  const rnd = new Float32Array(opts.count * verts * 4);
  const strand = new Float32Array(opts.count * verts * 2);
  const index: number[] = [];
  const v = new THREE.Vector3();
  for (let s = 0; s < opts.count; s++) {
    // Most strands sprout from the active regions, the rest anywhere on the disk.
    if (rand() < 0.65 && opts.groups.length) {
      const g = opts.groups[Math.floor(rand() * opts.groups.length)];
      const c = g[Math.floor(rand() * g.length)];
      v.copy(c).add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.32)).normalize();
    } else {
      v.randomDirection();
    }
    const r = [rand(), rand(), rand(), rand()];
    for (let k = 0; k <= SEG; k++) {
      for (let side = 0; side < 2; side++) {
        const i = s * verts + k * 2 + side;
        root.set([v.x, v.y, v.z], i * 3);
        rnd.set(r, i * 4);
        strand.set([k / SEG, side ? 1 : -1], i * 2);
      }
      if (k < SEG) {
        const a = s * verts + k * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(root, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
  geo.setAttribute('aStrand', new THREE.BufferAttribute(strand, 2));
  geo.setIndex(index);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: opts.uTime,
      uIntensity: opts.intensity,
      uSunR: opts.sunR,
      uR: { value: opts.radius },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uR;
      attribute vec4 aRand;
      attribute vec2 aStrand;
      varying float vAlong;
      varying float vSide;
      varying float vLife;
      varying vec3 vPosW;
      varying vec3 vTint;

      // Layered, rotated sine waves: a smooth, swirling flow field that costs almost nothing.
      vec3 swirl(vec3 p, float t) {
        vec3 sum = vec3(0.0);
        float amp = 1.0;
        for (int i = 0; i < 3; i++) {
          p = vec3(p.y * 0.8 + p.z * 0.6, p.z * 0.8 - p.x * 0.6, p.x * 0.8 + p.y * 0.6);
          vec3 w = sin(p * 1.7 + t + sum.zxy * 1.3) * amp;
          sum += w;
          p *= 1.9;
          amp *= 0.55;
        }
        return sum;
      }

      float life() { return sin(3.14159 * fract(uTime * (0.04 + aRand.y * 0.07) + aRand.x)); }

      vec3 strandPos(float along) {
        float height = along * (0.18 + aRand.z * 0.55) * life();
        vec3 p = position * (1.0 + height);
        p += swirl(position * 3.0 + p * 1.2, uTime * (0.25 + aRand.w * 0.3) + aRand.w * 6.0) * height * 0.32;
        return p * uR;
      }

      void main() {
        float along = aStrand.x;
        vec3 p = (modelMatrix * vec4(strandPos(along), 1.0)).xyz;
        vec3 p1 = (modelMatrix * vec4(strandPos(min(along + 0.02, 1.0)), 1.0)).xyz;
        vec3 dir = normalize(p1 - p + normalize(p) * 1e-4);
        vec3 side = cross(normalize(p - cameraPosition), dir);
        side /= max(length(side), 1e-5);
        float width = uR * (0.009 + aRand.y * 0.009) * (1.0 - along * 0.8);
        p += side * width * aStrand.y;
        vAlong = along;
        vSide = aStrand.y;
        vLife = life();
        vPosW = p;
        vTint = mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.58, 0.16), aRand.w);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      uniform float uSunR;
      varying float vAlong;
      varying float vSide;
      varying float vLife;
      varying vec3 vPosW;
      varying vec3 vTint;
      void main() {
        float across = 1.0 - abs(vSide);
        float a = across * across * (1.0 - vAlong) * (1.0 - vAlong) * vLife;
        // Against the bright disk the strands would only wash it out: keep them for the sky.
        vec3 rd = normalize(vPosW - cameraPosition);
        float b = length(cameraPosition + rd * max(dot(-cameraPosition, rd), 0.0));
        float offDisk = smoothstep(uSunR * 0.97, uSunR * 1.03, b);
        gl_FragColor = vec4(vTint * a * mix(0.12, 1.0, offDisk) * uIntensity * 1.1, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}
