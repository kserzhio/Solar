import * as THREE from 'three';
import { POINT_FRAG, POINT_SIZE, additiveMaterial, colorUniform, globalUniforms, mulberry32 } from '../../shaders/common';
import type { Planet } from '../../data/planets';

/**
 * Atmospheric halo: for each pixel, find how close the view ray passes to the planet
 * and glow in a thin shell just outside the surface, brighter on the day side.
 */
export function buildAtmosphere(data: Planet, color: string) {
  if (data.id === 'earth') return buildEarthSky(data);
  const outer = data.size * 1.14;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uR: { value: data.size },
      uColor: colorUniform(color),
      uFade: { value: 0 },
      uStrength: { value: data.id === 'earth' ? 1.3 : data.kind === 'rocky' ? 0.6 : 0.6 },
      uTwilight: { value: data.id === 'earth' ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPosW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPosW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter;
      uniform float uR;
      uniform vec3 uColor;
      uniform float uFade;
      uniform float uStrength;
      uniform float uTwilight;
      varying vec3 vPosW;
      void main() {
        vec3 rd = normalize(vPosW - cameraPosition);
        float t = dot(uCenter - cameraPosition, rd);
        vec3 closest = cameraPosition + rd * t;
        float b = length(closest - uCenter);
        float h = clamp((b - uR) / (uR * 0.14), 0.0, 1.0);
        float glow = pow(1.0 - h, 2.2);
        float cosSun = dot(normalize(closest - uCenter), normalize(-uCenter));
        float day = smoothstep(-0.35, 0.5, cosSun);
        vec3 col = uColor * glow * (0.08 + day) * uStrength;
        // Sunset/sunrise ring where the terminator meets the limb.
        col += vec3(1.0, 0.45, 0.2) * glow * exp(-((cosSun / 0.22) * (cosSun / 0.22))) * uTwilight * 0.9;
        gl_FragColor = vec4(col * uFade * 0.8, 1.0);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(outer, 48, 32), material);
}

/**
 * Earth's air, computed rather than painted: single scattering along the view ray through a
 * thin shell (Rayleigh, strongest in blue, plus a little Mie haze), with each sample lit
 * through the atmosphere towards the Sun. The blue limb on the day side, the orange-red
 * band where the Sun sets and the dark night side all follow from it. (The shell is a
 * little thicker than the real one so it reads at this scale.)
 */
export function buildEarthSky(data: Planet) {
  const ATMO = 1.07;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uR: { value: data.size },
      uFade: { value: 0 },
      uOccPos: { value: new THREE.Vector3() },
      uOccR: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPosW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPosW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter;
      uniform float uR;
      uniform float uFade;
      uniform vec3 uOccPos;
      uniform float uOccR;
      varying vec3 vPosW;
      const float ATMO = ${ATMO.toFixed(3)};
      // Scattering coefficients per planet radius: Rayleigh in the 5.8 : 13.5 : 33.1 ratio of
      // real air, scaled so the limb is optically thick in blue; grey Mie haze.
      const vec3 BETA_R = vec3(0.82, 1.92, 4.7);
      const float BETA_M = 0.25;
      const float H_R = 0.25;   // scale heights, as fractions of the shell's thickness
      const float H_M = 0.1;

      vec2 sphere(vec3 ro, vec3 rd, float r) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - r * r;
        float h = b * b - c;
        if (h < 0.0) return vec2(1e9, -1e9);
        h = sqrt(h);
        return vec2(-b - h, -b + h);
      }

      void main() {
        // Work in units of the planet's radius, centred on it.
        vec3 ro = (cameraPosition - uCenter) / uR;
        vec3 rd = normalize(vPosW - cameraPosition);
        vec3 L = normalize(-uCenter);
        vec2 ta = sphere(ro, rd, ATMO);
        if (ta.x > ta.y) discard;
        vec2 tp = sphere(ro, rd, 1.0);
        float t0 = max(ta.x, 0.0);
        float t1 = ta.y;
        if (tp.x < tp.y && tp.x > 0.0) t1 = min(t1, tp.x);
        float thick = ATMO - 1.0;
        float seg = (t1 - t0) / 10.0;
        vec3 sumR = vec3(0.0);
        vec3 sumM = vec3(0.0);
        float odR = 0.0;
        float odM = 0.0;
        for (int i = 0; i < 10; i++) {
          vec3 p = ro + rd * (t0 + seg * (float(i) + 0.5));
          float h = (length(p) - 1.0) / thick;
          float dR = exp(-h / H_R) * seg;
          float dM = exp(-h / H_M) * seg;
          odR += dR;
          odM += dM;
          // Sunlight reaching this sample: shadowed by the planet (softly, as sunlight
          // grazing the limb is already reddened and dimmed), or dimmed by the air.
          float along = dot(p, L);
          float miss = length(p - L * along);
          float lit = along > 0.0 ? 1.0 : smoothstep(0.97, 1.03, miss);
          // ...and by the Moon during a solar eclipse.
          if (uOccR > 0.0) {
            vec3 m = (uOccPos - uCenter) / uR;
            float tm = dot(m - p, L);
            if (tm > 0.0) lit *= smoothstep(uOccR / uR * 0.55, uOccR / uR * 1.25, length(m - p - L * tm));
          }
          if (lit <= 0.0) continue;
          float segL = sphere(p, L, ATMO).y / 4.0;
          float lR = 0.0;
          float lM = 0.0;
          for (int j = 0; j < 4; j++) {
            vec3 q = p + L * segL * (float(j) + 0.5);
            float hq = max(length(q) - 1.0, 0.0) / thick;
            lR += exp(-hq / H_R) * segL;
            lM += exp(-hq / H_M) * segL;
          }
          vec3 tau = BETA_R * (odR + lR) + BETA_M * 1.1 * (odM + lM);
          vec3 att = exp(-tau) * lit;
          sumR += att * dR;
          sumM += att * dM;
        }
        float mu = dot(rd, L);
        float phaseR = 0.0597 * (1.0 + mu * mu);
        float g = 0.76;
        float phaseM = 0.119 * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
        vec3 col = 16.0 * (sumR * BETA_R * phaseR + sumM * BETA_M * phaseM);
        // Looking down through the air at the surface: a thinner veil than at the limb.
        if (tp.x < tp.y && tp.x > 0.0) col *= 0.55;
        gl_FragColor = vec4(col * uFade, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(data.size * ATMO, 64, 48), material);
}

export function buildPlumes(io: THREE.Mesh, radius: number): THREE.ShaderMaterial {
  const vents = [new THREE.Vector3(0.6, 0.7, 0.39), new THREE.Vector3(-0.55, 0.25, -0.8), new THREE.Vector3(0.1, -0.6, 0.79)].map((v) => v.normalize());
  const per = 220;
  const rand = mulberry32(31337);
  const data = new Float32Array(vents.length * per * 4);
  const dirs = new Float32Array(vents.length * per * 3);
  let i = 0;
  for (const n of vents) {
    for (let k = 0; k < per; k++, i++) {
      dirs.set([n.x, n.y, n.z], i * 3);
      data.set([rand(), rand() * Math.PI * 2, 0.6 + rand() * 0.6, rand()], i * 4);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  const material = additiveMaterial(
    /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      uniform float uR;
      uniform float uFade;
      attribute vec4 aData;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec3 n = normalize(position);
        vec3 t1 = normalize(cross(n, vec3(0.0, 1.0, 0.3)));
        vec3 t2 = cross(n, t1);
        float ph = fract(aData.x + uTime * 0.3);
        float height = 4.0 * ph * (1.0 - ph) * uR * 1.1 * aData.z;
        vec3 lateral = (t1 * cos(aData.y) + t2 * sin(aData.y)) * ph * uR * 0.9 * aData.z;
        vec3 p = n * (uR + height) + lateral;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vColor = mix(vec3(1.0, 0.92, 0.6), vec3(0.6, 0.75, 1.0), ph) * 1.6;
        vAlpha = uFade * (1.0 - ph) * 0.75;
        gl_PointSize = min(pointSize(uR * 0.09, -mv.z, vAlpha), 6.0);
        gl_Position = projectionMatrix * mv;
      }`,
    POINT_FRAG,
    { uTime: globalUniforms.uTime, uR: { value: radius }, uFade: { value: 0 } },
  );
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  io.add(points);
  return material;
}
