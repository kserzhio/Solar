import * as THREE from 'three';
import { gsap } from 'gsap';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { config } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, colorUniform, gaussian, globalUniforms, mulberry32 } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import { ASTEROID_BELT, DWARFS, KUIPER_BELT, OVERVIEW, PLANETS, SUN_RADIUS, planetAngle, type Planet } from '../data/planets';
import { createMilkyWay, createStarfield, disposeObject, lerp } from './util';
import { Comet } from './Comet';
import { SunNoiseCube, createSunStrands } from './sunFx';
import { GalacticDrift } from './galacticDrift';

const KIND_INDEX = { rocky: 0, earth: 1, gas: 2, ice: 3 } as const;
const ORBIT_OPACITY = { base: 0.13, hover: 0.42, focus: 0.3 };
const OVERVIEW_LIMITS = { min: 9, max: 95 };
/** Seconds without input before the camera starts drifting around on its own. */
const IDLE_AFTER = 7;
/** Seconds without any input before the guided tour starts by itself. */
const TOUR_AFTER = 45;
/** Seconds the tour lingers on each planet (after the flight there). */
const TOUR_HOLD = 6.5;
/** Size comparison: world units per Earth radius, and the Sun's true diameter. */
const LINEUP_EARTH = 0.55;
/** Colour maps per body (public/textures/planets). Pluto has none and stays procedural. */
const PLANET_MAPS: Record<string, string> = {
  mercury: 'mercury.jpg', venus: 'venus.jpg', mars: 'mars.jpg', jupiter: 'jupiter.jpg', saturn: 'saturn.jpg',
  uranus: 'uranus.jpg', neptune: 'neptune.jpg', ceres: 'ceres.jpg', eris: 'eris.jpg',
};
const MOON_MAPS: Record<string, string> = { 'Місяць': 'moon.jpg' };
/** How cratered each rocky body looks (0 = smooth). */
const CRATERS: Record<string, number> = { mercury: 1, mars: 0.3, ceres: 0.8, pluto: 0.2, eris: 0.3 };
const MOON_CRATERS: Record<string, number> = { 'Місяць': 1, 'Іо': 0, 'Європа': 0.12, 'Ганімед': 0.55, 'Каллісто': 1, 'Титан': 0 };
/** Sunspots modelled on the Sun's surface (fixed array size for the shader). */
const SUN_SPOTS = 12;
const SUN_DIAMETER_KM = 1_392_700;
/** Sun's galactic speed relative to Earth's orbital speed in the «Політ» animation (real: ~7.7). */
const DRIFT_SPEED_RATIO = 1.6;

export interface CompareLabel {
  pos: THREE.Vector3;
  text: string;
  sub: string;
}

interface PlanetView {
  data: Planet;
  pivot: THREE.Object3D;
  tilt: THREE.Object3D;
  body: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  hit: THREE.Mesh;
  orbit: THREE.Line<THREE.BufferGeometry, THREE.ShaderMaterial>;
  highlight: number;
  ring?: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  faintRing?: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  atmosphere?: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
}

