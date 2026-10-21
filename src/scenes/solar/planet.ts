import * as THREE from 'three';
import { NOISE, colorUniform, globalUniforms } from '../../shaders/common';
import type { Planet } from '../../data/planets';
import { KIND_INDEX, PLANET_VERT, type PlanetView } from './common';
import { buildAtmosphere } from './atmosphere';

/** How fast the cloud bands flow on each mapped giant (and Venus's cloud deck). */
const FLOW: Record<string, number> = { jupiter: 1, saturn: 0.6, uranus: 0.25, neptune: 0.45, venus: 0.7 };
/** How cratered each rocky body looks (0 = smooth). */
const CRATERS: Record<string, number> = { mercury: 1, mars: 0.3, ceres: 0.8, pluto: 0.2, eris: 0.3 };

/**
 * One planet (or dwarf planet): its pivot on the orbit, the tilted body with its surface
 * shader, rings, atmosphere, orbit line and an invisible hit target. Orbit lines go into
 * `group` (they do not move with the planet).
 */
export function buildPlanet(data: Planet, index: number, group: THREE.Object3D): PlanetView {
  const pivot = new THREE.Object3D();
  const tilt = new THREE.Object3D();
  tilt.rotation.z = THREE.MathUtils.degToRad(data.tilt);
  pivot.add(tilt);

  const [a, b, c, atmo] = data.colors;
  const shaderKind = data.id === 'venus' ? KIND_INDEX.ice : KIND_INDEX[data.kind];
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uKind: { value: shaderKind },
      uA: colorUniform(a),
      uB: colorUniform(b),
      uC: colorUniform(c),
      uAtmo: colorUniform(atmo),
      uSeed: { value: index * 13.7 + 3.1 },
      uTime: globalUniforms.uTime,
      uHighlight: { value: 0 },
      uFade: { value: 0 },
      uSpot: { value: data.spot ? new THREE.Vector4(data.spot.lat, data.spot.lon, data.spot.radius, 1) : new THREE.Vector4(0, 0, 0, 0) },
      uSpotColor: colorUniform(data.spot?.color ?? '#000000'),
      uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
      uRingCenter: { value: new THREE.Vector3() },
      uRingInner: { value: data.rings ? data.size * 1.3 : 0 },
      uRingOuter: { value: data.rings ? data.size * 2.35 : 0 },
      uHex: { value: data.id === 'saturn' ? 1 : 0 },
      uFlash: { value: new THREE.Vector4(1, 0, 0, 0) },
      uOccPos: { value: new THREE.Vector3() },
      uOccR: { value: 0 },
      uCraters: { value: CRATERS[data.id] ?? 0 },
      // Earth only: NASA Blue/Black Marble maps (loaded after start; procedural until then).
      uDay: { value: null },
      uNight: { value: null },
      uWater: { value: null },
      uCloudTex: { value: null },
      uTex: { value: 0 },
      // Every other body: a Solar System Scope colour map (procedural until it arrives).
      uMap: { value: null },
      uMapOn: { value: 0 },
      // Relief from the map's brightness (world units of height per unit of brightness).
      uBump: { value: 0 },
      // Giants: how fast the bands flow, and Jupiter's Great Red Spot (u, v, radius, spin).
      uFlowK: { value: FLOW[data.id] ?? 0 },
      uGRS: { value: data.id === 'jupiter' ? new THREE.Vector4(0.3705, 0.384, 0.035, 0.6) : new THREE.Vector4() },
      // Saturn: the real ring profile for the shadow the rings cast on the planet.
      uRingMap: { value: null },
      uRingMapOn: { value: 0 },
      uPolarCap: { value: data.id === 'mars' ? 1 : 0 },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform int uKind;
      uniform vec3 uA;
      uniform vec3 uB;
      uniform vec3 uC;
      uniform vec3 uAtmo;
      uniform float uSeed;
      uniform float uTime;
      uniform float uHighlight;
      uniform vec4 uSpot;
      uniform vec3 uSpotColor;
      uniform vec3 uRingNormal;
      uniform vec3 uRingCenter;
      uniform float uRingInner;
      uniform float uRingOuter;
      uniform float uHex;
      uniform vec4 uFlash;
      uniform vec3 uOccPos;
      uniform float uOccR;
      uniform float uFade;
      uniform float uCraters;
      uniform float uPolarCap;
      uniform sampler2D uDay;
      uniform sampler2D uNight;
      uniform sampler2D uWater;
      uniform sampler2D uCloudTex;
      uniform float uTex;
      uniform sampler2D uMap;
      uniform float uMapOn;
      uniform float uBump;
      uniform float uFlowK;
      uniform vec4 uGRS;
      uniform sampler2D uRingMap;
      uniform float uRingMapOn;

      // Bump mapping without tangents: tilt the normal against the screen-space slope of
      // the height (dark lowlands, bright highlands and crater rims).
      vec3 bumpNormal(vec3 pos, vec3 nrm, float h, float scale) {
        vec3 dpx = dFdx(pos);
        vec3 dpy = dFdy(pos);
        float dhx = dFdx(h) * scale;
        float dhy = dFdy(h) * scale;
        vec3 r1 = cross(dpy, nrm);
        vec3 r2 = cross(nrm, dpx);
        float det = dot(dpx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        return normalize(abs(det) * nrm - grad);
      }
      varying vec3 vObj;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      varying vec3 vSunObj;

      vec3 hash33(vec3 p) {
        p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
        return fract(sin(p) * 43758.5453);
      }

      // Impact craters at one scale: x = change in lighting (bowls lit on the far wall,
      // shadowed on the near one; raised rims the other way round), y = albedo change.
      vec2 craters(vec3 p, vec3 L, float density) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec2 acc = vec2(0.0);
        for (int x = -1; x <= 1; x++)
        for (int y = -1; y <= 1; y++)
        for (int z = -1; z <= 1; z++) {
          vec3 g = vec3(float(x), float(y), float(z));
          vec3 h = hash33(i + g);
          if (h.z > density) continue;
          float R = 0.16 + 0.3 * fract(h.x * 7.3 + h.y * 3.1);
          vec3 c = g + h - f;
          float len = length(c);
          float d = len / R;
          if (d > 1.4) continue;
          vec3 dir = c / max(len, 1e-4);
          float rim = 1.0 - smoothstep(1.0, 1.4, d);
          float slope = d < 1.0 ? d * d : -rim * 0.7;
          acc.x += dot(dir, L) * slope;
          acc.y += d < 1.0 ? -0.05 : 0.05 * rim;
        }
        return acc;
      }

      // Equirectangular lookup from a direction on the sphere (matches SphereGeometry's UVs),
      // choosing derivatives so the longitude wrap leaves no mip-map seam.
      vec2 eqUV(vec3 d) {
        return vec2(fract(atan(d.z, -d.x) / 6.2831853), asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5);
      }
      // blur > 1 reads a softer mip level (used for relief, so JPEG grain doesn't turn
      // into bumps).
      vec4 eqTexBlur(sampler2D t, vec3 d, float blur) {
        vec2 uv = eqUV(d);
        vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
        vec2 dx = dFdx(uv);
        vec2 dy = dFdy(uv);
        vec2 dx2 = dFdx(uv2);
        vec2 dy2 = dFdy(uv2);
        if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
        return textureGrad(t, uv, dx * blur, dy * blur);
      }
      vec4 eqTex(sampler2D t, vec3 d) { return eqTexBlur(t, d, 1.0); }

      // Flowing clouds from a still map (the flow-map technique): read the map twice,
      // each displaced along the flow over a looping cycle, half a cycle apart, and
      // cross-fade so a cycle restarts only while it is invisible. Zonal jets alternate
      // with latitude; around Jupiter's Great Red Spot the flow turns into a vortex.
      vec4 flowTex(sampler2D t, vec3 d) {
        vec2 uv = eqUV(d);
        vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
        vec2 dx = dFdx(uv);
        vec2 dy = dFdy(uv);
        vec2 dx2 = dFdx(uv2);
        vec2 dy2 = dFdy(uv2);
        if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
        float lat = (uv.y - 0.5) * 3.14159265;
        vec2 flow = vec2(sin(lat * 26.0) * 0.012 * uFlowK, 0.0);
        if (uGRS.w > 0.0) {
          vec2 rel = uv - uGRS.xy;
          rel.x = (fract(rel.x + 0.5) - 0.5) * 2.0 * cos(lat);
          float fall = exp(-dot(rel, rel) / (uGRS.z * uGRS.z));
          vec2 swirl = vec2(-rel.y, rel.x) * uGRS.w * fall;
          swirl.x /= max(2.0 * cos(lat), 0.2);
          flow += swirl;
        }
        float cyc = uTime / 9.0;
        float p1 = fract(cyc);
        float p2 = fract(cyc + 0.5);
        vec4 a = textureGrad(t, uv - flow * p1, dx, dy);
        vec4 b = textureGrad(t, uv - flow * p2, dx, dy);
        float wa = 1.0 - abs(2.0 * p1 - 1.0);
        return a * wa + b * (1.0 - wa);
      }
      // Cheap flow field (layered, rotated sines): nudging the cloud lookup with it makes a
      // still cloud map look alive, swirling slowly, with no animated texture at all.
      vec3 flowSine(vec3 p, float t) {
        vec3 sum = vec3(0.0);
        float amp = 1.0;
        for (int i = 0; i < 3; i++) {
          p = vec3(p.y * 0.8 + p.z * 0.6, p.z * 0.8 - p.x * 0.6, p.x * 0.8 + p.y * 0.6);
          vec3 w = sin(p + t + sum.zxy) * amp;
          sum += w;
          p *= 1.7;
          amp *= 0.6;
        }
        return sum;
      }

      // Earth's clouds: wind-sheared bands with domain-warped swirls, drifting eastwards.
      float earthClouds(vec3 o) {
        vec3 q = o * vec3(2.3, 4.0, 2.3) + vec3(uTime * 0.03, 0.0, uSeed + uTime * 0.018);
        vec3 w = vec3(fbm3(q * 0.9 + 1.7), fbm3(q * 0.9 + 8.3), fbm3(q * 0.9 + 4.1));
        float n = fbm5(q + w * 1.1);
        // Clear skies over the subtropical deserts, storm belts at mid-latitudes.
        float belts = 0.82 + 0.18 * cos(abs(o.y) * 10.5);
        return smoothstep(0.06, 0.5, n * belts + 0.04);
      }

      void main() {
        vec3 o = vObj;
        vec3 col;
        float cityLights = 0.0;
        float aurora = 0.0;
        float oceanMask = 0.0;
        float cloudCover = 0.0;
        float mapH = 0.0;
        if (uMapOn > 0.5) {
          vec3 mo = o;
          if (uFlowK > 0.0) col = flowTex(uMap, o).rgb;
          else col = eqTex(uMap, mo).rgb;
          if (uBump > 0.0) mapH = dot(eqTexBlur(uMap, mo, 3.0).rgb, vec3(0.3, 0.59, 0.11));
          if (uKind == 2) col *= 0.88;
        } else if (uKind == 0) {
          float f = fbm5(o * 3.0 + uSeed);
          float g = fbm3(o * 10.0 + uSeed * 2.0);
          col = mix(uB, uA, smoothstep(-0.45, 0.45, f));
          col = mix(col, uC, smoothstep(0.15, 0.6, g) * 0.45);
          if (uCraters > 0.0) {
            // Two sizes of craters; the small ones melt away when they shrink below a pixel.
            // Sunlight along the surface: strong at the terminator, vanishing where the
            // Sun is overhead (no shadows there), exactly as on the real Moon.
            vec3 Lo = normalize(vSunObj);
            Lo = (Lo - o * dot(Lo, o)) * 1.25;
            vec3 p1 = o * 6.0 + uSeed;
            vec3 p2 = o * 15.0 + uSeed * 1.7;
            float d1 = 1.0 - smoothstep(0.4, 1.0, length(fwidth(p1)));
            float d2 = 1.0 - smoothstep(0.4, 1.0, length(fwidth(p2)));
            vec2 cr = craters(p1, Lo, 0.5) * d1 + craters(p2, Lo, 0.7) * 0.6 * d2;
            col *= clamp(1.0 + (cr.x * 0.85 + cr.y) * uCraters, 0.25, 1.9);
          }
          if (uPolarCap > 0.0) {
            // Mars: bright water/CO2 ice caps with ragged edges.
            float cap = smoothstep(0.935, 0.955, abs(o.y) + f * 0.04 + g * 0.02);
            col = mix(col, vec3(0.94, 0.93, 0.9), cap * uPolarCap);
          }
        } else if (uKind == 1 && uTex > 0.5) {
          // The real Earth: Blue Marble surface, ocean mask, cloud map and night lights.
          col = eqTex(uDay, o).rgb;
          float water = eqTex(uWater, o).r;
          // Clouds drift slowly over the ground and churn through the flow field.
          float ct = uTime * 0.006;
          vec3 co = vec3(o.x * cos(ct) - o.z * sin(ct), o.y, o.x * sin(ct) + o.z * cos(ct));
          co = normalize(co + flowSine(co * 16.0, uTime * 0.25) * 0.004);
          float clouds = eqTex(uCloudTex, co).a;
          // Their shadows fall on the ground slightly away from the Sun.
          float shadow = eqTex(uCloudTex, normalize(co + normalize(vSunObj) * 0.012)).a;
          col *= 1.0 - shadow * (1.0 - clouds) * 0.45;
          col = mix(col, vec3(0.95, 0.96, 0.98), clouds * 0.92);
          oceanMask = water;
          cloudCover = clouds;
          vec3 night = eqTex(uNight, o).rgb;
          cityLights = dot(night, vec3(0.45, 0.4, 0.15)) * (1.0 - clouds * 0.85) * 1.6;
          float lat = abs(o.y);
          float curtain = snoise(vec3(atan(o.z, o.x) * 7.0, lat * 26.0, uTime * 0.45)) * 0.5 + 0.5;
          aurora = smoothstep(0.9, 0.925, lat) * (1.0 - smoothstep(0.94, 0.97, lat)) * (0.3 + 0.7 * curtain);
        } else if (uKind == 1) {
          // Continents: domain-warped noise gives ragged coasts, peninsulas and islands.
          vec3 warp = vec3(fbm3(o * 1.7 + uSeed), fbm3(o * 1.7 + uSeed + 5.2), fbm3(o * 1.7 + uSeed + 9.7));
          float f = fbm5(o * 1.9 + warp * 0.75 + uSeed);
          float land = smoothstep(0.045, 0.07, f);
          float lat = abs(o.y);
          // Oceans: deep navy, turquoise over the shallow shelves along the coasts.
          float shelf = smoothstep(-0.06, 0.045, f) * (1.0 - land);
          vec3 ocean = mix(vec3(0.012, 0.05, 0.17), vec3(0.03, 0.19, 0.3), shelf);
          ocean *= 0.88 + 0.24 * fbm3(o * 9.0);
          // Land: forests and grassland, dry subtropical belts, tundra, bare mountains.
          float moist = fbm3(o * 4.5 + warp + 13.0);
          vec3 ground = mix(vec3(0.2, 0.26, 0.11), vec3(0.06, 0.15, 0.06), smoothstep(-0.12, 0.25, moist));
          float dry = smoothstep(0.14, 0.28, lat) * (1.0 - smoothstep(0.42, 0.55, lat)) * smoothstep(0.1, -0.2, moist);
          ground = mix(ground, vec3(0.6, 0.48, 0.31), clamp(dry * 1.6, 0.0, 1.0));
          ground = mix(ground, vec3(0.3, 0.29, 0.25), smoothstep(0.72, 0.84, lat));
          ground = mix(ground, vec3(0.42, 0.39, 0.35), smoothstep(0.24, 0.42, f) * 0.6);
          col = mix(ocean, ground, land);
          float ice = smoothstep(0.9, 0.94, lat + f * 0.08 + fbm3(o * 6.0) * 0.03);
          col = mix(col, vec3(0.88, 0.92, 0.97), ice);
          // Clouds, and their shadows cast on the ground slightly away from the Sun.
          float clouds = earthClouds(o);
          float shadow = earthClouds(normalize(o + normalize(vSunObj) * 0.018));
          col *= 1.0 - shadow * (1.0 - clouds) * 0.4;
          col = mix(col, vec3(0.93, 0.95, 0.98), clouds * 0.85);
          oceanMask = 1.0 - land;
          cloudCover = clouds;
          // City lights: clustered on land, densest along the coasts, sparse in deserts.
          float towns = smoothstep(0.6, 0.9, snoise(o * 52.0) * 0.5 + 0.5 + snoise(o * 9.0 + 3.0) * 0.35);
          towns += smoothstep(0.82, 0.95, snoise(o * 140.0) * 0.5 + 0.5) * 0.6;
          float coast = 1.0 - smoothstep(0.07, 0.2, f);
          cityLights = land * (1.0 - ice) * (1.0 - clouds * 0.8) * towns * (0.45 + coast * 0.9) * (1.0 - dry * 0.7);
          // Auroral ovals around both poles: rippling curtains.
          float curtain = snoise(vec3(atan(o.z, o.x) * 7.0, lat * 26.0, uTime * 0.45)) * 0.5 + 0.5;
          aurora = smoothstep(0.9, 0.925, lat) * (1.0 - smoothstep(0.94, 0.97, lat)) * (0.3 + 0.7 * curtain);
        } else if (uKind == 2) {
          float turb = fbm3(o * vec3(2.0, 7.0, 2.0) + uSeed) * 0.6;
          // Eddies and festoons where neighbouring jets shear past each other, drifting
          // slowly in alternating directions band by band.
          float jet = sin(o.y * 13.0);
          vec3 ep = o * vec3(5.0, 16.0, 5.0) + vec3(uTime * 0.02 * jet, 0.0, uSeed);
          float eddy = snoise(ep + fbm3(ep * 0.7) * 1.4);
          float shearZone = 1.0 - abs(jet);
          turb += eddy * 0.32 * shearZone;
          float b1 = sin(o.y * 13.0 + turb * 3.2);
          float b2 = sin(o.y * 33.0 + turb * 5.0);
          col = mix(uA, uB, smoothstep(-0.6, 0.6, b1));
          col = mix(col, uC, smoothstep(0.3, 1.0, b2) * 0.45);
          // Fine streaks within each band, and a slightly darker, less creamy overall tone
          // so the disk keeps its detail instead of glowing white.
          float b3 = sin(o.y * 74.0 + turb * 9.0 + eddy * 1.5);
          col *= 0.9 + 0.1 * b3;
          col *= 0.8;
        } else {
          float turb = fbm3(o * vec3(1.4, 4.0, 1.4) + uSeed) * 0.4;
          float b = sin(o.y * 7.0 + turb * 2.0);
          col = mix(uA, uB, 0.5 + 0.18 * b);
          col = mix(col, uC, smoothstep(0.55, 1.0, o.y * o.y) * 0.35);
        }
        // Saturn's north-polar hexagon: a six-sided jet stream.
        if (uHex > 0.5 && o.y > 0.85) {
          float seg = 1.0471976;
          float ang = atan(o.z, o.x) + uTime * 0.015;
          float hexR = cos(seg * 0.5) / cos(mod(ang, seg) - seg * 0.5);
          float rr = length(o.xz) / 0.25;
          float inside = smoothstep(hexR + 0.06, hexR - 0.06, rr);
          float edge = exp(-(((rr - hexR) / 0.07) * ((rr - hexR) / 0.07)));
          // Over the real map only a faint trace, as in Cassini's views from afar.
          float hexK = mix(1.0, 0.25, uMapOn);
          col = mix(col, col * 0.8 + vec3(0.01, 0.03, 0.06), inside * 0.5 * hexK);
          col = mix(col, col * 1.15, edge * 0.55 * hexK);
        }
        // Great storm (Jupiter's red spot, Neptune's dark spot): an oval with a swirling rim.
        // Mapped planets already show their own storms.
        if (uSpot.w > 0.0 && uMapOn < 0.5) {
          float lat = asin(clamp(o.y, -1.0, 1.0));
          float lon = atan(o.z, o.x);
          float dl = mod(lon - uSpot.y + 3.14159, 6.28318) - 3.14159;
          vec2 q = vec2(dl * cos(lat) / (uSpot.z * 1.7), (lat - uSpot.x) / uSpot.z);
          float d = length(q) + snoise(vec3(q * 3.0, uSeed)) * 0.08;
          float core = smoothstep(1.0, 0.55, d);
          float ring = smoothstep(1.15, 0.95, d) * smoothstep(0.7, 0.92, d);
          col = mix(col, uSpotColor, core * 0.9);
          col = mix(col, mix(col, vec3(1.0, 0.95, 0.9), 0.35), ring * 0.6);
        }
        vec3 n = normalize(vNormalW);
        if (uBump > 0.0 && uMapOn > 0.5) n = bumpNormal(vPosW, n, mapH, uBump);
        vec3 L = normalize(-vPosW);
        vec3 V = normalize(cameraPosition - vPosW);
        float ndl = dot(n, L);
        float diff = smoothstep(-0.12, 0.65, ndl);
        float rim = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
        // Ring shadow: does the path to the Sun cross the (banded) ring plane?
        float ringShade = 1.0;
        if (uRingOuter > 0.0) {
          float denom = dot(L, uRingNormal);
          if (abs(denom) > 1e-4) {
            float tt = dot(uRingCenter - vPosW, uRingNormal) / denom;
            if (tt > 0.0) {
              float rn = (length(vPosW + L * tt - uRingCenter) - uRingInner) / (uRingOuter - uRingInner);
              if (rn > 0.0 && rn < 1.0) {
                float bands = 0.55 + 0.22 * sin(rn * 61.0) + 0.14 * sin(rn * 147.0 + 1.0) + 0.1 * sin(rn * 23.0);
                float cassini = smoothstep(0.6, 0.62, rn) * (1.0 - smoothstep(0.67, 0.69, rn));
                float density = bands * (1.0 - cassini * 0.92) * smoothstep(0.0, 0.05, rn) * smoothstep(1.0, 0.92, rn);
                if (uRingMapOn > 0.5) density = texture2D(uRingMap, vec2(rn, 0.5)).a;
                ringShade = 1.0 - clamp(density * 1.5, 0.0, 1.0) * 0.88;
              }
            }
          }
        }
        // Eclipses: is the path to the Sun blocked by a moon (or by the parent planet)?
        vec3 eclipse = vec3(1.0);
        if (uOccR > 0.0) {
          vec3 toO = uOccPos - vPosW;
          float tO = dot(toO, L);
          if (tO > 0.0) {
            float dO = length(toO - L * tO);
            float shade = smoothstep(uOccR * 0.55, uOccR * 1.25, dO);
            vec3 umbra = uKind == 1 ? vec3(0.06) : vec3(0.32, 0.11, 0.07);
            eclipse = mix(umbra, vec3(1.0), shade);
          }
        }
        vec3 lit = col * (0.03 + diff * 0.95 * ringShade * eclipse);
        // Everything sunlight adds on top (sheen, glint, haze) goes dark in a shadow too.
        float sunVis = dot(eclipse, vec3(0.3333)) * ringShade;
        lit += uAtmo * rim * smoothstep(-0.3, 0.5, ndl) * 0.7 * sunVis;
        // Hover / focus highlight; it barely touches the night side so city lights stay visible.
        lit += (vec3(1.0, 0.86, 0.62) * rim * 1.1 + col * 0.18 * ringShade) * uHighlight * (0.15 + 0.85 * diff);
        lit += vec3(1.0, 0.68, 0.32) * cityLights * (1.0 - smoothstep(-0.3, 0.05, ndl)) * 1.1;
        if (uKind == 1) {
          // Blue daytime haze, thicker towards the limb.
          lit += vec3(0.05, 0.11, 0.26) * diff * (0.08 + rim * 0.5) * sunVis;
          // Sun glint on open ocean and a warm twilight band along the terminator.
          float glint = max(dot(reflect(-L, n), V), 0.0);
          float openSea = oceanMask * (1.0 - cloudCover * 0.9) * step(0.0, ndl);
          lit += vec3(1.0, 0.93, 0.8) * (pow(glint, 70.0) * 1.6 + pow(glint, 9.0) * 0.12) * openSea * sunVis;
          // A broad, soft sheen on sunlit land as well (sharp on water, wide on land).
          lit += vec3(1.0, 0.94, 0.84) * pow(glint, 4.0) * 0.05 * (1.0 - oceanMask) * (1.0 - cloudCover) * step(0.0, ndl) * sunVis;
          lit += vec3(1.0, 0.42, 0.18) * exp(-((ndl / 0.12) * (ndl / 0.12))) * 0.07;
        }
        lit += mix(vec3(0.2, 1.0, 0.5), vec3(0.7, 0.3, 1.0), smoothstep(0.93, 0.965, abs(o.y))) * aurora * (1.0 - smoothstep(-0.3, -0.06, ndl)) * 0.28;
        // Lightning deep in the night-side clouds.
        if (uFlash.w > 0.001) {
          float dl = 1.0 - dot(o, normalize(uFlash.xyz));
          lit += vec3(0.75, 0.82, 1.0) * (exp(-dl * 1400.0) * 2.5 + exp(-dl * 160.0) * 0.35) * uFlash.w;
        }
        gl_FragColor = vec4(lit, uFade);
      }`,
    transparent: true,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(data.size, 64, 48), material);
  tilt.add(body);
  const atmosphere = atmo !== '#000000' ? buildAtmosphere(data, atmo) : undefined;
  if (atmosphere) pivot.add(atmosphere);

  // Invisible, generous hit target so small planets are easy to point at.
  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(data.size * 1.7, 0.75), 12, 8),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.userData.index = index;
  pivot.add(hit);

  let ring: PlanetView['ring'];
  if (data.rings) {
    const inner = data.size * 1.3;
    const outer = data.size * 2.35;
    ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 160, 1),
      new THREE.ShaderMaterial({
        uniforms: {
          uInner: { value: inner },
          uOuter: { value: outer },
          uColor: colorUniform(data.colors[2]),
          uFade: { value: 0 },
          uPlanetPos: { value: new THREE.Vector3() },
          uPlanetRadius: { value: data.size },
          uRingTex: { value: null },
          uRingTexOn: { value: 0 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vLocal;
          varying vec3 vPosW;
          varying vec3 vNormalW;
          void main() {
            vLocal = position.xy;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vPosW = w.xyz;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uInner;
          uniform float uOuter;
          uniform vec3 uColor;
          uniform float uFade;
          uniform vec3 uPlanetPos;
          uniform float uPlanetRadius;
          uniform sampler2D uRingTex;
          uniform float uRingTexOn;
          varying vec2 vLocal;
          varying vec3 vPosW;
          varying vec3 vNormalW;
          void main() {
            float r = (length(vLocal) - uInner) / (uOuter - uInner);
            float bands = 0.55 + 0.22 * sin(r * 61.0) + 0.14 * sin(r * 147.0 + 1.0) + 0.1 * sin(r * 23.0);
            float cassini = smoothstep(0.6, 0.62, r) * (1.0 - smoothstep(0.67, 0.69, r));
            float alpha = bands * (1.0 - cassini * 0.92) * smoothstep(0.0, 0.05, r) * smoothstep(1.0, 0.92, r);
            vec3 ringCol = uColor;
            if (uRingTexOn > 0.5) {
              // The real ring profile: colour and opacity across the radius.
              vec4 rt = texture2D(uRingTex, vec2(clamp(r, 0.0, 1.0), 0.5));
              ringCol = rt.rgb;
              alpha = rt.a;
              bands = 0.6;
            }
            vec3 L = normalize(-vPosW);
            float lit = 0.3 + 0.7 * abs(dot(normalize(vNormalW), L));
            // The planet's shadow falls across the rings on the side away from the Sun.
            vec3 toC = uPlanetPos - vPosW;
            float along = dot(toC, L);
            float miss = length(toC - L * along);
            float shadow = along > 0.0 ? smoothstep(uPlanetRadius * 0.9, uPlanetRadius * 1.05, miss) : 1.0;
            lit *= mix(0.08, 1.0, shadow);
            // Gaps write no depth, so depth of field sees the bands as sharp, solid matter.
            if (alpha * uFade < 0.05) discard;
            gl_FragColor = vec4(ringCol * lit * (0.75 + bands * 0.4), alpha * 0.85 * uFade);
          }`,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    tilt.add(ring);
  }

  // Orbit with a glowing trail: brightest just behind the planet, fading around the loop.
  // An open line (0..2pi) avoids interpolating the angle across the seam.
  const segments = 320;
  // Faint narrow ringlets (dusty, dark), seen best when lit from behind.
  let faintRing: PlanetView['faintRing'];
  if (data.faintRings) {
    const fr = data.faintRings;
    const inner = data.size * fr.inner;
    const outer = data.size * fr.outer;
    faintRing = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 160, 1),
      new THREE.ShaderMaterial({
        uniforms: {
          uInner: { value: inner },
          uOuter: { value: outer },
          uColor: colorUniform(fr.color),
          uOpacity: { value: fr.opacity },
          uFade: { value: 0 },
          uSeed: { value: index * 3.7 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vLocal;
          varying vec3 vPosW;
          void main() {
            vLocal = position.xy;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vPosW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uInner;
          uniform float uOuter;
          uniform vec3 uColor;
          uniform float uOpacity;
          uniform float uFade;
          uniform float uSeed;
          varying vec2 vLocal;
          varying vec3 vPosW;
          void main() {
            float r = (length(vLocal) - uInner) / (uOuter - uInner);
            float lines = 0.0;
            for (int i = 0; i < 5; i++) {
              float c = fract(sin(float(i) * 12.9 + uSeed) * 437.5) * 0.9 + 0.05;
              float w = 0.008 + 0.012 * fract(sin(float(i) * 7.1 + uSeed) * 91.3);
              lines += exp(-(((r - c) / w) * ((r - c) / w)));
            }
            float haze = smoothstep(0.0, 0.2, r) * smoothstep(1.0, 0.7, r) * 0.18;
            float a = (lines + haze) * uOpacity * uFade;
            // Only the ringlets themselves write depth, so they stay sharp under depth of field.
            if (a < 0.05) discard;
            gl_FragColor = vec4(uColor, a);
          }`,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );
    faintRing.rotation.x = -Math.PI / 2;
    tilt.add(faintRing);
  }

  const pts: number[] = [];
  const angles: number[] = [];
  for (let k = 0; k <= segments; k++) {
    const a2 = (k / segments) * Math.PI * 2;
    pts.push(Math.cos(a2) * data.orbit, 0, -Math.sin(a2) * data.orbit);
    angles.push(a2);
  }
  const orbitGeometry = new THREE.BufferGeometry();
  orbitGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  orbitGeometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angles, 1));
  const orbit = new THREE.Line(
    orbitGeometry,
    new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uPlanetAngle: { value: 0 },
        uTint: { value: new THREE.Color(data.colors[0]).lerp(new THREE.Color('#ffffff'), 0.35) },
        uPlanetPos: { value: new THREE.Vector3() },
        uPlanetR: { value: data.size },
      },
      vertexShader: /* glsl */ `
        attribute float aAngle;
        varying float vAngle;
        varying vec3 vWorld;
        void main() {
          vAngle = aAngle;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uPlanetAngle;
        uniform vec3 uTint;
        uniform vec3 uPlanetPos;
        uniform float uPlanetR;
        varying float vAngle;
        varying vec3 vWorld;
        void main() {
          float behind = mod(uPlanetAngle - vAngle, 6.2831853);
          float trail = exp(-behind * 1.5);
          vec3 col = mix(vec3(0.6, 0.66, 0.86), uTint, trail);
          float a = clamp(uOpacity * (0.38 + 2.4 * trail), 0.0, 1.0);
          // The line runs through the planet's centre: let it fade out around the body,
          // and right in front of the camera, so a close-up shows no hairline across it.
          a *= smoothstep(uPlanetR * 1.3, uPlanetR * 7.0, distance(vWorld, uPlanetPos));
          a *= smoothstep(uPlanetR * 2.0, uPlanetR * 9.0, distance(vWorld, cameraPosition));
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true,
      depthWrite: false,
    }),
  );
  // Inclined orbits (dwarf planets) live in their own tilted plane.
  const plane = new THREE.Group();
  plane.rotation.set(THREE.MathUtils.degToRad(data.inclination ?? 0), data.node ?? 0, 0, 'YXZ');
  plane.add(orbit, pivot);
  group.add(plane);
  return { data, pivot, tilt, body, hit, orbit, highlight: 0, ring, faintRing, atmosphere };
}
