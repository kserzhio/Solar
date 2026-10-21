import * as THREE from 'three';
import { config } from '../../config';
import { POINT_FRAG, POINT_SIZE, additiveMaterial, gaussian, globalUniforms, mulberry32 } from '../../shaders/common';
import { ASTEROID_BELT, KUIPER_BELT, PLANETS, SUN_RADIUS } from '../../data/planets';
import { lerp } from '../util';
import type { PlanetView } from './common';

export function buildKuiperBelt() {
  const count = 7000;
  const rand = mulberry32(4711);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = lerp(KUIPER_BELT.inner, KUIPER_BELT.outer, Math.pow(rand(), 0.8));
    data.set([r, rand() * Math.PI * 2, gaussian(rand) * (0.6 + r * 0.04), rand()], i * 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  const material = additiveMaterial(
    /* glsl */ `
      ${POINT_SIZE}
      uniform float uClock;
      uniform float uFade;
      attribute vec4 aData;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float r = aData.x;
        float ang = aData.y + uClock * 0.16 * pow(7.7 / r, 1.5);
        vec3 p = vec3(cos(ang) * r, aData.z, -sin(ang) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vColor = mix(vec3(0.55, 0.62, 0.78), vec3(0.8, 0.82, 0.9), aData.w);
        vAlpha = uFade * (0.16 + 0.2 * aData.w);
        gl_PointSize = min(pointSize(0.05 + pow(aData.w, 5.0) * 0.08, -mv.z, vAlpha), 5.0);
        gl_Position = projectionMatrix * mv;
      }`,
    POINT_FRAG,
    { uClock: { value: 0 }, uFade: { value: 0 } },
  );
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, material, geometry, count };
}

