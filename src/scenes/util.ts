import * as THREE from 'three';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, colorUniform, globalUniforms } from '../shaders/common';

/** Camera-facing additive glow quad (star cores, flashes, corona). */
export class Glow extends THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  constructor(color: string, size: number, falloff = 2.2) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: colorUniform(color),
        uIntensity: { value: 1 },
        uFalloff: { value: falloff },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uFalloff;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float core = exp(-d * d * 60.0) * 2.0;
          float halo = pow(max(1.0 - d, 0.0), uFalloff);
          float a = (core + halo) * uIntensity;
          gl_FragColor = vec4(uColor * a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    super(new THREE.PlaneGeometry(size, size), material);
    this.frustumCulled = false;
  }

  set intensity(v: number) {
    this.material.uniforms.uIntensity.value = v;
    this.visible = v > 0.001;
  }

  get intensity(): number {
    return this.material.uniforms.uIntensity.value;
  }

  face(camera: THREE.Camera): void {
    this.quaternion.copy(camera.quaternion);
  }
}

/** Distant background stars on a sphere shell, with gentle twinkle. */
export function createStarfield(count: number, radius: number, seed = 1) {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const positions = new Float32Array(count * 3);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = radius * (0.85 + rand() * 0.3);
    const q = Math.sqrt(1 - u * u);
    positions[i * 3] = q * Math.cos(phi) * r;
    positions[i * 3 + 1] = u * r;
    positions[i * 3 + 2] = q * Math.sin(phi) * r;
    data[i * 4] = rand() ** 4; // size bias: few bright stars
    data[i * 4 + 1] = rand(); // warm/cool
    data[i * 4 + 2] = rand() * 6.283; // twinkle phase
    data[i * 4 + 3] = 0.3 + rand() * 0.7; // brightness
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));

  const material = additiveMaterial(
    /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      uniform float uOpacity;
      uniform float uSizeScale;
      attribute vec4 aData;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = 0.75 + 0.25 * sin(uTime * (0.6 + aData.w * 1.8) + aData.z);
        vAlpha = uOpacity * aData.w * tw;
        vColor = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), aData.y) * (0.8 + aData.x * 2.2);
        float size = (0.0018 + aData.x * 0.0045) * length(position) * uSizeScale;
        gl_PointSize = pointSize(size, -mv.z, vAlpha);
        gl_Position = projectionMatrix * mv;
      }`,
    POINT_FRAG,
    {
      uTime: globalUniforms.uTime,
      uOpacity: { value: 1 },
      uSizeScale: { value: 1 },
    },
  );
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -5;
  return points;
}

/**
 * A deep field: thousands of faint, far galaxies on a sphere round the camera, as in the
 * Hubble Deep Field — red-gold ellipticals, spirals with a warm core in a bluish disk (some
 * edge-on, as thin streaks), and blue, lumpy irregulars; the farthest smaller and redder.
 * Each point sprite draws its galaxy's own shape, turned and squashed at random.
 */
export function createDeepField(count: number, radius: number, seed = 1) {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const positions = new Float32Array(count * 3);
  const shape = new Float32Array(count * 4);
  const look = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const q = Math.sqrt(1 - u * u);
    positions.set([q * Math.cos(phi) * radius, u * radius, q * Math.sin(phi) * radius], i * 3);
    const kind = rand(); // < 0.3 elliptical, < 0.82 spiral, else irregular
    const far = rand() ** 0.6; // farther: smaller, fainter, redder
    // Type, angle on the sky, axis ratio (spirals often seen tilted, sometimes edge-on), size.
    const ratio = kind < 0.3 ? 0.55 + rand() * 0.45 : kind < 0.82 ? 0.12 + rand() * 0.88 : 0.45 + rand() * 0.5;
    shape.set([kind, rand() * Math.PI, ratio, (1 - far * 0.75) * (0.4 + rand() ** 3 * 1.6)], i * 4);
    look.set([far, rand()], i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aShape', new THREE.BufferAttribute(shape, 4));
  geometry.setAttribute('aLook', new THREE.BufferAttribute(look, 2));
  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 1 }, uViewScale: globalUniforms.uViewScale },
    vertexShader: /* glsl */ `
      ${POINT_SIZE}
      uniform float uOpacity;
      attribute vec4 aShape;
      attribute vec2 aLook;
      varying vec4 vShape;
      varying vec2 vLook;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vShape = aShape;
        vLook = aLook;
        vAlpha = uOpacity * (1.0 - aLook.x * 0.6);
        float size = (0.009 + aShape.w * 0.022) * length(position);
        gl_PointSize = max(pointSize(size, -mv.z, vAlpha), 3.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vShape;
      varying vec2 vLook;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float ca = cos(vShape.y), sa = sin(vShape.y);
        c = vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y);
        c.y /= max(vShape.z, 0.08);
        float r = length(c);
        if (r > 1.0) discard;
        float kind = vShape.x;
        vec3 warm = vec3(1.0, 0.78, 0.55);
        vec3 col;
        float a;
        if (kind < 0.3) {
          // Elliptical: a smooth glow, brightest in the middle.
          a = exp(-r * r * 9.0) * 0.6;
          col = warm;
        } else if (kind < 0.82) {
          // Spiral: a warm bulge in a bluish disk with a hint of two arms.
          float th = atan(c.y, c.x);
          float arms = 0.65 + 0.35 * cos(2.0 * th - 6.0 * log(r + 0.05) + vLook.y * 6.28);
          float disk = exp(-r * 3.4) * arms;
          float bulge = exp(-r * r * 40.0);
          a = disk * 0.8 + bulge;
          col = mix(vec3(0.62, 0.74, 1.0), warm, bulge / (a + 1e-3));
        } else {
          // Irregular: blue, a few clumps of young stars scattered off-centre.
          float k = vLook.y * 6.283;
          vec2 o1 = 0.35 * vec2(cos(k), sin(k));
          vec2 o2 = 0.4 * vec2(cos(k * 2.3 + 2.0), sin(k * 1.7 + 1.0));
          a = exp(-dot(c - o1, c - o1) * 7.0) + 0.7 * exp(-dot(c - o2, c - o2) * 12.0) + 0.35 * exp(-r * r * 3.0);
          a *= 0.8;
          col = vec3(0.58, 0.72, 1.0);
        }
        // The far ones redshifted.
        col = mix(col, col * vec3(1.15, 0.75, 0.55), vLook.x * 0.8);
        gl_FragColor = vec4(col * a * vAlpha * 1.4, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -6;
  return points;
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = THREE.MathUtils.lerp;

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

/**
 * The Milky Way seen from inside: a faint band with a bright bulge and a dark dust
 * rift. Baked once into an equirectangular texture, then drawn on a sky sphere.
 */
/**
 * Galactic frame in the Solar System's coordinates: the Galaxy's plane is tilted 60° to the
 * planets' orbits, and the Sun's motion (towards Cygnus, l = 90°) lies in it along the same
 * direction «Політ» uses. x: towards the galactic centre, y: l = 90°, n: north galactic pole.
 */
export const GALACTIC = (() => {
  const y = new THREE.Vector3(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3), 0);
  const n = new THREE.Vector3(-Math.sin(Math.PI / 3), Math.cos(Math.PI / 3), 0);
  return { x: new THREE.Vector3().crossVectors(y, n), y, n };
})();

