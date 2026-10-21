import * as THREE from 'three';
import { gsap } from 'gsap';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { config } from '../config';
import { globalUniforms } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import { DWARFS, OVERVIEW, PLANETS, SUN_RADIUS, planetAngle, type Planet } from '../data/planets';
import { createMilkyWay, createStarfield, disposeObject, lerp, smooth } from './util';
import { Comet } from './Comet';
import { SunNoiseCube } from './sunFx';
import { GalacticDrift } from './galacticDrift';
import { createBrightStars } from './brightStars';
import { buildCorona, buildLoops, buildSun } from './solar/sun';
import { KIND_INDEX, type PlanetView } from './solar/common';
import { buildPlanet } from './solar/planet';
import { buildAurora, buildPlumes } from './solar/atmosphere';
import { AsteroidRocks, buildBelt, buildKuiperBelt, buildRingChunks, buildSolarWind, buildZodiacalLight } from './solar/belts';
import { PASSAGE_SPEED, Wormhole } from './wormhole';

const ORBIT_OPACITY = { base: 0.13, hover: 0.42, focus: 0.3 };
const OVERVIEW_LIMITS = { min: 9, max: 95 };
/** Where the wormhole hangs, relative to Saturn (Solar-System units). */
const WORMHOLE_OFFSET = new THREE.Vector3(3.6, 0.9, 3.3);
/** Seconds of the flight up to the wormhole, and of the flight away from it on the way back. */
const PORTAL_FLIGHT = 2.6;
const PORTAL_BACK = 2.4;
/** Where the flight in stops: distance from the wormhole's centre, in throat radii. */
export const PORTAL_RC = 2.6;
/** Seconds without input before the camera starts drifting around on its own. */
const IDLE_AFTER = 7;
/** Seconds without any input before the guided tour starts by itself. */
const TOUR_AFTER = 45;
/** Seconds the tour lingers on each planet (after the flight there). */
const TOUR_HOLD = 6.5;
/** Size comparison: world units per Earth radius, and the Sun's true diameter. */
const LINEUP_EARTH = 0.55;
/** Relief strength for mapped rocky bodies (height per unit of map brightness, in radii). */
const BUMP = 0.035;
/** Colour maps per body (public/textures/planets). Pluto has none and stays procedural. */
const PLANET_MAPS: Record<string, string> = {
  // (WebP where it is much smaller; the cratered bodies keep JPEG, which WebP does not beat.)
  mercury: 'mercury.jpg', venus: 'venus.webp', mars: 'mars.webp', jupiter: 'jupiter.webp', saturn: 'saturn.webp',
  uranus: 'uranus.webp', neptune: 'neptune.webp', ceres: 'ceres.jpg', eris: 'eris.jpg',
};
const MOON_MAPS: Record<string, string> = { 'Місяць': 'moon.jpg' };
const MOON_CRATERS: Record<string, number> = { 'Місяць': 1, 'Іо': 0, 'Європа': 0.12, 'Ганімед': 0.55, 'Каллісто': 1, 'Титан': 0 };
/** Sunspots modelled on the Sun's surface (fixed array size for the shader). */
const SUN_DIAMETER_KM = 1_392_700;
/** Sun's galactic speed relative to Earth's orbital speed in the «Політ» animation (real: ~7.7). */
const DRIFT_SPEED_RATIO = 1.6;

