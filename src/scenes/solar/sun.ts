import * as THREE from 'three';
import { config } from '../../config';
import { NOISE, colorUniform, globalUniforms, mulberry32 } from '../../shaders/common';
import { SUN_RADIUS } from '../../data/planets';
import { type SunNoiseCube, createSunStrands } from '../sunFx';
import { PLANET_VERT } from './common';

/** Sunspot slots in the surface shader. */
export const SUN_SPOTS = 12;

/**
 * The Sun's surface, with its sunspot groups (each a list of spot directions, leading spot
 * first, on the unrotated Sun).
 */
export function buildSun(noiseCube: SunNoiseCube): { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>; spotGroups: THREE.Vector3[][] } {
  // Sunspot groups in the two activity belts (±8–30° latitude): a leading and a trailing
  // spot per group, plus a few loners. xyz = direction on the unrotated Sun, w = radius.
  const rand = mulberry32(1859);
  const spots: THREE.Vector4[] = [];
  const spotGroups: THREE.Vector3[][] = [];
  const groups = [
    { lat: 14, lon: 20 }, { lat: -11, lon: 95 }, { lat: 22, lon: 170 }, { lat: -19, lon: 250 }, { lat: 9, lon: 305 },
  ];
  for (const g of groups) {
    const n = 2 + Math.floor(rand() * 2);
    const members: THREE.Vector3[] = [];
    spotGroups.push(members);
    for (let k = 0; k < n; k++) {
      const lat = THREE.MathUtils.degToRad(g.lat + (rand() - 0.5) * 4 + (k > 0 ? (g.lat > 0 ? 1.5 : -1.5) : 0));
      const lon = THREE.MathUtils.degToRad(g.lon - k * (5 + rand() * 4));
      const r = (k === 0 ? 0.085 : 0.05) * (0.7 + rand() * 0.6);
      spots.push(new THREE.Vector4(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon), r));
      members.push(new THREE.Vector3(spots[spots.length - 1].x, spots[spots.length - 1].y, spots[spots.length - 1].z));
    }
  }
  while (spots.length < SUN_SPOTS) spots.push(new THREE.Vector4(0, 1, 0, 0));
  spots.length = SUN_SPOTS;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uColor: colorUniform(config.colors.sun),
      uFade: { value: 0 },
      uFlareDir: { value: new THREE.Vector3(1, 0, 0) },
      uFlareAge: { value: 99 },
      uGran: { value: 34 },
      uSpots: { value: spots },
      uPerlin: { value: noiseCube.texture },
      uTint: { value: 0.92 },
      uBright: { value: 0.92 },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uFade;
      uniform vec3 uFlareDir;
      uniform float uFlareAge;
      uniform float uGran;
      uniform vec4 uSpots[${SUN_SPOTS}];
      uniform samplerCube uPerlin;
      uniform float uTint;
      uniform float uBright;
      varying vec3 vObj;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      // 3D Worley noise: F1 and F2 distances to the nearest feature points, and a random
      // value for the nearest cell (so every granule gets its own brightness).
      vec3 worley(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        float f1 = 8.0; float f2 = 8.0; float id = 0.0;
        for (int x = -1; x <= 1; x++)
        for (int y = -1; y <= 1; y++)
        for (int z = -1; z <= 1; z++) {
          vec3 g = vec3(float(x), float(y), float(z));
          vec3 h = i + g;
          vec3 r = fract(sin(vec3(dot(h, vec3(127.1, 311.7, 74.7)), dot(h, vec3(269.5, 183.3, 246.1)), dot(h, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
          float seed = r.x;
          r = 0.5 + 0.42 * sin(uTime * 0.22 + 6.2831 * r);   // granules slowly boil
          float d = length(g + r - f);
          if (d < f1) { f2 = f1; f1 = d; id = seed; } else if (d < f2) { f2 = d; }
        }
        return vec3(f1, f2, id);
      }

      void main() {
        vec3 o = vObj;
        vec3 V = normalize(cameraPosition - vPosW);
        float mu = clamp(dot(normalize(vNormalW), V), 0.0, 1.0);
        // The Sun turns once every ~3 minutes here; everything on the surface rides along.
        float th = uTime * 0.035;
        vec3 q = vec3(o.x * cos(th) + o.z * sin(th), o.y, -o.x * sin(th) + o.z * cos(th));

        // Granulation: bright, domed cells split by dark lanes. When the cells shrink below
        // a pixel they melt into their mean brightness instead of shimmering.
        vec3 gp = q * uGran * 1.45 + snoise(q * 5.0 + uTime * 0.03) * 0.5;
        float px = length(fwidth(gp));
        float detail = 1.0 - smoothstep(0.35, 0.9, px);
        // Domed cells of varied brightness (each brightening and dimming as it evolves),
        // separated by soft, darker lanes; skipped entirely once they are sub-pixel.
        // Gentle contrast: granulation is a texture on the disk, not a mosaic.
        float gran = 0.82;
        if (detail > 0.01) {
          vec3 w = worley(gp);
          float own = 0.78 + 0.32 * fract(w.z * 17.0 + uTime * 0.03);
          float dome = smoothstep(1.05, 0.05, w.x);
          float lane = smoothstep(0.0, 0.5, w.y - w.x);
          float cell = (0.45 + 0.65 * dome) * (0.62 + 0.38 * lane) * own;
          gran = mix(0.82, mix(0.82, cell, 0.6), detail);
        }
        // Larger, gentler mottling and slow brightness drift.
        float meso = fbm3(q * 9.0 + vec3(0.0, uTime * 0.02, 0.0));
        float large = fbm3(q * 2.6 + vec3(0.0, uTime * 0.01, uTime * 0.006));

        // Sunspots: dark umbra, a filamentary penumbra, bright faculae around the group.
        float umbra = 0.0;
        float pen = 0.0;
        float plage = 0.0;
        for (int i = 0; i < ${SUN_SPOTS}; i++) {
          vec4 sp = uSpots[i];
          if (sp.w <= 0.0) continue;
          vec3 c = sp.xyz;
          float cd = dot(q, c);
          if (cd < 0.8) continue;
          vec3 v = q - c * cd;
          vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.0001)));
          vec3 t2 = cross(c, t1);
          float rr = length(v) / sp.w;
          float ang = atan(dot(v, t2), dot(v, t1));
          float rag = snoise(vec3(ang * 1.6, rr * 1.5, float(i) * 3.7 + uTime * 0.02)) * 0.12;
          float fil = 0.5 + 0.5 * sin(ang * 38.0 + snoise(vec3(ang * 4.0, rr * 3.0, float(i))) * 4.0);
          float p = 1.0 - smoothstep(0.9, 1.05, rr + rag);
          float u = 1.0 - smoothstep(0.36, 0.46, rr + rag * 0.6);
          pen = max(pen, p * (0.75 + 0.25 * fil) * (1.0 - u));
          umbra = max(umbra, u);
          plage += (1.0 - smoothstep(1.2, 3.2, rr)) * (1.0 - p);
        }

        // Faculae: bright network that stands out towards the limb, strongest near spots.
        float network = smoothstep(0.2, 0.55, fbm3(q * 7.0 + 21.0));
        float limbW = pow(1.0 - mu, 1.3);
        float faculae = (network * 0.5 + min(plage, 1.0) * 0.9) * limbW;

        // Convection: the baked 4D noise cube read through three frames turning slowly
        // about different axes and averaged, so the plasma churns rather than slides.
        float lt = uTime * 0.02;
        float lt1 = lt + 2.094;
        float lt2 = lt + 4.188;
        vec3 l0 = q; l0.yz = mat2(cos(lt), -sin(lt), sin(lt), cos(lt)) * l0.yz;
        vec3 l1 = q; l1.zx = mat2(cos(lt1), -sin(lt1), sin(lt1), cos(lt1)) * l1.zx;
        vec3 l2 = q; l2.xy = mat2(cos(lt2), -sin(lt2), sin(lt2), cos(lt2)) * l2.xy;
        vec2 churn = (textureCube(uPerlin, l0).rg + textureCube(uPerlin, l1).rg + textureCube(uPerlin, l2).rg) / 3.0;
        float conv = (churn.x - 0.5) * 1.6 + (churn.y - 0.5) * 0.3;

        // Everything sets one brightness value; a single colour ramp then turns it into fire.
        float b = 0.66 + conv * 0.42;
        b *= gran / 0.82 * (0.94 + meso * 0.08 + large * 0.08);
        b += faculae * 0.2;
        b *= 1.0 - pen * 0.42;
        b = mix(b, 0.22, umbra);
        // Limb darkening pulls the edge down the ramp (dimmer and redder)...
        b *= 0.6 + 0.4 * pow(mu, 0.55);
        // ...and a thin Fresnel rim lights it up again right at the edge.
        b += pow(1.0 - mu, 5.0) * 0.35;

        // Brightness to colour: (b, b^2, b^4) climbs from deep red through orange to white.
        // Past white it only gets brighter (HDR), so bloom picks out the hottest cells.
        float bt = max(b, 0.0) * uTint;
        float bc = min(bt, 1.0);
        vec3 col = vec3(bc, bc * bc, bc * bc * bc * bc) * (bt / max(bc, 1e-3)) / uTint * uBright;

        // Solar flare: two bright ribbons flashing in an active region, then fading.
        if (uFlareAge < 6.0) {
          float c = dot(o, normalize(uFlareDir));
          vec3 t = normalize(cross(uFlareDir, vec3(0.0, 1.0, 0.0)));
          float across = dot(o - uFlareDir * c, t);
          float region = smoothstep(0.985, 0.997, c);
          float rib = (abs(across) - 0.035) / 0.012;
          float ribbons = exp(-rib * rib);
          ribbons *= 0.6 + 0.6 * (snoise(o * 60.0 + uTime) * 0.5 + 0.5);
          float flash = exp(-uFlareAge * 0.9) * smoothstep(0.0, 0.15, uFlareAge);
          col += vec3(1.0, 0.95, 0.85) * (ribbons * region * 3.0 + region * 0.4) * flash;
        }
        gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);
      }`,
  });
  return { mesh: new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 128, 96), material), spotGroups };
}

/**
 * Coronal loops: magnetic arches of hot plasma rooted in the sunspot groups. Real tube
 * geometry, so they stand above the surface in 3D and show in profile at the limb;
 * bright knots of plasma stream along them from one footpoint to the other.
 */
export function buildLoops(
  sun: THREE.Object3D,
  spotGroups: THREE.Vector3[][],
  intensity: { value: number },
  sunR: { value: number },
): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(2024);
  const shared = { uTime: globalUniforms.uTime, uIntensity: intensity, uSunR: sunR };
  const slerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => {
    const w = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    if (w < 1e-5) return a.clone();
    return a.clone().multiplyScalar(Math.sin((1 - t) * w) / Math.sin(w)).addScaledVector(b, Math.sin(t * w) / Math.sin(w));
  };
  for (const g of spotGroups) {
    const lead = g[0];
    const trail = g[g.length - 1];
    const span = trail.clone().sub(lead);
    for (let k = 0; k < 6; k++) {
      const jitter = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.06);
      const a = lead.clone().addScaledVector(span, -0.15 + rand() * 0.2).add(jitter()).normalize();
      const b = trail.clone().addScaledVector(span, 0.3 + rand() * 0.6).add(jitter()).normalize();
      const h = 0.08 + rand() * 0.22;
      const lean = jitter().multiplyScalar(1.5);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const up = Math.sin(Math.PI * t);
        pts.push(slerp(a, b, t).addScaledVector(lean, up).normalize().multiplyScalar(SUN_RADIUS * (1.0 + h * up)));
      }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, SUN_RADIUS * (0.011 + rand() * 0.01), 8, false);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...shared, uSeed: { value: rand() * 100 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vN;
          varying vec3 vPosW;
          void main() {
            vUv = uv;
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0);
            vPosW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uIntensity;
          uniform float uSeed;
          uniform float uSunR;
          varying vec2 vUv;
          varying vec3 vN;
          varying vec3 vPosW;
          void main() {
            float along = vUv.x;
            // Seen against the bright disk the loops would only wash it out; beyond the
            // limb, against dark sky, they glow in full.
            vec3 rd = normalize(vPosW - cameraPosition);
            float tc = dot(-cameraPosition, rd);
            float b = length(cameraPosition + rd * max(tc, 0.0));
            float offDisk = smoothstep(uSunR * 0.97, uSunR * 1.02, b);
            float vis = mix(0.25, 1.0, offDisk);
            // Knots of plasma racing along the loop, and the loop as a whole slowly
            // brightening and fading like a real active region.
            float knots = 0.5 + 0.5 * sin(along * 26.0 - uTime * 2.2 + uSeed);
            knots = knots * knots;
            float life = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * 0.23 + uSeed * 1.7));
            float ends = smoothstep(0.0, 0.06, along) * smoothstep(1.0, 0.94, along);
            float foot = 1.0 + 1.2 * (exp(-along * 18.0) + exp(-(1.0 - along) * 18.0));
            vec3 V = normalize(cameraPosition - vPosW);
            float facing = clamp(abs(dot(normalize(vN), V)), 0.0, 1.0);
            float core = facing * facing;
            vec3 col = mix(vec3(1.0, 0.34, 0.05), vec3(1.0, 0.62, 0.2), knots);
            float k = (0.3 + 0.7 * knots) * core * ends * foot * life * uIntensity;
            gl_FragColor = vec4(col * k * vis * 0.55, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      group.add(new THREE.Mesh(geo, mat));
    }
  }
  sun.add(group);
  group.add(
    createSunStrands({
      radius: SUN_RADIUS,
      groups: spotGroups,
      count: Math.round(1400 * Math.max(0.5, config.particleScale)),
      uTime: globalUniforms.uTime,
      intensity: intensity,
      sunR: sunR,
    }),
  );
  return group;
}

/** The corona: a camera-facing billboard of streamers, rays and the flare's outflow. */
export function buildCorona() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uColor: colorUniform(config.colors.sun),
      uIntensity: { value: 0 },
      uFlareAngle: { value: 0 },
      uFlareAge: { value: 99 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uFlareAngle;
      uniform float uFlareAge;
      varying vec2 vUv;

      float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
      float angDiff(float a, float b) { return mod(a - b + 3.14159, 6.28318) - 3.14159; }

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float r0 = 0.125;                       // quad spans 16 solar radii
        float rs = r / r0;                      // distance in solar radii
        float ang = atan(p.y, p.x);
        float h = max(rs - 1.0, 0.0);

        // ---- Corona: soft K-corona glow plus a few broad, slowly turning streamers.
        float rot = uTime * 0.008;
        float streamers = 0.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          float a0 = fi * 1.2566 + hash1(fi + 3.0) * 0.8 + rot;
          float width = 0.18 + 0.14 * hash1(fi + 9.0);
          float da = angDiff(ang, a0);
          // Streamers taper with height, like helmet streamers.
          float w = width / (1.0 + h * 0.9);
          streamers += exp(-da * da / (w * w)) * (0.5 + 0.5 * hash1(fi + 5.0));
        }
        float wisp = snoise(vec3(cos(ang) * 3.0, sin(ang) * 3.0, uTime * 0.03 + h * 0.6)) * 0.5 + 0.5;
        float kCorona = pow(1.0 + h, -3.2);
        // Fine radial rays and polar plumes: thin filaments along the magnetic field.
        float rays = snoise(vec3(cos(ang) * 22.0, sin(ang) * 22.0, h * 0.25 + uTime * 0.015)) * 0.5 + 0.5;
        rays = mix(rays, snoise(vec3(cos(ang) * 60.0, sin(ang) * 60.0, h * 0.4 - uTime * 0.01)) * 0.5 + 0.5, 0.35);
        float fCorona = pow(1.0 + h, -1.8) * (0.25 + streamers * 0.6) * (0.75 + wisp * 0.5) * (0.65 + rays * 0.7);
        // Material streaming away: structures drift outwards through the corona.
        float outflow = snoise(vec3(cos(ang) * 14.0, sin(ang) * 14.0, h * 3.0 - uTime * 0.35)) * 0.5 + 0.5;
        fCorona *= 0.72 + 0.56 * outflow;
        // The whole corona breathes very slowly.
        fCorona *= 0.92 + 0.08 * sin(uTime * 0.21);
        float glow = (kCorona * 0.9 + fCorona * 0.55) * step(1.0, rs) * smoothstep(5.0, 2.2, rs);
        vec3 col = mix(vec3(1.0, 0.92, 0.78), uColor, 0.35) * glow;

        // ---- Chromosphere: a thin red rim.
        float chromo = exp(-(((rs - 1.0) / 0.015) * ((rs - 1.0) / 0.015)));
        // Spicules: a flickering fringe of tiny jets standing on the limb.
        float spikes = snoise(vec3(ang * 140.0, uTime * 0.9, 3.0)) * 0.5 + 0.5;
        float spicH = 0.018 + 0.03 * spikes;
        float spic = step(1.0, rs) * (1.0 - smoothstep(0.0, spicH, rs - 1.0)) * smoothstep(0.35, 0.9, spikes);
        chromo += spic * 0.7;

        // ---- Prominences with a life cycle: grow, hang, drain and dissipate, then
        // reappear elsewhere on the limb.
        float prom = 0.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          float period = 16.0 + hash1(fi * 7.3) * 14.0;
          float cyc = uTime / period + hash1(fi * 3.1);
          float life = fract(cyc);
          float gen = floor(cyc);
          float a0 = hash1(gen * 13.7 + fi * 5.1) * 6.28318;
          float halfW = 0.09 + 0.09 * hash1(gen + fi * 2.3);
          float H = 0.12 + 0.2 * hash1(gen * 2.9 + fi);
          float grow = smoothstep(0.0, 0.3, life);
          float fade = 1.0 - smoothstep(0.6, 0.92, life);
          float lift = smoothstep(0.55, 0.92, life) * 0.25;   // some lift off as they fade
          float x = angDiff(ang, a0) / halfW;
          if (abs(x) < 1.15 && fade > 0.0) {
            float arc = sqrt(max(1.0 - x * x, 0.0));
            // Turbulent plasma makes the arch ragged and flame-like rather than a clean hoop.
            float turb = snoise(vec3(x * 3.0, rs * 9.0 - uTime * 0.25, fi * 7.0 + gen)) * 0.5 + 0.5;
            float hh = (H * grow * arc + lift * arc) * (0.8 + 0.4 * turb);
            // Plasma drains down both legs: noise advected along the arc.
            float flow = snoise(vec3(abs(x) * 5.0 - uTime * 0.7, rs * 18.0, fi * 4.0 + gen)) * 0.5 + 0.5;
            float strands = 0.0;
            for (int k = -1; k <= 1; k++) {
              float off = float(k) * 0.024 * (1.0 + hh * 3.0);
              float d = abs(rs - 1.0 - hh - off);
              float thick = 0.016 + 0.016 * flow;
              strands += exp(-d * d / (thick * thick)) * (k == 0 ? 1.0 : 0.6);
            }
            float legs = smoothstep(1.15, 0.85, abs(x));
            prom += strands * (0.4 + 0.9 * flow) * legs * fade;
            // A glowing, wispy body of plasma fills the arch beneath the strands.
            float inside = step(1.0, rs) * smoothstep(1.0 + hh + 0.02, 1.0 + hh * 0.55, rs);
            float wisps = snoise(vec3(x * 6.0, rs * 30.0, uTime * 0.2 + fi)) * 0.5 + 0.5;
            prom += inside * (0.12 + 0.35 * wisps * flow) * fade * legs;
          }
        }
        float hcol = clamp(h / 0.25, 0.0, 1.0);
        // Hot orange-red hydrogen glow (no blue, so bloom keeps it fiery rather than pink).
        vec3 promCol = mix(vec3(1.0, 0.5, 0.14), vec3(0.9, 0.16, 0.03), hcol);
        col += promCol * prom * 1.8 + vec3(1.0, 0.2, 0.06) * chromo * 0.9;

        // ---- Coronal mass ejection after a flare: an expanding, fading bright front.
        if (uFlareAge < 6.0) {
          float da = angDiff(ang, uFlareAngle);
          float front = 1.0 + uFlareAge * 0.55;
          float spread = 0.32 + uFlareAge * 0.06;
          float ragged = snoise(vec3(cos(ang) * 7.0, sin(ang) * 7.0, uFlareAge * 0.4)) * 0.5 + 0.5;
          float shell = exp(-(((rs - front - (ragged - 0.5) * 0.12 * uFlareAge) / (0.05 + uFlareAge * 0.035)) * ((rs - front - (ragged - 0.5) * 0.12 * uFlareAge) / (0.05 + uFlareAge * 0.035))));
          shell *= 0.45 + 0.9 * ragged;
          float inside = smoothstep(front, 1.0, rs) * step(1.0, rs) * 0.25;
          float cone = exp(-da * da / (spread * spread));
          float cmeFade = exp(-uFlareAge * 0.55) * smoothstep(0.0, 0.25, uFlareAge) * smoothstep(6.5, 3.5, front);
          col += vec3(1.0, 0.86, 0.7) * (shell + inside) * cone * cmeFade * 0.9;
          // Post-flare loops glowing at the limb.
          float loops = exp(-(((rs - 1.04) / 0.03) * ((rs - 1.04) / 0.03))) * exp(-da * da / 0.012);
          col += vec3(1.0, 0.6, 0.35) * loops * exp(-uFlareAge * 0.4) * 1.4;
        }

        // Everything fades out well before the quad's edge, so nothing is ever clipped.
        col *= smoothstep(1.0, 0.82, r);
        gl_FragColor = vec4(col * uIntensity, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SUN_RADIUS * 16, SUN_RADIUS * 16), material);
  mesh.renderOrder = 2;
  return mesh;
}