/** The photographic sky panorama once loaded (shared with scenes that lens it). */
export const SKY: { photo: THREE.Texture | null } = { photo: null };

/** Equatorial J2000 (RA, Dec in degrees) to a unit direction in the scene, via galactic coordinates. */
export function equatorialToScene(raDeg: number, decDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ra = THREE.MathUtils.degToRad(raDeg);
  const dec = THREE.MathUtils.degToRad(decDeg);
  const e = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  // IAU J2000 equatorial → galactic rotation.
  const gx = -0.0548755604 * e[0] - 0.8734370902 * e[1] - 0.4838350155 * e[2];
  const gy = 0.4941094279 * e[0] - 0.44482963 * e[1] + 0.7469822445 * e[2];
  const gz = -0.867666149 * e[0] - 0.1980763734 * e[1] + 0.4559837762 * e[2];
  return out.set(0, 0, 0).addScaledVector(GALACTIC.x, gx).addScaledVector(GALACTIC.y, gy).addScaledVector(GALACTIC.n, gz);
}

export function createMilkyWay(renderer: THREE.WebGLRenderer, radius = 280) {
  const target = new THREE.WebGLRenderTarget(2048, 1024, { type: THREE.HalfFloatType });
  const bakeScene = new THREE.Scene();
  const bakeMaterial = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      varying vec2 vUv;
      void main() {
        float lon = (vUv.x - 0.5) * 6.2831853;
        float lat = (vUv.y - 0.5) * 3.1415927;
        vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
        vec3 pole = normalize(vec3(0.35, 1.0, 0.2));
        vec3 gc = normalize(vec3(-0.8, 0.0, -0.6));
        gc = normalize(gc - pole * dot(gc, pole));
        float b = dot(d, pole);                       // galactic latitude
        float l = dot(d, gc);                         // towards the centre
        float width = 0.1 + 0.07 * smoothstep(0.2, 1.0, l);
        float band = exp(-((b / width) * (b / width)));
        float bulge = exp(-((b / 0.16) * (b / 0.16))) * pow(max(l, 0.0), 7.0);
        float clouds = fbm5(d * 5.0) * 0.5 + 0.5;
        float grain = snoise(d * 60.0) * 0.5 + 0.5;
        float rift = smoothstep(0.5, 0.78, fbm3(d * 8.0 + 3.1) * 0.5 + 0.5) * exp(-((b / 0.045) * (b / 0.045)));
        float I = (band * (0.45 + 0.8 * clouds) * (0.75 + 0.5 * grain) + bulge * 0.9) * (1.0 - rift * 0.85);
        vec3 col = mix(vec3(0.5, 0.58, 0.86), vec3(1.0, 0.84, 0.64), clamp(bulge * 2.5 + l * 0.25, 0.0, 1.0));
        gl_FragColor = vec4(col * I, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
  bakeScene.add(quad);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.setRenderTarget(prev);
  quad.geometry.dispose();
  bakeMaterial.dispose();

  // Galactic frame in the Solar System's coordinates: the Galaxy's plane is tilted 60° to
  // the planets' orbits, and the Sun's motion (towards Cygnus, l = 90°) lies in that plane
  // along the same direction as «Політ» uses. X: towards the galactic centre, N: north pole.
  const { x: galX, y: galY, n: galN } = GALACTIC;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: target.texture },
      uOpacity: { value: 0.1 },
      uPhoto: { value: null as THREE.Texture | null },
      uPhotoOn: { value: 0 },
      uGain: { value: 12 },
      uGalX: { value: galX },
      uGalY: { value: galY },
      uGalN: { value: galN },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform sampler2D uPhoto;
      uniform float uPhotoOn;
      uniform float uGain;
      uniform float uOpacity;
      uniform vec3 uGalX;
      uniform vec3 uGalY;
      uniform vec3 uGalN;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col;
        if (uPhotoOn > 0.5) {
          // The real sky (Solar System Scope panorama, galactic coordinates: the centre of
          // the Galaxy in the middle, longitude growing to the left, north at the bottom of
          // the image; checked by matching the bright stars of the catalogue to the photo).
          float l = atan(dot(d, uGalY), dot(d, uGalX));
          float b = asin(clamp(dot(d, uGalN), -1.0, 1.0));
          vec2 uv = vec2(fract(0.5 - l / 6.2831853), 0.5 - b / 3.1415927);
          vec3 sky = texture2D(uPhoto, uv).rgb;
          // The photo is very dark: lift the faint band, but subtract the floor first so the
          // empty sky stays black.
          col = max(sky - 0.006, 0.0) * uGain;
        } else {
          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
          col = texture2D(uMap, uv).rgb;
        }
        gl_FragColor = vec4(col * uOpacity, 1.0);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -6;

  // Swap the procedural band for the photographic panorama once it has arrived (4K WebP,
  // made from the 8K original: plenty for a backdrop, decoded off the main thread).
  let photo: THREE.Texture | null = null;
  void (async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}textures/sky/milky_way_4k.webp`);
      if (!res.ok) return;
      const bitmap = await createImageBitmap(await res.blob(), { resizeWidth: 4096, resizeHeight: 2048, resizeQuality: 'high', imageOrientation: 'flipY' });
      photo = new THREE.Texture(bitmap as unknown as HTMLImageElement);
      photo.flipY = false;
      photo.wrapS = THREE.RepeatWrapping;
      photo.colorSpace = THREE.NoColorSpace;
      photo.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      photo.needsUpdate = true;
      material.uniforms.uPhoto.value = photo;
      SKY.photo = photo;
      material.uniforms.uPhotoOn.value = 1;
    } catch (err) {
      console.warn('Milky Way panorama failed to load; keeping the procedural band.', err);
    }
  })();
  return {
    mesh,
    set opacity(v: number) {
      material.uniforms.uOpacity.value = v;
      mesh.visible = v > 0.001;
    },
    dispose: () => {
      target.dispose();
      photo?.dispose();
    },
  };
}