const PLANET_VERT = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vSunObj;
  void main() {
    vObj = normalize(position);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vPosW = w.xyz;
    // Direction to the Sun (at the origin) in the body's own frame, for cloud shadows.
    vSunObj = transpose(mat3(modelMatrix)) * -w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/**
 * Scene 5: the interactive Solar System. Orbits keep turning; hover shows a name,
 * click flies the camera to a planet and opens its card.
 */
export class Solar implements SceneModule {
  readonly name = 'solar' as const;
  readonly group = new THREE.Group();
  active = false;

  /** intro 0..1 is driven by the timeline while the disk hands over to real planets. */
  params = { intro: 0 };
  orbitSpeed = 1;

  onHover: (planet: Planet | null) => void = () => {};
  onFocus: (planet: Planet | null) => void = () => {};

  hoveredIndex = -1;
  focusedIndex = -1;

  private planets: PlanetView[] = [];
  private moons: { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>; distance: number; speed: number; phase: number; name: string; parent: number }[] = [];
  private lightning = { timer: 2, w: 0, second: -1 };
  private ioPlumes?: THREE.ShaderMaterial;
  private sun: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** Sunspot groups (leading spot first), in the Sun's rotating frame. */
  private spotGroups: THREE.Vector3[][] = [];
  /** Coronal loops arching over the active regions; turns with the Sun. */
  private loops = new THREE.Group();
  private loopIntensity = { value: 0 };
  private loopSunR = { value: SUN_RADIUS };
  /** Boiling plasma baked each frame into a cube map, read by the Sun's surface shader. */
  private noiseCube = new SunNoiseCube();
  /** «Політ крізь Галактику»: helical trails of the planets behind the moving Sun. */
  private drift!: GalacticDrift;
  private driftBodies: THREE.Vector3[] = [];
  private driftPose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private driftTween?: gsap.core.Tween;
  onDrift: (on: boolean) => void = () => {};
  private corona: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private milkyWay: ReturnType<typeof createMilkyWay>;
  private comet = new Comet();
  /** Solar flare scheduler: seconds since the last flare and until the next one. */
  private flare = { age: 99, next: 5, dir: new THREE.Vector3(1, 0, 0) };
  private idle = 0;
  private belt: THREE.ShaderMaterial;
  private kuiper!: THREE.ShaderMaterial;
  private wind!: THREE.ShaderMaterial;
  private unregisterExtra: (() => void)[] = [];
  private rocks!: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
  private rockData: { r: number; a: number; y: number; size: number; spin: THREE.Vector3; spinSpeed: number }[] = [];
  private starfield = createStarfield(6000, 300, 21);
  private controls: OrbitControls;
  /** Sky (stars + Milky Way band) lives outside the scaled system group. */
  private sky = new THREE.Group();
  /** Set by the cosmic zoom: 1 = normal, smaller = the system shrinks towards a point. */
  private zoomScale = 1;
  /** Sky visibility while zooming out (0 once we have left the galaxy). */
  skyFade = 1;
  private wpos = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private unregister: () => void;

  private interactive = false;
  private focus = { t: 1, following: false };
  private focusFrom = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private focusOffset = new THREE.Vector3();
  /** Sideways push applied mid-flight so the camera arcs around the Sun, not through it. */
  private flightBump = new THREE.Vector3();
  private lastPlanetPos = new THREE.Vector3();
  private overviewPose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private focusTween?: gsap.core.Tween;
  /** Guided tour: flies from planet to planet with each card open. */
  private tour = { on: false, index: -1, t: 0, auto: false };
  onTour: (on: boolean) => void = () => {};
  private downAt = { x: 0, y: 0, t: 0 };
  private tmp = new THREE.Vector3();
  private ringQuat = new THREE.Quaternion();
  /** Eases depth of field in and out with planet focus. */
  private dofAmount = 0;
  private dofIndex = 0;
  /**
   * Size comparison: copies of the Sun and the eight planets at their true relative
   * sizes, lined up away from the Sun (which sits at the origin, so lighting stays right).
   */
  private lineup = new THREE.Group();
  private lineupBodies: THREE.Mesh[] = [];
  private comparePose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  readonly compareLabels: CompareLabel[] = [];
  private compareCenter = new THREE.Vector3();

  constructor(private ctx: Ctx) {
    this.sun = this.buildSun();
    this.buildLoops();
    this.corona = this.buildCorona();
    this.milkyWay = createMilkyWay(ctx.renderer);
    this.sky.add(this.milkyWay.mesh, this.starfield);
    this.group.add(this.sun, this.corona, this.comet.group);
    [...PLANETS, ...DWARFS].forEach((p, i) => this.planets.push(this.buildPlanet(p, i)));
    this.buildKuiperBelt();
    this.buildSolarWind();
    this.buildMoons();
    this.buildDrift();
    this.loadEarthTextures();
    this.loadPlanetTextures();
    this.buildLineup();
    const belt = this.buildBelt();
    this.belt = belt.material;
    this.unregister = ctx.quality.register(belt.geometry, belt.count);

    this.controls = new OrbitControls(ctx.camera, ctx.canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.7;
    this.controls.minDistance = OVERVIEW_LIMITS.min;
    this.controls.maxDistance = OVERVIEW_LIMITS.max;
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = Math.PI - 0.08;
  }

  // ---------------------------------------------------------------- build

  private buildSun() {
    // Sunspot groups in the two activity belts (±8–30° latitude): a leading and a trailing
    // spot per group, plus a few loners. xyz = direction on the unrotated Sun, w = radius.
    const rand = mulberry32(1859);
    const spots: THREE.Vector4[] = [];
    this.spotGroups = [];
    const groups = [
      { lat: 14, lon: 20 }, { lat: -11, lon: 95 }, { lat: 22, lon: 170 }, { lat: -19, lon: 250 }, { lat: 9, lon: 305 },
    ];
    for (const g of groups) {
      const n = 2 + Math.floor(rand() * 2);
      const members: THREE.Vector3[] = [];
      this.spotGroups.push(members);
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
        uPerlin: { value: this.noiseCube.texture },
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
    return new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 128, 96), material);
  }

  /**
   * Coronal loops: magnetic arches of hot plasma rooted in the sunspot groups. Real tube
   * geometry, so they stand above the surface in 3D and show in profile at the limb;
   * bright knots of plasma stream along them from one footpoint to the other.
   */
  private buildLoops(): void {
    const rand = mulberry32(2024);
    const shared = { uTime: globalUniforms.uTime, uIntensity: this.loopIntensity, uSunR: this.loopSunR };
    const slerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => {
      const w = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      if (w < 1e-5) return a.clone();
      return a.clone().multiplyScalar(Math.sin((1 - t) * w) / Math.sin(w)).addScaledVector(b, Math.sin(t * w) / Math.sin(w));
    };
    for (const g of this.spotGroups) {
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
        this.loops.add(new THREE.Mesh(geo, mat));
      }
    }
    this.sun.add(this.loops);
    this.loops.add(
      createSunStrands({
        radius: SUN_RADIUS,
        groups: this.spotGroups,
        count: Math.round(1400 * Math.max(0.5, config.particleScale)),
        uTime: globalUniforms.uTime,
        intensity: this.loopIntensity,
        sunR: this.loopSunR,
      }),
    );
  }

  private buildCorona() {
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

  private buildPlanet(data: Planet, index: number): PlanetView {
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
        vec4 eqTex(sampler2D t, vec3 d) {
          vec2 uv = eqUV(d);
          vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
          vec2 dx = dFdx(uv);
          vec2 dy = dFdy(uv);
          vec2 dx2 = dFdx(uv2);
          vec2 dy2 = dFdy(uv2);
          if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
          return textureGrad(t, uv, dx, dy);
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
          if (uMapOn > 0.5) {
            vec3 mo = o;
            if (uKind >= 2) {
              // Gas and ice giants, and Venus's cloud deck: neighbouring bands sway past each
              // other and churn gently through the flow field, all from one still map.
              float jet = sin(o.y * 13.0);
              float a = jet * 0.05 * sin(uTime * 0.03 + uSeed);
              mo = vec3(o.x * cos(a) - o.z * sin(a), o.y, o.x * sin(a) + o.z * cos(a));
              mo = normalize(mo + flowSine(mo * vec3(9.0, 22.0, 9.0), uTime * 0.18 + uSeed) * 0.0025);
            }
            col = eqTex(uMap, mo).rgb;
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
          lit += uAtmo * rim * smoothstep(-0.3, 0.5, ndl) * 0.7;
          // Hover / focus highlight; it barely touches the night side so city lights stay visible.
          lit += (vec3(1.0, 0.86, 0.62) * rim * 1.1 + col * 0.18 * ringShade) * uHighlight * (0.15 + 0.85 * diff);
          lit += vec3(1.0, 0.68, 0.32) * cityLights * (1.0 - smoothstep(-0.3, 0.05, ndl)) * 1.1;
          if (uKind == 1) {
            // Blue daytime haze, thicker towards the limb.
            lit += vec3(0.05, 0.11, 0.26) * diff * (0.2 + rim * 1.2);
            // Sun glint on open ocean and a warm twilight band along the terminator.
            float glint = max(dot(reflect(-L, n), V), 0.0);
            float openSea = oceanMask * (1.0 - cloudCover * 0.9) * step(0.0, ndl);
            lit += vec3(1.0, 0.93, 0.8) * (pow(glint, 70.0) * 1.6 + pow(glint, 9.0) * 0.12) * openSea;
            // A broad, soft sheen on sunlit land as well (sharp on water, wide on land).
            lit += vec3(1.0, 0.94, 0.84) * pow(glint, 4.0) * 0.05 * (1.0 - oceanMask) * (1.0 - cloudCover) * step(0.0, ndl);
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
    const atmosphere = atmo !== '#000000' ? this.buildAtmosphere(data, atmo) : undefined;
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
    this.group.add(plane);
    return { data, pivot, tilt, body, hit, orbit, highlight: 0, ring, faintRing, atmosphere };
  }

  /** Moons: small rocky bodies orbiting in their planet's equatorial plane. */
  private buildMoons(): void {
    const template = this.planets[0].body.material;
    this.planets.forEach((p, pi) => {
      p.data.satellites?.forEach((m, mi) => {
        const material = template.clone();
        const u = material.uniforms;
        const base = new THREE.Color(m.color);
        u.uKind.value = KIND_INDEX.rocky;
        u.uA.value = base;
        u.uB.value = base.clone().multiplyScalar(0.55);
        u.uC.value = base.clone().lerp(new THREE.Color('#ffffff'), 0.3);
        u.uAtmo.value = new THREE.Color('#000000');
        u.uSeed.value = 50 + pi * 7.1 + mi * 3.3;
        u.uHighlight.value = 0;
        u.uSpot.value = new THREE.Vector4(0, 0, 0, 0);
        u.uCraters.value = MOON_CRATERS[m.name] ?? 0.6;
        u.uPolarCap.value = 0;
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(m.radius, 48, 32), material);
        p.tilt.add(mesh);
        this.moons.push({ mesh, distance: m.distance, speed: m.speed, phase: m.phase, name: m.name, parent: pi });
        if (m.name === 'Іо') this.ioPlumes = this.buildPlumes(mesh, m.radius);
      });
    });
  }

  /**
   * Atmospheric halo: for each pixel, find how close the view ray passes to the planet
   * and glow in a thin shell just outside the surface, brighter on the day side.
   */
  private buildAtmosphere(data: Planet, color: string) {
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

  /** Io's volcanic plumes: umbrella-shaped fountains of sulphur rising and falling. */
  private buildPlumes(io: THREE.Mesh, radius: number): THREE.ShaderMaterial {
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

  private occluderWorld = new THREE.Vector3();
  private bodyQuat = new THREE.Quaternion();

  /** Feeds eclipse occluders and Jupiter's lightning to the planet shaders. */
  private updateEclipsesAndStorms(dt: number): void {
    const byName = (n: string) => this.moons.find((m) => m.name === n);
    const set = (mat: THREE.ShaderMaterial, pos: THREE.Vector3, r: number) => {
      mat.uniforms.uOccPos.value.copy(pos);
      mat.uniforms.uOccR.value = r;
    };
    const earth = this.planets.find((p) => p.data.id === 'earth')!;
    const jupiter = this.planets.find((p) => p.data.id === 'jupiter')!;
    const moon = byName('Місяць');
    const io = byName('Іо');
    const ws = this.zoomScale;
    if (moon) {
      set(earth.body.material, moon.mesh.getWorldPosition(this.occluderWorld), moon.mesh.geometry.parameters.radius * ws);
    }
    if (io) set(jupiter.body.material, io.mesh.getWorldPosition(this.occluderWorld), io.mesh.geometry.parameters.radius * ws);
    // Every moon can fall into its planet's shadow.
    for (const m of this.moons) {
      const parent = this.planets[m.parent];
      set(m.mesh.material, parent.pivot.getWorldPosition(this.occluderWorld), parent.data.size * ws);
    }
    if (this.ioPlumes) this.ioPlumes.uniforms.uFade.value = this.params.intro;

    // Jupiter lightning: sudden double flashes at random points on the night side.
    const l = this.lightning;
    const f = jupiter.body.material.uniforms.uFlash.value as THREE.Vector4;
    l.timer -= dt;
    if (l.timer <= 0) {
      l.timer = 0.4 + Math.random() * 1.6;
      l.w = 1;
      l.second = 0.07 + Math.random() * 0.08;
      const night = jupiter.pivot.position.clone().normalize();
      night.add(new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.5) * 0.8, Math.random() - 0.5).multiplyScalar(1.3)).normalize();
      jupiter.body.getWorldQuaternion(this.bodyQuat).invert();
      night.applyQuaternion(this.bodyQuat);
      f.set(night.x, night.y, night.z, 1);
    }
    if (l.second > 0) {
      l.second -= dt;
      if (l.second <= 0) l.w = 0.8;
    }
    l.w = Math.min(1, l.w * Math.exp(-Math.max(dt, 0) * 16));
    f.w = l.w;
  }

  /** The Kuiper belt: a broad, faint, icy ring beyond Neptune. */
  private buildKuiperBelt(): void {
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
    this.kuiper = additiveMaterial(
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
    const points = new THREE.Points(geometry, this.kuiper);
    points.frustumCulled = false;
    this.group.add(points);
    this.unregisterExtra.push(this.ctx.quality.register(geometry, count));
  }

  /** Solar wind: a thin, ceaseless outflow of particles from the Sun. */
  private buildSolarWind(): void {
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
    this.wind = additiveMaterial(
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
    const points = new THREE.Points(geometry, this.wind);
    points.frustumCulled = false;
    this.group.add(points);
  }

  /**
   * The main asteroid belt as it really is: a thick, sparse torus of dark rock (orbits tilted
   * up to ~20°), densest near 2.7 AU, with Kirkwood gaps cleared by Jupiter's resonances,
   * plus the two Trojan swarms that share Jupiter's orbit 60° ahead of and behind it.
   * Each speck is lit by the Sun: bright when the Sun is behind the viewer, faint against it.
   */
  private buildBelt() {
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
    this.group.add(points);
    this.buildRocks();
    return { material, geometry, count };
  }

  /** A few dozen large, irregular, sunlit asteroids among the dust. */
  private buildRocks(): void {
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
    this.rocks = new THREE.InstancedMesh(geo, material, count);
    this.rocks.frustumCulled = false;
    this.rockData = Array.from({ length: count }, () => ({
      r: lerp(ASTEROID_BELT.inner, ASTEROID_BELT.outer, rand()),
      a: rand() * Math.PI * 2,
      y: (rand() - 0.5) * 1.6,
      size: 0.05 + Math.pow(rand(), 3) * 0.14,
      spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      spinSpeed: 0.2 + rand() * 0.8,
    }));
    this.group.add(this.rocks);
  }

  private rockMatrix = new THREE.Matrix4();
  private rockQuat = new THREE.Quaternion();
  private rockPos = new THREE.Vector3();
  private rockScale = new THREE.Vector3();

  private updateRocks(clock: number, time: number, fade: number): void {
    this.rockData.forEach((d, i) => {
      const ang = d.a + clock * 0.16 * Math.pow(7.7 / d.r, 1.5);
      this.rockPos.set(Math.cos(ang) * d.r, d.y, -Math.sin(ang) * d.r);
      this.rockQuat.setFromAxisAngle(d.spin, time * d.spinSpeed);
      this.rockScale.setScalar(d.size);
      this.rockMatrix.compose(this.rockPos, this.rockQuat, this.rockScale);
      this.rocks.setMatrixAt(i, this.rockMatrix);
    });
    this.rocks.instanceMatrix.needsUpdate = true;
    this.rocks.material.uniforms.uFade.value = fade;
  }

  // ---------------------------------------------------------------- lifecycle

  enter(): void {
    this.params.intro = 0;
    this.interactive = false;
    this.focusedIndex = -1;
    this.hoveredIndex = -1;
    this.overviewPose = null;
    this.focus = { t: 1, following: false };
    this.controls.enabled = false;
    this.controls.minDistance = OVERVIEW_LIMITS.min;
    this.controls.maxDistance = OVERVIEW_LIMITS.max;
    this.ctx.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.ctx.canvas.addEventListener('pointerup', this.onPointerUp);
    this.ctx.canvas.addEventListener('wheel', this.onActivity, { passive: true });
    this.ctx.canvas.addEventListener('pointermove', this.onActivity);
    this.idle = 0;
    this.ctx.scene.add(this.sky);
    this.setZoom(1);
    this.skyFade = 1;
    this.comet.reset(7);
    this.comet.onPerihelion = (x) => this.ctx.audio.cometPass(x);
  }

  /** Called when the cinematic is over (or skipped): hands the camera to the user. */
  /** Cosmic zoom hook: shrinks the whole system around the Sun. */
  setZoom(scale: number): void {
    this.zoomScale = scale;
    this.group.scale.setScalar(scale);
    this.group.visible = scale > 0.0015;
  }

  get zoomed(): boolean {
    return this.zoomScale < 0.999;
  }

  get orbitControls(): OrbitControls {
    return this.controls;
  }

  get isInteractive(): boolean {
    return this.interactive;
  }

  makeInteractive(snapCamera: boolean): void {
    this.params.intro = 1;
    this.interactive = true;
    const cam = this.ctx.camera;
    if (snapCamera) {
      const { distance: d, elevation: el, azimuth: az } = OVERVIEW;
      cam.position.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
    }
    this.controls.target.set(0, 0, 0);
    this.controls.enabled = true;
    this.controls.update();
  }

  update(dt: number): void {
    const intro = this.params.intro;
    const ease = intro * intro * (3 - 2 * intro);
    const cam = this.ctx.camera;

    if (this.interactive) this.ctx.orbitClock.t += dt * this.orbitSpeed;
    const clock = this.ctx.orbitClock.t;

    this.sun.material.uniforms.uFade.value = ease;
    if ((this.group.visible && ease > 0) || this.comparing) this.noiseCube.update(this.ctx.renderer, globalUniforms.uTime.value);
    // The loops ride on the surface, which the shader turns by uTime * 0.035.
    this.loops.rotation.y = -globalUniforms.uTime.value * 0.035;
    this.loopIntensity.value = ease;
    this.loopSunR.value = SUN_RADIUS * this.sun.scale.x * this.zoomScale;
    this.updateFlare(dt);
    this.sun.scale.setScalar(lerp(0.55, 1, ease));
    this.corona.material.uniforms.uIntensity.value = ease * 0.62;
    this.milkyWay.opacity = (0.03 + ease * 0.09) * this.skyFade;
    this.milkyWay.mesh.position.copy(cam.position);
    this.starfield.position.copy(cam.position);
    this.sky.visible = this.skyFade > 0.002;
    this.corona.quaternion.copy(cam.quaternion);
    this.belt.uniforms.uClock.value = clock;
    this.belt.uniforms.uJupiter.value = planetAngle(PLANETS.find((p) => p.id === 'jupiter')!, clock);
    this.belt.uniforms.uFade.value = ease;
    this.kuiper.uniforms.uClock.value = clock;
    this.kuiper.uniforms.uFade.value = ease;
    this.wind.uniforms.uFade.value = ease;
    this.updateRocks(clock, globalUniforms.uTime.value, ease);
    (this.starfield.material as THREE.ShaderMaterial).uniforms.uOpacity.value = (0.55 + 0.25 * ease) * this.skyFade;

    if (this.zoomed || this.comparing) {
      if (this.hoveredIndex >= 0) {
        this.hoveredIndex = -1;
        this.onHover(null);
      }
    } else {
      this.updateHover();
    }
    const ws = this.zoomScale;

    this.updateEclipsesAndStorms(dt);
    for (const m of this.moons) {
      const a = m.phase + clock * m.speed;
      m.mesh.position.set(Math.cos(a) * m.distance, 0, -Math.sin(a) * m.distance);
      m.mesh.material.uniforms.uFade.value = ease;
    }

    this.planets.forEach((p, i) => {
      const ang = planetAngle(p.data, clock);
      p.pivot.position.set(Math.cos(ang) * p.data.orbit, 0, -Math.sin(ang) * p.data.orbit);
      p.body.rotation.y += dt * (p.data.id === 'venus' ? -0.05 : 0.25 / Math.sqrt(p.data.size));
      // Full highlight marks the planet under the pointer; in a close-up it would wash the
      // planet out, so the focused one keeps only a hint of it.
      const target = i === this.focusedIndex ? 0.15 : i === this.hoveredIndex ? 1 : 0;
      p.highlight += (target - p.highlight) * Math.min(1, (dt || 1 / 60) * 8);
      p.body.material.uniforms.uHighlight.value = p.highlight * 0.8;
      p.body.material.uniforms.uFade.value = ease;
      if (p.faintRing) p.faintRing.material.uniforms.uFade.value = ease;
      // Lighting helpers work in world space, so they follow the zoom scale too.
      const world = p.pivot.getWorldPosition(this.wpos);
      if (p.atmosphere) {
        p.atmosphere.material.uniforms.uFade.value = ease;
        p.atmosphere.material.uniforms.uCenter.value.copy(world);
        p.atmosphere.material.uniforms.uR.value = p.data.size * ws;
      }
      if (p.ring) {
        const bu = p.body.material.uniforms;
        bu.uRingCenter.value.copy(world);
        bu.uRingInner.value = p.data.size * 1.3 * ws;
        bu.uRingOuter.value = p.data.size * 2.35 * ws;
        bu.uRingNormal.value.set(0, 1, 0).applyQuaternion(p.tilt.getWorldQuaternion(this.ringQuat));
        p.ring.material.uniforms.uFade.value = ease;
        p.ring.material.uniforms.uPlanetPos.value.copy(world);
        p.ring.material.uniforms.uPlanetRadius.value = p.data.size * ws;
      }
      const orbitTarget =
        i === this.hoveredIndex ? ORBIT_OPACITY.hover : i === this.focusedIndex ? ORBIT_OPACITY.focus : ORBIT_OPACITY.base;
      const ou = p.orbit.material.uniforms;
      const driftDim = 1 - 0.75 * this.drift.weight;
      ou.uOpacity.value += (orbitTarget * ease * driftDim - ou.uOpacity.value) * Math.min(1, (dt || 1 / 60) * 6);
      ou.uPlanetAngle.value = ((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      ou.uPlanetPos.value.copy(world);
      ou.uPlanetR.value = p.data.size * ws;
    });

    if (this.interactive) {
      if (this.drift.active && (this.zoomed || this.comparing)) this.setDrift(false, false);
      this.driftBodies[0].set(0, 0, 0);
      for (let i = 1; i < this.driftBodies.length; i++) this.driftBodies[i].copy(this.planets[i - 1].pivot.position);
      this.drift.update(dt, dt * this.orbitSpeed, this.driftBodies);
    }

    if (!this.interactive) return;
    if (this.zoomed) {
      this.stopTour();
      this.comet.group.visible = false;
      this.controls.autoRotate = false;
      this.controls.update();
      return;
    }
    if (this.comparing) {
      for (const b of this.lineupBodies) b.rotation.y += dt * 0.12;
      this.controls.autoRotate = false;
      this.controls.update();
      return;
    }
    this.updateDepthOfField();
    this.comet.update(dt, cam, ease);
    // Attract mode: drift slowly around the system when nobody is touching it.
    this.idle += dt;
    this.controls.autoRotate = dt > 0 && this.focusedIndex < 0 && this.idle > IDLE_AFTER;
    this.controls.autoRotateSpeed = 0.35;
    if (!this.tour.on && this.focusedIndex < 0 && this.idle > TOUR_AFTER) this.startTour(true);
    this.updateTour(dt);
    this.updateFocus();
    this.controls.update();
  }

  /**
   * Every 9–16 s a flare erupts in an active region near the limb (so both the flash on
   * the disk and the coronal mass ejection above the edge are visible).
   */
  private updateFlare(dt: number): void {
    const f = this.flare;
    f.age += dt;
    f.next -= dt;
    if (f.next <= 0 && this.params.intro >= 1) {
      f.next = 9 + Math.random() * 7;
      f.age = 0;
      const toCam = this.ctx.camera.position.clone().normalize();
      const side = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).cross(toCam).normalize();
      const tilt = THREE.MathUtils.degToRad(68 + Math.random() * 12);
      f.dir.copy(toCam).multiplyScalar(Math.cos(tilt)).addScaledVector(side, Math.sin(tilt)).normalize();
    }
    this.sun.material.uniforms.uFlareAge.value = f.age;
    this.sun.material.uniforms.uFlareDir.value.copy(f.dir);
    // Where the flare sits on the corona billboard (camera-aligned plane).
    const cam = this.ctx.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const cu = this.corona.material.uniforms;
    cu.uFlareAngle.value = Math.atan2(f.dir.dot(up), f.dir.dot(right));
    cu.uFlareAge.value = f.age;
  }

  private updateDepthOfField(): void {
    const focused = this.focusedIndex >= 0 && this.focus.t > 0.6;
    if (this.focusedIndex >= 0) this.dofIndex = this.focusedIndex;
    this.dofAmount += ((focused ? 1 : 0) - this.dofAmount) * 0.06;
    if (this.dofAmount < 0.01) return;
    // Keep focus on the last planet while the blur fades out after leaving it.
    const p = this.planets[this.dofIndex];
    const dof = this.ctx.dof;
    dof.distance = this.ctx.camera.position.distanceTo(p.pivot.getWorldPosition(this.wpos));
    dof.range = p.data.size * (p.data.rings ? 7 : 4.5);
    dof.amount = this.dofAmount;
  }

  private updateHover(): void {
    const { pointer, camera } = this.ctx;
    let index = -1;
    if (this.interactive && pointer.inside) {
      this.raycaster.setFromCamera(pointer.ndc, camera);
      const hits = this.raycaster.intersectObjects(this.planets.map((p) => p.hit), false);
      if (hits.length) index = hits[0].object.userData.index as number;
    }
    if (index !== this.hoveredIndex) {
      this.hoveredIndex = index;
      this.onHover(index >= 0 ? this.planets[index].data : null);
    }
  }

  /** Screen position (CSS px) of a planet, or null when behind the camera. */
  planetScreen(index: number, width: number, height: number): { x: number; y: number } | null {
    const v = this.planets[index].pivot.getWorldPosition(this.tmp).project(this.ctx.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * width, y: (1 - (v.y * 0.5 + 0.5)) * height };
  }

  /** True while the user is exploring (focused, hovering, or recently interacted). */
  get isExploring(): boolean {
    return this.focusedIndex >= 0 || this.hoveredIndex >= 0 || this.idle < 0.5;
  }

  get wantsPointer(): boolean {
    return this.hoveredIndex >= 0;
  }

  private buildDrift(): void {
    const main = this.planets.slice(0, PLANETS.length);
    const earth = PLANETS.find((p) => p.id === 'earth')!;
    // Earth's orbital speed in scene units per unit of orbit clock. In reality the Sun goes
    // round the Galaxy 230 / 29.8 ≈ 7.7 times faster, which stretches every helix into a
    // nearly straight line on screen; the animation uses 1.6× so the coils can be seen
    // (the captions keep the real 230 km/s).
    const earthSpeed = earth.orbit * (planetAngle(earth, 1) - planetAngle(earth, 0));
    // The Sun heads ~60° out of the plane of the planets (towards Cygnus); its longitude in
    // this model is free, so it points side-on to the default view.
    const dir = new THREE.Vector3(Math.cos(Math.PI / 3), Math.sin(Math.PI / 3), 0);
    this.drift = new GalacticDrift(['#ffcf7a', ...main.map((p) => p.data.colors[0])], earthSpeed * DRIFT_SPEED_RATIO, dir);
    this.driftBodies = [new THREE.Vector3(), ...main.map(() => new THREE.Vector3())];
    this.group.add(this.drift.group);
  }

  get drifting(): boolean {
    return this.drift.active;
  }

  /** Flies the camera out to a side view where the trails stream away behind the Sun. */
  setDrift(on: boolean, moveCamera = true): void {
    if (on === this.drift.active || !this.interactive) return;
    if (on && (this.zoomed || this.comparing)) return;
    const cam = this.ctx.camera;
    this.drift.setActive(on);
    this.onDrift(on);
    // Toggling the flight is activity: don't let the idle tour jump in right after it.
    this.idle = 0;
    this.driftTween?.kill();
    let to: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    if (on) {
      this.stopTour();
      if (this.focusedIndex >= 0) this.unfocus();
      this.driftPose = { pos: cam.position.clone(), target: this.controls.target.clone() };
      // Slightly ahead of the Sun and off to the side, looking back along the path: the
      // perspective packs the long, gentle coils of each helix into visible spirals.
      const dir = this.drift.direction;
      const side = new THREE.Vector3(0, 0, 1);
      const target = dir.clone().multiplyScalar(-20);
      to = { pos: target.clone().addScaledVector(side, 74).addScaledVector(dir, 14).add(new THREE.Vector3(-12, 0, 0)), target };
      this.controls.maxDistance = 160;
    } else {
      to = this.driftPose;
      this.driftPose = null;
      this.controls.maxDistance = OVERVIEW_LIMITS.max;
      if (this.focusedIndex >= 0 || !moveCamera) {
        this.controls.enabled = true;
        return;
      }
    }
    if (!to) return;
    const from = { pos: cam.position.clone(), target: this.controls.target.clone() };
    const k = { t: 0 };
    this.controls.enabled = false;
    this.driftTween = gsap.to(k, {
      t: 1,
      duration: this.ctx.reducedMotion ? 1.0 : 2.2,
      ease: 'power2.inOut',
      onUpdate: () => {
        cam.position.lerpVectors(from.pos, to!.pos, k.t);
        this.controls.target.lerpVectors(from.target, to!.target, k.t);
      },
      onComplete: () => {
        this.controls.enabled = true;
      },
    });
  }

  /**
   * Colour maps for the other planets, the Moon, Ceres, Eris and Saturn's rings (Solar System
   * Scope, CC BY 4.0), in public/textures/planets. Each body stays procedural until its map
   * has arrived, so nothing ever shows up black.
   */
  private loadPlanetTextures(): void {
    const loader = new THREE.TextureLoader();
    const base = `${import.meta.env.BASE_URL}textures/planets/`;
    const aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy());
    const load = (file: string, srgb: boolean, done: (t: THREE.Texture) => void) =>
      loader.load(
        base + file,
        (t) => {
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.wrapS = THREE.RepeatWrapping;
          t.anisotropy = aniso;
          done(t);
        },
        undefined,
        () => console.warn(`Texture ${file} failed to load; keeping the procedural look.`),
      );
    for (const p of this.planets) {
      const file = PLANET_MAPS[p.data.id];
      if (!file) continue;
      const u = p.body.material.uniforms;
      load(file, true, (t) => {
        u.uMap.value = t;
        u.uMapOn.value = 1;
      });
      if (p.ring) {
        const ru = p.ring.material.uniforms;
        load('saturn_ring.png', true, (t) => {
          t.wrapS = THREE.ClampToEdgeWrapping;
          ru.uRingTex.value = t;
          ru.uRingTexOn.value = 1;
        });
      }
    }
    for (const m of this.moons) {
      const file = MOON_MAPS[m.name];
      if (!file) continue;
      const u = m.mesh.material.uniforms;
      load(file, true, (t) => {
        u.uMap.value = t;
        u.uMapOn.value = 1;
      });
    }
  }

  /** Real Earth maps (NASA Blue Marble / Black Marble via three.js examples), in public/. */
  private loadEarthTextures(): void {
    const earth = this.planets.find((p) => p.data.id === 'earth');
    if (!earth) return;
    const u = earth.body.material.uniforms;
    const loader = new THREE.TextureLoader();
    const base = `${import.meta.env.BASE_URL}textures/earth/`;
    const maxAniso = this.ctx.renderer.capabilities.getMaxAnisotropy();
    const maps: [string, string, boolean][] = [
      ['uDay', 'day.jpg', true],
      ['uNight', 'night.png', true],
      ['uWater', 'water.jpg', false],
      ['uCloudTex', 'clouds.png', false],
    ];
    let left = maps.length;
    for (const [key, file, srgb] of maps) {
      loader.load(
        base + file,
        (t) => {
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.wrapS = THREE.RepeatWrapping;
          t.anisotropy = Math.min(8, maxAniso);
          u[key].value = t;
          if (--left === 0) u.uTex.value = 1;
        },
        undefined,
        () => console.warn(`Earth texture ${file} failed to load; keeping the procedural Earth.`),
      );
    }
  }

  // ---------------------------------------------------------------- size comparison

  private buildLineup(): void {
    const km = (text: string) => Number(text.replace(/[^0-9]/g, ''));
    const earthKm = km(PLANETS.find((p) => p.id === 'earth')!.diameter);
    const sunR = (SUN_DIAMETER_KM / earthKm) * LINEUP_EARTH;
    const sunMat = this.sun.material.clone();
    sunMat.uniforms.uTime = globalUniforms.uTime;
    sunMat.uniforms.uFade.value = 1;
    sunMat.uniforms.uFlareAge.value = 99;
    sunMat.uniforms.uPerlin = this.sun.material.uniforms.uPerlin;
    // A far bigger disk needs proportionally finer granulation.
    sunMat.uniforms.uGran.value = 120;
    const sun = new THREE.Mesh(new THREE.SphereGeometry(sunR, 160, 120), sunMat);
    this.lineup.add(sun);
    this.compareLabels.push({
      pos: new THREE.Vector3(sunR * Math.cos(0.2) - 4, sunR * Math.sin(0.2), 0),
      text: 'Сонце',
      sub: '1 392 700 км · вмістило б 1,3 млн Земель',
    });

    let x = sunR + 3.2;
    const first = x;
    PLANETS.forEach((data, i) => {
      const r = (km(data.diameter) / earthKm) * LINEUP_EARTH;
      const reach = data.rings ? r * 2.2 : r;
      x += reach;
      const tilt = new THREE.Object3D();
      tilt.position.set(x, 0, 0);
      tilt.rotation.z = THREE.MathUtils.degToRad(data.tilt);
      const src = this.planets[i].body.material;
      const mat = src.clone();
      mat.uniforms.uTime = globalUniforms.uTime;
      // Share the (possibly still loading) Earth maps instead of copying empty slots.
      for (const k of ['uDay', 'uNight', 'uWater', 'uCloudTex', 'uTex', 'uMap', 'uMapOn']) mat.uniforms[k] = src.uniforms[k];
      mat.uniforms.uFade.value = 1;
      mat.uniforms.uHighlight.value = 0;
      mat.uniforms.uOccR.value = 0;
      (mat.uniforms.uFlash.value as THREE.Vector4).set(1, 0, 0, 0);
      const body = new THREE.Mesh(new THREE.SphereGeometry(r, 96, 64), mat);
      tilt.add(body);
      this.lineup.add(tilt);
      this.lineupBodies.push(body);
      const ring = this.planets[i].ring;
      if (ring) {
        const rm = ring.material.clone();
        rm.uniforms.uRingTex = ring.material.uniforms.uRingTex;
        rm.uniforms.uRingTexOn = ring.material.uniforms.uRingTexOn;
        const k = r / data.size;
        rm.uniforms.uInner.value = data.size * 1.3;
        rm.uniforms.uOuter.value = data.size * 2.35;
        rm.uniforms.uFade.value = 1;
        rm.uniforms.uPlanetPos.value.set(x, 0, 0);
        rm.uniforms.uPlanetRadius.value = r;
        const rmesh = new THREE.Mesh(ring.geometry, rm);
        rmesh.rotation.x = -Math.PI / 2;
        rmesh.scale.setScalar(k);
        tilt.add(rmesh);
        tilt.updateMatrixWorld(true);
        mat.uniforms.uRingCenter.value.set(x, 0, 0);
        mat.uniforms.uRingInner.value = r * 1.3;
        mat.uniforms.uRingOuter.value = r * 2.35;
        mat.uniforms.uRingNormal.value.set(0, 1, 0).applyQuaternion(tilt.quaternion);
      } else {
        mat.uniforms.uRingOuter.value = 0;
      }
      // Neighbours' labels alternate between two rows so the small planets don't collide.
      const drop = Math.max(r, 0.35) + 0.9 + (i % 2 === 1 ? 3.6 : 0);
      this.compareLabels.push({ pos: new THREE.Vector3(x, -drop, 0), text: data.name, sub: data.diameter });
      x += reach + (i < 3 ? 2.2 : 2.4);
    });
    this.compareCenter.set((first + x) / 2 - 4, 0, 0);
    this.lineup.visible = false;
  }

  get comparing(): boolean {
    return this.comparePose !== null;
  }

  /** Switches between the Solar System and the size line-up (the app hides the cut). */
  setCompare(on: boolean): void {
    if (on === this.comparing || !this.interactive) return;
    const cam = this.ctx.camera;
    if (on) {
      this.stopTour();
      if (this.focusedIndex >= 0) {
        this.focusTween?.kill();
        this.focusedIndex = -1;
        this.onFocus(null);
        if (this.overviewPose) {
          cam.position.copy(this.overviewPose.pos);
          this.controls.target.copy(this.overviewPose.target);
        }
        this.overviewPose = null;
      }
      if (this.hoveredIndex >= 0) {
        this.hoveredIndex = -1;
        this.onHover(null);
      }
      this.comparePose = { pos: cam.position.clone(), target: this.controls.target.clone() };
      this.group.visible = false;
      this.ctx.scene.add(this.lineup);
      this.lineup.visible = true;
      const c = this.compareCenter;
      cam.position.set(c.x - 30, 7, 58);
      this.controls.target.copy(c);
      this.controls.minDistance = 14;
      this.controls.maxDistance = 120;
      this.controls.autoRotate = false;
    } else {
      const pose = this.comparePose!;
      this.comparePose = null;
      this.lineup.visible = false;
      this.ctx.scene.remove(this.lineup);
      this.group.visible = true;
      cam.position.copy(pose.pos);
      this.controls.target.copy(pose.target);
      this.controls.minDistance = OVERVIEW_LIMITS.min;
      this.controls.maxDistance = OVERVIEW_LIMITS.max;
    }
    cam.lookAt(this.controls.target);
    this.controls.enabled = true;
    this.controls.update();
    this.idle = 0;
  }

  // ---------------------------------------------------------------- guided tour

  get touring(): boolean {
    return this.tour.on;
  }

  /** Visits every planet from Mercury outwards; `auto` = started by idling. */
  startTour(auto = false): void {
    if (!this.interactive || this.zoomed || this.tour.on || this.comparing) return;
    // Someone watching the helices is not idle.
    if (auto && this.drift.active) return;
    this.tour = { on: true, index: -1, t: 0, auto };
    this.onTour(true);
  }

  stopTour(): void {
    if (!this.tour.on) return;
    this.tour.on = false;
    this.idle = 0;
    this.onTour(false);
  }

  toggleTour(): void {
    if (this.tour.on) {
      this.stopTour();
      this.unfocus();
    } else {
      this.startTour(false);
    }
  }

  private updateTour(dt: number): void {
    const tour = this.tour;
    if (!tour.on) return;
    tour.t += dt;
    if (tour.index >= 0 && tour.t < TOUR_HOLD + (this.ctx.reducedMotion ? 1.0 : 1.8)) return;
    tour.t = 0;
    tour.index++;
    if (tour.index >= this.planets.length) {
      this.stopTour();
      this.unfocus();
      return;
    }
    this.focusPlanet(tour.index);
  }

  // ---------------------------------------------------------------- focus

  private planetWorld(index: number, out: THREE.Vector3): THREE.Vector3 {
    return this.planets[index].pivot.getWorldPosition(out);
  }

  focusPlanet(index: number): void {
    if (!this.interactive || index === this.focusedIndex) return;
    const cam = this.ctx.camera;
    if (!this.overviewPose) this.overviewPose = { pos: cam.position.clone(), target: this.controls.target.clone() };
    const data = this.planets[index].data;
    this.focusedIndex = index;
    this.focusFrom.pos.copy(cam.position);
    this.focusFrom.target.copy(this.controls.target);
    const P = this.planetWorld(index, this.tmp);
    const dist = data.size * (data.rings ? 6.5 : 5.2) + 1.2;
    // Approach at a three-quarter phase, a little above the orbital plane, so the
    // terminator shows. Earth is seen closer to half-lit, with its city lights on the night side.
    const sunward = P.clone().normalize().negate();
    const side = cam.position.clone().sub(P);
    side.addScaledVector(sunward, -side.dot(sunward)).setY(0);
    if (side.lengthSq() < 1e-6) side.set(-sunward.z, 0, sunward.x);
    side.normalize();
    const phase = data.id === 'earth' ? 1.2 : 0.75;
    this.focusOffset.copy(sunward).multiplyScalar(Math.cos(phase)).addScaledVector(side, Math.sin(phase));
    this.focusOffset.y += 0.3;
    this.focusOffset.normalize().multiplyScalar(dist);
    this.sunDetour(cam.position, P.clone().add(this.focusOffset), this.flightBump);
    this.focus = { t: 0, following: false };
    this.controls.enabled = false;
    this.controls.minDistance = data.size * 2.2;
    this.controls.maxDistance = data.size * 16 + 6;
    this.focusTween?.kill();
    this.focusTween = gsap.to(this.focus, { t: 1, duration: this.ctx.reducedMotion ? 1.0 : 1.8, ease: 'power2.inOut' });
    this.onFocus(data);
  }

  /**
   * How far (and which way) a straight flight from `a` to `b` must bow out to keep clear of
   * the Sun and its corona; zero when the straight line is already clear.
   */
  private sunDetour(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const safe = SUN_RADIUS * 4.5 * this.zoomScale;
    const ab = b.clone().sub(a);
    const t = THREE.MathUtils.clamp(-a.dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
    const closest = a.clone().addScaledVector(ab, t);
    const d = closest.length();
    if (d >= safe || t <= 0 || t >= 1) return out.set(0, 0, 0);
    // Push away from the Sun, preferring to arc over it.
    const away = d > 1e-3 ? closest.clone().divideScalar(d) : new THREE.Vector3(0, 1, 0);
    away.y += 0.6;
    away.addScaledVector(ab.normalize(), -away.dot(ab)).normalize();
    // The bump peaks mid-flight (sin), so scale it to the depth needed at the closest point.
    return out.copy(away).multiplyScalar((safe - d) / Math.max(Math.sin(Math.PI * t), 0.3));
  }

  unfocus(): void {
    if (this.focusedIndex < 0 || !this.overviewPose) return;
    const cam = this.ctx.camera;
    const from = { pos: cam.position.clone(), target: this.controls.target.clone() };
    const to = this.overviewPose;
    const bump = this.sunDetour(from.pos, to.pos, new THREE.Vector3());
    this.focusedIndex = -1;
    this.overviewPose = null;
    this.focus = { t: 1, following: false };
    this.controls.enabled = false;
    this.controls.minDistance = OVERVIEW_LIMITS.min;
    this.controls.maxDistance = OVERVIEW_LIMITS.max;
    const k = { t: 0 };
    this.focusTween?.kill();
    this.focusTween = gsap.to(k, {
      t: 1,
      duration: this.ctx.reducedMotion ? 0.9 : 1.6,
      ease: 'power2.inOut',
      onUpdate: () => {
        cam.position.lerpVectors(from.pos, to.pos, k.t);
        cam.position.addScaledVector(bump, Math.sin(Math.PI * k.t));
        this.controls.target.lerpVectors(from.target, to.target, k.t);
      },
      onComplete: () => {
        this.controls.enabled = true;
      },
    });
    this.onFocus(null);
  }

  private updateFocus(): void {
    if (this.focusedIndex < 0) return;
    const cam = this.ctx.camera;
    const P = this.planetWorld(this.focusedIndex, new THREE.Vector3());
    if (this.focus.t < 1 || !this.focus.following) {
      const t = this.focus.t;
      cam.position.lerpVectors(this.focusFrom.pos, P.clone().add(this.focusOffset), t);
      cam.position.addScaledVector(this.flightBump, Math.sin(Math.PI * t));
      this.controls.target.lerpVectors(this.focusFrom.target, P, t);
      if (t >= 1) {
        this.focus.following = true;
        this.lastPlanetPos.copy(P);
        this.controls.enabled = true;
      }
      return;
    }
    // Ride along with the planet while the user is free to orbit around it.
    const delta = P.clone().sub(this.lastPlanetPos);
    cam.position.add(delta);
    this.controls.target.copy(P);
    this.lastPlanetPos.copy(P);
  }

  private onActivity = (e: Event) => {
    this.idle = 0;
    // A self-started tour gives way to any movement; one the user asked for, to a click or wheel.
    if (this.tour.on && (this.tour.auto || e.type === 'wheel')) {
      this.stopTour();
      if (this.tour.auto) this.unfocus();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.idle = 0;
    this.stopTour();
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.interactive || this.zoomed || this.comparing || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    if (moved > 6 || performance.now() - this.downAt.t > 600) return; // that was a drag
    if (this.hoveredIndex >= 0) this.focusPlanet(this.hoveredIndex);
    else if (this.focusedIndex >= 0) this.unfocus();
  };

  exit(): void {
    this.ctx.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.ctx.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.ctx.canvas.removeEventListener('wheel', this.onActivity);
    this.ctx.scene.remove(this.sky);
    this.setZoom(1);
    this.ctx.canvas.removeEventListener('pointermove', this.onActivity);
    this.controls.autoRotate = false;
    this.focusTween?.kill();
    this.stopTour();
    if (this.drift.active) this.setDrift(false, false);
    this.driftTween?.kill();
    this.drift.reset();
    if (this.comparing) this.setCompare(false);
    this.controls.enabled = false;
    this.interactive = false;
    if (this.hoveredIndex >= 0) this.onHover(null);
    if (this.focusedIndex >= 0) this.onFocus(null);
    this.hoveredIndex = -1;
    this.focusedIndex = -1;
  }

  applyConfig(): void {
    this.sun.material.uniforms.uColor.value.set(config.colors.sun);
    this.corona.material.uniforms.uColor.value.set(config.colors.sun);
  }

  dispose(): void {
    this.exit();
    this.unregister();
    this.unregisterExtra.forEach((u) => u());
    this.controls.dispose();
    this.noiseCube.dispose();
    this.drift.dispose();
    this.milkyWay.dispose();
    disposeObject(this.sky);
    disposeObject(this.group);
  }
}
