import * as THREE from 'three';

/**
 * Simplex noise 3D (Ashima Arts / Stefan Gustavson, MIT) with an analytic-gradient
 * variant used for divergence-free curl noise, plus fbm helpers.
 */
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoiseCore(vec3 v, out vec3 gradient, bool wantGrad) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  gradient = vec3(0.0);
  if (wantGrad) {
    vec4 temp = m2 * m * pdotx;
    gradient = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
    gradient += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
    gradient *= 105.0;
  }
  return 105.0 * dot(m4, pdotx);
}

float snoise(vec3 v) { vec3 g; return snoiseCore(v, g, false); }
float snoiseGrad(vec3 v, out vec3 g) { return snoiseCore(v, g, true); }

// Divergence-free flow: curl of (n1 * grad n2) == grad n1 x grad n2.
vec3 curlNoise(vec3 p) {
  vec3 g1; vec3 g2;
  snoiseGrad(p, g1);
  snoiseGrad(p + vec3(31.416, -47.853, 12.679), g2);
  return cross(g1, g2);
}

float fbm3(vec3 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * snoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

float fbm5(vec3 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * snoise(p); p = p * 2.01 + 9.7; a *= 0.5; }
  return s;
}

float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
`;

/** Converts a world-space diameter into pixels and keeps tiny points from flickering. */
export const POINT_SIZE = /* glsl */ `
uniform float uViewScale;
float pointSize(float worldSize, float viewZ, inout float alpha) {
  float px = worldSize * uViewScale / max(viewZ, 0.001);
  if (px < 1.6) { alpha *= px / 1.6; px = 1.6; }
  return min(px, 96.0);
}
`;

/** Soft gaussian point sprite for additive blending. */
export const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = exp(-d * 4.5) * vAlpha;
  gl_FragColor = vec4(vColor, a);
}
`;

/** Uniforms shared by reference across all particle materials. */
export const globalUniforms = {
  uViewScale: { value: 600 },
  uTime: { value: 0 },
};

export function updateViewScale(camera: THREE.PerspectiveCamera, drawingBufferHeight: number): void {
  globalUniforms.uViewScale.value =
    drawingBufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

export function additiveMaterial(
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { ...uniforms, uViewScale: globalUniforms.uViewScale },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Seeded PRNG so the cosmic web is identical across restarts. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function colorUniform(hex: string): THREE.IUniform<THREE.Color> {
  return { value: new THREE.Color(hex) };
}