export interface CompareLabel {
  pos: THREE.Vector3;
  text: string;
  sub: string;
}



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
  /** «Інтерстелар»: the pointer is on the wormhole near Saturn. */
  onWormholeHover: (on: boolean) => void = () => {};
  /** The camera has flown into the wormhole: the app takes over with the other side. */
  onWormhole: () => void = () => {};

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
  /** Saturn's rings up close: individual chunks of ice that appear as the camera nears. */
  private ringChunks?: THREE.ShaderMaterial;
  /** Boiling plasma baked each frame into a cube map, read by the Sun's surface shader. */
  private noiseCube = new SunNoiseCube();
  /** «Політ крізь Галактику»: helical trails of the planets behind the moving Sun. */
  private drift!: GalacticDrift;
  private driftBodies: THREE.Vector3[] = [];
  private driftPose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private driftTween?: gsap.core.Tween;
  onDrift: (on: boolean) => void = () => {};
  /**
   * Guided close-ups: a solar or lunar eclipse set up on the spot, or riding along with the
   * comet. The camera is driven here and handed back afterwards.
   */
  private show: {
    kind: 'solar' | 'lunar' | 'comet';
    t: number;
    pose: { pos: THREE.Vector3; target: THREE.Vector3 };
    from: { pos: THREE.Vector3; target: THREE.Vector3 };
    speed: number;
  } | null = null;
  private showTween?: gsap.core.Tween;
  onShow: (kind: 'solar' | 'lunar' | 'comet' | null) => void = () => {};
  private corona: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private milkyWay: ReturnType<typeof createMilkyWay>;
  private zodiacal: THREE.ShaderMaterial;
  private auroras: { planet: PlanetView; material: THREE.ShaderMaterial }[] = [];
  private comet = new Comet();
  /** Solar flare scheduler: seconds since the last flare and until the next one. */
  private flare = { age: 99, next: 5, dir: new THREE.Vector3(1, 0, 0) };
  private idle = 0;
  private belt: THREE.ShaderMaterial;
  private kuiper!: THREE.ShaderMaterial;
  private wind!: THREE.ShaderMaterial;
  private unregisterExtra: (() => void)[] = [];
  private rocks = new AsteroidRocks();
  private starfield = createStarfield(6000, 300, 21);
  /** The real bright stars and, on demand (K), the constellation figures. */
  private brightStars = createBrightStars();
  private figuresOn = false;
  /** 0..1 fade of the constellation figures and their names. */
  figuresWeight = 0;
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
  private wormhole = new Wormhole();
  private wormholeHovered = false;
  private humLevel = 0;
  /** Flight into the wormhole, and the pose to come back to. */
  private portal: {
    t: number;
    fired: boolean;
    /** In: flying up to the wormhole; out: flying away from it, back to `back`. */
    dir: 'in' | 'out';
    back: { pos: THREE.Vector3; target: THREE.Vector3 };
    /** The speed at the mouth, as the slope of the easing (at the end going in, the start out). */
    s0?: number;
  } | null = null;

  constructor(private ctx: Ctx) {
    const sun = buildSun(this.noiseCube);
    this.sun = sun.mesh;
    this.spotGroups = sun.spotGroups;
    this.loops = buildLoops(this.sun, this.spotGroups, this.loopIntensity, this.loopSunR);
    this.corona = buildCorona();
    this.milkyWay = createMilkyWay(ctx.renderer);
    this.sky.add(this.milkyWay.mesh, this.starfield, this.brightStars.group);
    this.group.add(this.sun, this.corona, this.comet.group);
    [...PLANETS, ...DWARFS].forEach((p, i) => this.planets.push(buildPlanet(p, i, this.group)));
    const kuiper = buildKuiperBelt();
    this.kuiper = kuiper.material;
    this.group.add(kuiper.points);
    this.unregisterExtra.push(ctx.quality.register(kuiper.geometry, kuiper.count));
    const wind = buildSolarWind();
    this.wind = wind.material;
    this.group.add(wind.points);
    const zodiacal = buildZodiacalLight();
    this.zodiacal = zodiacal.material;
    this.group.add(zodiacal.mesh);
    this.buildMoons();
    this.ringChunks = buildRingChunks(this.planets.find((p) => p.data.id === 'saturn')!);
    this.buildDrift();
    this.loadEarthTextures();
    this.loadPlanetTextures();
    this.buildLineup();
    // Polar lights on Earth and Jupiter, seen when we come close.
    for (const [id, low, high, lat] of [
      ['earth', '#35ff8a', '#ff4f7a', 67],
      ['jupiter', '#8f7dff', '#c79bff', 74],
    ] as const) {
      const p = this.planets.find((q) => q.data.id === id)!;
      const aurora = buildAurora(p.data.size, low, high, lat);
      p.tilt.add(aurora.group);
      this.auroras.push({ planet: p, material: aurora.material });
    }
    const saturn = this.planets.find((p) => p.data.id === 'saturn')!;
    this.wormhole.group.position.copy(WORMHOLE_OFFSET);
    saturn.pivot.add(this.wormhole.group);
    const belt = buildBelt();
    this.belt = belt.material;
    this.group.add(belt.points, this.rocks.mesh);
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
        // The Moon orbits close to the ecliptic (5°), not over Earth's equator: that is
        // what lets eclipses happen. Other moons keep to their planet's equator.
        (m.name === 'Місяць' ? p.pivot : p.tilt).add(mesh);
        this.moons.push({ mesh, distance: m.distance, speed: m.speed, phase: m.phase, name: m.name, parent: pi });
        if (m.name === 'Іо') this.ioPlumes = buildPlumes(mesh, m.radius);
      });
    });
  }

  /** Io's volcanic plumes: umbrella-shaped fountains of sulphur rising and falling. */
  private occluderWorld = new THREE.Vector3();
  private bodyQuat = new THREE.Quaternion();
  private tmpJ = new THREE.Vector3();
  private tmpS = new THREE.Vector3();

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
      if (earth.atmosphere) set(earth.atmosphere.material, this.occluderWorld, moon.mesh.geometry.parameters.radius * ws);
    }
    // Jupiter: whichever Galilean moon stands between it and the Sun casts its shadow.
    const jw = jupiter.pivot.getWorldPosition(this.tmpJ);
    const toSun = this.tmpS.copy(jw).negate().normalize();
    let best: (typeof this.moons)[number] | null = null;
    let bestMiss = Infinity;
    for (const name of ['Іо', 'Європа', 'Ганімед', 'Каллісто']) {
      const m = byName(name);
      if (!m) continue;
      const rel = m.mesh.getWorldPosition(this.occluderWorld).sub(jw);
      if (rel.dot(toSun) <= 0) continue;
      const miss = rel.addScaledVector(toSun, -rel.dot(toSun)).length() / ws - m.mesh.geometry.parameters.radius;
      if (miss < bestMiss) {
        bestMiss = miss;
        best = m;
      }
    }
    const caster = best ?? io;
    if (caster) set(jupiter.body.material, caster.mesh.getWorldPosition(this.occluderWorld), caster.mesh.geometry.parameters.radius * ws);
    // Polar lights: only near enough to see them, facing away from the Sun at night.
    const cam = this.ctx.camera;
    for (const a of this.auroras) {
      const pw = a.planet.pivot.getWorldPosition(this.tmpJ);
      const r = a.planet.data.size * ws;
      const d = cam.position.distanceTo(pw);
      a.material.uniforms.uFade.value = (1 - smooth(r * 7, r * 22, d)) * this.params.intro * 0.9;
      a.material.uniforms.uSun.value.copy(pw).negate().normalize();
    }
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
  /** Solar wind: a thin, ceaseless outflow of particles from the Sun. */
  /** A few dozen large, irregular, sunlit asteroids among the dust. */

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
    this.brightStars.group.position.copy(cam.position);
    this.brightStars.opacity = (0.55 + 0.45 * ease) * this.skyFade;
    this.figuresWeight += ((this.figuresOn && this.interactive ? 1 : 0) - this.figuresWeight) * Math.min(1, (dt || 1 / 60) * 3);
    this.brightStars.figures = this.figuresWeight * this.skyFade;
    this.sky.visible = this.skyFade > 0.002;
    this.corona.quaternion.copy(cam.quaternion);
    this.belt.uniforms.uClock.value = clock;
    if (this.ringChunks) {
      const saturn = this.planets.find((p) => p.data.id === 'saturn')!;
      this.ringChunks.uniforms.uClock.value = clock;
      this.ringChunks.uniforms.uFade.value = ease;
      this.ringChunks.uniforms.uNear.value = saturn.data.size * 3.2 * this.zoomScale;
    }
    this.belt.uniforms.uJupiter.value = planetAngle(PLANETS.find((p) => p.id === 'jupiter')!, clock);
    this.belt.uniforms.uFade.value = ease;
    this.kuiper.uniforms.uClock.value = clock;
    this.kuiper.uniforms.uFade.value = ease;
    this.wind.uniforms.uFade.value = ease;
    this.zodiacal.uniforms.uFade.value = ease;
    this.rocks.update(clock, globalUniforms.uTime.value, ease);
    (this.starfield.material as THREE.ShaderMaterial).uniforms.uOpacity.value = (0.55 + 0.25 * ease) * this.skyFade;

    if (this.zoomed || this.comparing || this.portal) {
      if (this.hoveredIndex >= 0) {
        this.hoveredIndex = -1;
        this.onHover(null);
      }
      this.setWormholeHover(false);
    } else {
      this.updateHover();
    }
    this.wormhole.update(dt, cam, this.interactive && !this.comparing ? ease : 0, this.wormholeHovered);
    // The mouth hums when we come close (left to the passage's own sound once we fall in).
    const near = this.interactive && !this.portal ? 1 - THREE.MathUtils.smoothstep(cam.position.distanceTo(this.wormhole.group.getWorldPosition(this.wpos)) / this.wormhole.throat, 4, 40) : 0;
    if (Math.abs(near - this.humLevel) > 0.02 || (near === 0 && this.humLevel !== 0)) {
      this.humLevel = near;
      this.ctx.audio.throatHum(near);
    }
    const ws = this.zoomScale;

    this.updateEclipsesAndStorms(dt);
    for (const m of this.moons) {
      const a = m.phase + clock * m.speed;
      m.mesh.position.set(Math.cos(a) * m.distance, 0, -Math.sin(a) * m.distance);
      m.mesh.material.uniforms.uFade.value = ease;
      m.mesh.material.uniforms.uBump.value = m.mesh.geometry.parameters.radius * this.zoomScale * BUMP;
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
      // Rocky bodies with a map get relief; its scale follows their size on screen.
      p.body.material.uniforms.uBump.value = p.data.kind === 'rocky' && p.data.id !== 'venus' ? p.data.size * ws * BUMP : 0;
      // Jupiter's, Uranus's and Neptune's ringlets are very faint in reality.
      if (p.faintRing) p.faintRing.material.uniforms.uFade.value = ease * 0.4;
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
      if (this.show) this.endShow(false);
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
    if (this.show) {
      this.idle = 0;
      this.controls.autoRotate = false;
      this.updateShow(dt);
      return;
    }
    if (this.portal) {
      this.idle = 0;
      this.controls.autoRotate = false;
      this.updatePortal(dt);
      return;
    }
    this.updateFocus();
    this.controls.update();
  }

  // ---------------------------------------------------------------- the wormhole

  private setWormholeHover(on: boolean): void {
    if (on === this.wormholeHovered) return;
    this.wormholeHovered = on;
    this.onWormholeHover(on);
  }

  /** Flies the camera into the wormhole; onWormhole fires once its mouth fills the view. */
  enterWormhole(): void {
    if (!this.interactive || this.portal || this.zoomed || this.comparing) return;
    const cam = this.ctx.camera;
    this.stopTour();
    if (this.show) this.endShow(false);
    this.focusTween?.kill();
    // Coming back, land in the overview rather than in a planet close-up.
    const back = this.focusedIndex >= 0 && this.overviewPose
      ? { pos: this.overviewPose.pos.clone(), target: this.overviewPose.target.clone() }
      : { pos: cam.position.clone(), target: this.controls.target.clone() };
    if (this.focusedIndex >= 0) {
      this.focusedIndex = -1;
      this.overviewPose = null;
      this.focus = { t: 1, following: false };
      this.onFocus(null);
    }
    this.controls.enabled = false;
    this.focusFrom.pos.copy(cam.position);
    this.focusFrom.target.copy(this.controls.target);
    // Reach the mouth still moving, at the speed the passage on the far side sets off at.
    const W = this.wormhole.group.getWorldPosition(this.wpos);
    const dist = Math.max(cam.position.distanceTo(W) - this.wormhole.throat * PORTAL_RC, 1e-3);
    const s1 = Math.min(2.5, (PASSAGE_SPEED * this.wormhole.throat * PORTAL_FLIGHT) / dist);
    this.portal = { t: 0, fired: false, dir: 'in', back, s0: s1 };
    this.setWormholeHover(false);
  }

  private updatePortal(dt: number): void {
    const p = this.portal!;
    const cam = this.ctx.camera;
    p.t += dt;
    const W = this.wormhole.group.getWorldPosition(this.tmp);
    cam.up.set(0, 1, 0);
    if (p.dir === 'out') {
      // Out of the wormhole, looking away from it, then round to the view we left: already
      // moving at the speed we came through at, so there is no halt at the hand-over.
      const k = hermite(Math.min(1, p.t / PORTAL_BACK), p.s0 ?? 0, 0);
      cam.position.lerpVectors(this.focusFrom.pos, p.back.pos, k);
      this.controls.target.lerpVectors(this.focusFrom.target, p.back.target, smoothstep5(Math.min(1, p.t / (PORTAL_BACK * 0.8))));
      cam.lookAt(this.controls.target);
      if (p.t >= PORTAL_BACK) {
        this.portal = null;
        this.controls.minDistance = OVERVIEW_LIMITS.min;
        this.controls.maxDistance = OVERVIEW_LIMITS.max;
        this.controls.enabled = true;
        this.controls.update();
        this.idle = 0;
      }
      return;
    }
    // Turn to face it first, then fall in, slowly at first and faster as it grows.
    this.controls.target.lerpVectors(this.focusFrom.target, W, smooth(0, 0.9, p.t));
    const end = this.wpos.copy(this.focusFrom.pos).sub(W).normalize().multiplyScalar(this.wormhole.throat * PORTAL_RC).add(W);
    cam.position.lerpVectors(this.focusFrom.pos, end, hermite(Math.min(1, p.t / PORTAL_FLIGHT), 0, p.s0 ?? 0));
    cam.lookAt(this.controls.target);
    // The other side picks up from exactly this view, so the hand-over shows no seam.
    if (!p.fired && p.t >= PORTAL_FLIGHT) {
      p.fired = true;
      this.onWormhole();
    }
  }

  /** The camera's pose as it reaches the wormhole: orientation, and l in throat radii. */
  get portalEntry(): { quat: THREE.Quaternion; lc: number } {
    return { quat: this.ctx.camera.quaternion.clone(), lc: Math.sqrt(PORTAL_RC * PORTAL_RC - 1) };
  }

  /** Way out of the wormhole on our side: towards the view we left it from. */
  private exitDir(out: THREE.Vector3): THREE.Vector3 {
    const W = this.wormhole.group.getWorldPosition(this.wpos);
    const back = this.portal?.back.pos ?? this.ctx.camera.position;
    return out.copy(back).sub(W).normalize();
  }

  /** Orientation of a camera leaving the wormhole on our side (looking away from it). */
  get portalExit(): THREE.Quaternion {
    const out = this.exitDir(new THREE.Vector3());
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), out.negate(), new THREE.Vector3(0, 1, 0));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  /**
   * Back from the other side: the camera comes out of the wormhole `rc` throat radii from
   * its centre, looking away from it, and flies back to the view we left from — setting off
   * at `speed` (throat radii a second), the speed it came through the wormhole at.
   */
  returnFromWormhole(rc: number, speed = 0): void {
    const p = this.portal;
    if (!p) return;
    const cam = this.ctx.camera;
    const out = this.exitDir(new THREE.Vector3());
    const W = this.wormhole.group.getWorldPosition(new THREE.Vector3());
    cam.position.copy(W).addScaledVector(out, this.wormhole.throat * rc);
    cam.up.set(0, 1, 0);
    this.focusFrom.pos.copy(cam.position);
    this.focusFrom.target.copy(cam.position).addScaledVector(out, 6);
    cam.lookAt(this.focusFrom.target);
    this.controls.target.copy(this.focusFrom.target);
    p.dir = 'out';
    p.t = 0;
    const path = cam.position.distanceTo(p.back.pos) / this.wormhole.throat;
    p.s0 = path > 1e-3 ? Math.min(2.5, (speed * PORTAL_BACK) / path) : 0;
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
    // The wormhole answers only when no planet is under the pointer.
    const onWormhole =
      index < 0 && this.interactive && pointer.inside && this.wormhole.group.visible && this.raycaster.intersectObject(this.wormhole.hit, false).length > 0;
    this.setWormholeHover(onWormhole);
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
    return this.hoveredIndex >= 0 || this.wormholeHovered;
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

  get constellations(): boolean {
    return this.figuresOn;
  }

  setConstellations(on: boolean): void {
    this.figuresOn = on;
  }

  /** Names of bright stars and constellations, as world positions (follow the camera). */
  skyLabels(out: { pos: THREE.Vector3; text: string; kind: 'star' | 'constellation' | 'galaxy' }[]): void {
    out.length = 0;
    const origin = this.brightStars.group.position;
    for (const l of this.brightStars.labels) out.push({ pos: this.tmp.copy(l.pos).add(origin).clone(), text: l.text, kind: l.kind });
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
          u.uRingMap.value = t;
          u.uRingMapOn.value = 1;
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
      ['uDay', 'day.webp', true],
      ['uNight', 'night.webp', true],
      ['uWater', 'water.webp', false],
      ['uCloudTex', 'clouds.webp', false],
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

  // ---------------------------------------------------------------- eclipses and the comet

  get showing(): 'solar' | 'lunar' | 'comet' | null {
    return this.show?.kind ?? null;
  }

  /**
   * Sets up an eclipse right now: the Moon is placed just before the line through the Sun
   * and Earth (between them for a solar eclipse, behind Earth for a lunar one), time slows,
   * and the camera watches from where it looks best.
   */
  startEclipse(kind: 'solar' | 'lunar'): void {
    const moon = this.moons.find((m) => m.name === 'Місяць');
    const earth = this.planets.find((p) => p.data.id === 'earth');
    if (!moon || !earth || !this.beginShow(kind)) return;
    const toSun = earth.pivot.position.clone().negate().normalize();
    const aSun = Math.atan2(-toSun.z, toSun.x);
    const target = kind === 'solar' ? aSun : aSun + Math.PI;
    // ~6 s until the alignment, then a slow pass through it.
    moon.phase = target - 0.32 - this.ctx.orbitClock.t * moon.speed;
    this.orbitSpeed = 0.045;
  }

  /** Brings a comet in now (if none is passing) and rides along beside its head. */
  followComet(): void {
    if (!this.comet.flying) this.comet.launch();
    if (this.beginShow('comet')) this.comet.timeScale = 0.3;
  }

  private beginShow(kind: 'solar' | 'lunar' | 'comet'): boolean {
    if (!this.interactive || this.zoomed || this.comparing) return false;
    if (this.show) this.endShow(false);
    this.stopTour();
    if (this.drift.active) this.setDrift(false, false);
    this.focusTween?.kill();
    this.showTween?.kill();
    const cam = this.ctx.camera;
    let pose = { pos: cam.position.clone(), target: this.controls.target.clone() };
    if (this.focusedIndex >= 0) {
      if (this.overviewPose) pose = this.overviewPose;
      this.focusedIndex = -1;
      this.overviewPose = null;
      this.focus = { t: 1, following: false };
      this.controls.minDistance = OVERVIEW_LIMITS.min;
      this.controls.maxDistance = OVERVIEW_LIMITS.max;
      this.onFocus(null);
    }
    this.show = { kind, t: 0, pose, from: { pos: cam.position.clone(), target: this.controls.target.clone() }, speed: this.orbitSpeed };
    this.controls.enabled = false;
    this.controls.minDistance = 0.1;
    this.onShow(kind);
    return true;
  }

  /** Ends a close-up and flies back to where the user was. */
  endShow(fly = true): void {
    const show = this.show;
    if (!show) return;
    this.show = null;
    this.orbitSpeed = show.speed;
    this.comet.timeScale = 1;
    this.controls.minDistance = OVERVIEW_LIMITS.min;
    this.idle = 0;
    this.onShow(null);
    const cam = this.ctx.camera;
    if (!fly) {
      this.controls.enabled = true;
      return;
    }
    const from = { pos: cam.position.clone(), target: this.controls.target.clone() };
    const to = show.pose;
    const k = { t: 0 };
    this.showTween = gsap.to(k, {
      t: 1,
      duration: this.ctx.reducedMotion ? 0.9 : 1.8,
      ease: 'power2.inOut',
      onUpdate: () => {
        cam.position.lerpVectors(from.pos, to.pos, k.t);
        this.controls.target.lerpVectors(from.target, to.target, k.t);
        cam.lookAt(this.controls.target);
      },
      onComplete: () => {
        this.controls.enabled = true;
      },
    });
  }

  private updateShow(dt: number): void {
    const show = this.show;
    if (!show) return;
    show.t += dt;
    const cam = this.ctx.camera;
    const up = this.tmp.set(0, 1, 0).clone();
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    const ws = this.zoomScale;
    if (show.kind === 'comet') {
      if (!this.comet.flying || show.t > 40) return this.endShow();
      const head = this.comet.headPosition.clone().multiplyScalar(ws);
      const tail = this.comet.tailDirection;
      const side = new THREE.Vector3().crossVectors(tail, up).normalize();
      pos.copy(head).addScaledVector(side, 3.4).addScaledVector(up, 0.9).addScaledVector(tail, -0.8);
      target.copy(head).addScaledVector(tail, 0.9);
    } else {
      if (show.t > 18) return this.endShow();
      const earth = this.planets.find((p) => p.data.id === 'earth')!;
      const moon = this.moons.find((m) => m.name === 'Місяць')!;
      const E = earth.pivot.getWorldPosition(new THREE.Vector3());
      const M = moon.mesh.getWorldPosition(new THREE.Vector3());
      const toSun = E.clone().negate().normalize();
      const side = new THREE.Vector3().crossVectors(toSun, up).normalize();
      if (show.kind === 'solar') {
        // From the Sun's side: the Moon's dark disk and its shadow sliding over the day side.
        pos.copy(E).addScaledVector(toSun, 2.1).addScaledVector(side, 0.75).addScaledVector(up, 0.45);
        target.copy(E).addScaledVector(toSun, 0.25);
      } else {
        // From just above Earth's night side, looking at the Moon as it enters the shadow.
        pos.copy(E).addScaledVector(toSun, -0.62).addScaledVector(side, 0.06).addScaledVector(up, 0.14);
        target.copy(M);
      }
    }
    // Ease in from wherever the camera was.
    const k = THREE.MathUtils.smoothstep(show.t, 0, 2);
    cam.position.lerpVectors(show.from.pos, pos, k);
    this.controls.target.lerpVectors(show.from.target, target, k);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.controls.target);
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
    if (this.show && e.type === 'wheel') this.endShow();
    if (this.tour.on && (this.tour.auto || e.type === 'wheel')) {
      this.stopTour();
      if (this.tour.auto) this.unfocus();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.idle = 0;
    this.stopTour();
    if (this.show) this.endShow();
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.interactive || this.zoomed || this.comparing || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    if (moved > 6 || performance.now() - this.downAt.t > 600) return; // that was a drag
    if (this.portal) return;
    if (this.hoveredIndex >= 0) this.focusPlanet(this.hoveredIndex);
    else if (this.wormholeHovered) this.enterWormhole();
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
    if (this.show) this.endShow(false);
    this.showTween?.kill();
    this.drift.reset();
    if (this.comparing) this.setCompare(false);
    this.controls.enabled = false;
    this.interactive = false;
    if (this.hoveredIndex >= 0) this.onHover(null);
    if (this.focusedIndex >= 0) this.onFocus(null);
    this.hoveredIndex = -1;
    this.focusedIndex = -1;
    this.setWormholeHover(false);
    this.portal = null;
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
    this.brightStars.dispose();
    this.drift.dispose();
    this.milkyWay.dispose();
    disposeObject(this.sky);
    disposeObject(this.group);
  }
}

/** Quintic ease (zero speed and acceleration at both ends). */
/** Cubic easing from 0 to 1 with slopes s0 at the start and s1 at the end. */
function hermite(x: number, s0: number, s1: number): number {
  return ((s0 + s1 - 2) * x + (3 - 2 * s0 - s1)) * x * x + s0 * x;
}

function smoothstep5(k: number): number {
  return k * k * k * (k * (k * 6 - 15) + 10);
}