export function buildSolarWind() {
  const count = 2600;
  const rand = mulberry32(99173);
  const dirs = new Float32Array(count * 3);
  const data = new Float32Array(count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection();
    v.y *= 0.6; // denser near the ecliptic
    v.normalize();
    dirs.set([v.x, v.y, v.z], i * 3);
    data.set([rand(), rand()], i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 2));
  const material = additiveMaterial(
    /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      uniform float uFade;
      uniform float uSun;
      attribute vec2 aData;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float s = fract(aData.x + uTime * (0.025 + aData.y * 0.02));
        float r = uSun * 1.05 + s * 30.0;
        vec3 p = normalize(position) * r;
        // A slight spiral: the Sun rotates while the wind flows out (Parker spiral).
        float twist = s * 0.9;
        p.xz = mat2(cos(twist), -sin(twist), sin(twist), cos(twist)) * p.xz;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vColor = vec3(1.0, 0.92, 0.75);
        vAlpha = uFade * smoothstep(0.0, 0.05, s) * ((1.0 - s) * (1.0 - s)) * 0.32;
        gl_PointSize = min(pointSize(0.05, -mv.z, vAlpha), 4.0);
        gl_Position = projectionMatrix * mv;
      }`,
    POINT_FRAG,
    { uTime: globalUniforms.uTime, uFade: { value: 0 }, uSun: { value: SUN_RADIUS } },
  );
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, material };
}

/**
 * The main asteroid belt as it really is: a thick, sparse torus of dark rock (orbits tilted
 * up to ~20°), densest near 2.7 AU, with Kirkwood gaps cleared by Jupiter's resonances,
 * plus the two Trojan swarms that share Jupiter's orbit 60° ahead of and behind it.
 * Each speck is lit by the Sun: bright when the Sun is behind the viewer, faint against it.
 */
export function buildBelt() {
  const mainCount = 8000;
  const trojans = 1600;
  const count = mainCount + trojans;
  const rand = mulberry32(99);
  const data = new Float32Array(count * 4);
  const extra = new Float32Array(count * 2);
  // Semi-major axis (AU) → scene radius across the belt.
  const AU0 = 2.1;
  const AU1 = 3.3;
  const toScene = (au: number) => ASTEROID_BELT.inner + ((au - AU0) / (AU1 - AU0)) * (ASTEROID_BELT.outer - ASTEROID_BELT.inner);
  // Kirkwood gaps: 3:1, 5:2, 7:3 and 2:1 resonances with Jupiter.
  const gaps = [2.5, 2.82, 2.95, 3.27];
  const jupiter = PLANETS.find((p) => p.id === 'jupiter')!;
  for (let i = 0; i < count; i++) {
    let r: number;
    let ang: number;
    let incl: number;
    let kind = 0;
    if (i < mainCount) {
      let au = 0;
      do {
        au = 2.75 + gaussian(rand) * 0.3;
      } while (au < AU0 || au > AU1 || gaps.some((g) => Math.abs(au - g) < 0.02 + 0.015 * rand()));
      r = toScene(au) * (1 + gaussian(rand) * 0.02);
      ang = rand() * Math.PI * 2;
      incl = Math.abs(gaussian(rand)) * 0.13;
    } else {
      // Trojans: clouds around L4 / L5, stretched along the orbit.
      kind = 1;
      r = jupiter.orbit * (1 + gaussian(rand) * 0.035);
      ang = (rand() < 0.5 ? 1 : -1) * (Math.PI / 3) + gaussian(rand) * 0.32;
      incl = Math.abs(gaussian(rand)) * 0.18;
    }
    // Height above the plane from the orbit's tilt and where along it the body is.
    const node = rand() * Math.PI * 2;
    data.set([r, ang, incl, rand()], i * 4);
    extra.set([node, kind], i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  geometry.setAttribute('aExtra', new THREE.BufferAttribute(extra, 2));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uClock: { value: 0 },
      uFade: { value: 0 },
      uJupiter: { value: 0 },
      uViewScale: globalUniforms.uViewScale,
    },
    vertexShader: /* glsl */ `
      ${POINT_SIZE}
      uniform float uClock;
      uniform float uFade;
      uniform float uJupiter;
      attribute vec4 aData;
      attribute vec2 aExtra;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float r = aData.x;
        // Belt bodies follow Kepler's law; Trojans ride along with Jupiter.
        float ang = aExtra.y > 0.5 ? uJupiter + aData.y : aData.y + uClock * 0.16 * pow(7.7 / r, 1.5);
        float h = r * sin(aData.z) * sin(ang - aExtra.x);
        vec3 p = vec3(cos(ang) * r, h, -sin(ang) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
        // Phase lighting: full when lit from behind the viewer, a thin glint against the Sun.
        float phase = dot(normalize(-wp), normalize(cameraPosition - wp)) * 0.5 + 0.5;
        float lit = 0.12 + 0.88 * phase * phase;
        // Dark carbonaceous (most), stony and the odd metallic body.
        float k = fract(aData.w * 7.31);
        vColor = (k < 0.68 ? vec3(0.32, 0.31, 0.3) : (k < 0.93 ? vec3(0.6, 0.5, 0.4) : vec3(0.62, 0.6, 0.58))) * lit;
        // Steep power law: countless specks, very few large bodies.
        float size = 0.012 + pow(aData.w, 7.0) * 0.1;
        vAlpha = uFade * (0.25 + 0.55 * aData.w);
        gl_PointSize = min(pointSize(size, -mv.z, vAlpha), 5.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float d = dot(c, c);
        if (d > 1.0) discard;
        // Opaque little rocks, not glowing dust: normal blending, no pile-up into a band.
        gl_FragColor = vec4(vColor, smoothstep(1.0, 0.35, d) * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, material, geometry, count };
}

export class AsteroidRocks {
  mesh!: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
  private data: { r: number; a: number; y: number; size: number; spin: THREE.Vector3; spinSpeed: number }[] = [];
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3();

  constructor() {
    const rand = mulberry32(123);
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = Math.sin(v.x * 3.1 + 1.3) * Math.sin(v.y * 2.7 + 0.4) * Math.sin(v.z * 3.7 + 2.1);
      v.multiplyScalar(0.8 + n * 0.35);
      pos.setXYZ(i, v.x, v.y * 0.85, v.z);
    }
    geo.computeVertexNormals();
    const count = 40;
    const material = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vW;
        void main() {
          mat4 m = modelMatrix * instanceMatrix;
          vec4 w = m * vec4(position, 1.0);
          vW = w.xyz;
          vN = normalize(mat3(m) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFade;
        varying vec3 vN;
        varying vec3 vW;
        void main() {
          float diff = max(dot(normalize(vN), normalize(-vW)), 0.0);
          gl_FragColor = vec4(vec3(0.5, 0.46, 0.42) * (0.03 + diff * 1.1), uFade);
        }`,
      transparent: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, material, count);
    this.mesh.frustumCulled = false;
    this.data = Array.from({ length: count }, () => ({
      r: lerp(ASTEROID_BELT.inner, ASTEROID_BELT.outer, rand()),
      a: rand() * Math.PI * 2,
      y: (rand() - 0.5) * 1.6,
      size: 0.05 + Math.pow(rand(), 3) * 0.14,
      spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      spinSpeed: 0.2 + rand() * 0.8,
    }));
}

  update(clock: number, time: number, fade: number): void {
    this.data.forEach((d, i) => {
      const ang = d.a + clock * 0.16 * Math.pow(7.7 / d.r, 1.5);
      this.pos.set(Math.cos(ang) * d.r, d.y, -Math.sin(ang) * d.r);
      this.quat.setFromAxisAngle(d.spin, time * d.spinSpeed);
      this.scale.setScalar(d.size);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.material.uniforms.uFade.value = fade;
  }
}

export function buildRingChunks(saturn: PlanetView): THREE.ShaderMaterial {
  const R = saturn.data.size;
  const rand = mulberry32(2004);
  const count = Math.round(14000 * Math.max(0.5, config.particleScale));
  const data = new Float32Array(count * 4);
  // Same profile as the ring shader: bands, the Cassini division, soft edges.
  const density = (rn: number) => {
    const bands = 0.55 + 0.22 * Math.sin(rn * 61) + 0.14 * Math.sin(rn * 147 + 1) + 0.1 * Math.sin(rn * 23);
    const cassini = rn > 0.6 && rn < 0.69 ? 0.08 : 1;
    return Math.max(0, bands) * cassini * Math.min(1, rn / 0.05) * Math.min(1, (1 - rn) / 0.08);
  };
  for (let i = 0; i < count; i++) {
    let rn = 0;
    do rn = rand();
    while (rand() > density(rn));
    data.set([R * (1.3 + rn * 1.05), rand() * Math.PI * 2, (rand() - 0.5) * R * 0.012, rand()], i * 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  const material = new THREE.ShaderMaterial({
    uniforms: { uClock: { value: 0 }, uFade: { value: 0 }, uNear: { value: 1 }, uViewScale: globalUniforms.uViewScale },
    vertexShader: /* glsl */ `
      ${POINT_SIZE}
      uniform float uClock;
      uniform float uFade;
      uniform float uNear;
      attribute vec4 aData;
      varying float vAlpha;
      varying float vLit;
      void main() {
        float r = aData.x;
        // Inner ringlets overtake outer ones (Kepler).
        float ang = aData.y + uClock * 1.2 * pow(${R.toFixed(3)} * 1.3 / r, 1.5);
        vec3 p = vec3(cos(ang) * r, aData.z, -sin(ang) * r);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vec4 mv = viewMatrix * wp;
        // Only up close: the chunks fade in as the camera nears the rings.
        float d = distance(wp.xyz, cameraPosition);
        vAlpha = uFade * (1.0 - smoothstep(uNear * 0.3, uNear, d)) * (0.3 + 0.5 * aData.w);
        // Ice in sunlight: brightest when lit from behind the viewer.
        vec3 L = normalize(-wp.xyz);
        vLit = 0.35 + 0.65 * (dot(L, normalize(cameraPosition - wp.xyz)) * 0.5 + 0.5);
        float size = ${(R * 0.0035).toFixed(5)} * (0.4 + pow(aData.w, 4.0) * 2.4);
        gl_PointSize = min(pointSize(size, -mv.z, vAlpha), 7.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vLit;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float d = dot(c, c);
        if (d > 1.0) discard;
        gl_FragColor = vec4(vec3(0.92, 0.88, 0.8) * vLit, smoothstep(1.0, 0.3, d) * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  saturn.tilt.add(points);
  return material;
}
