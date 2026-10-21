import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NOISE, globalUniforms } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CardInfo, CuriousScene } from './curious';
import { decimal, lang } from '../i18n';
import { Glow, createStarfield, disposeObject, lerp, smooth } from './util';

/** World units per astronomical unit, and seconds of scene per day. */
const AU = 100;
const DAY = 2;
/**
 * The seven planets (b…h): orbit (AU), radius (Earths), period (days), and a guess at a look:
 * the inner two hot and hazy, then rock, then the temperate three (e, f, g), then ice.
 */
const PLANETS = [
  { name: 'b', a: 0.0115, r: 1.12, p: 1.51, color: [0.78, 0.62, 0.45], ice: 0, water: 0, temp: 400, note: 1046.5,
    fact: 'Найближча до зорі й гаряча: телескоп «Джеймс Вебб» не знайшов у неї помітної атмосфери.' },
  { name: 'c', a: 0.0158, r: 1.1, p: 2.42, color: [0.72, 0.6, 0.5], ice: 0, water: 0, temp: 341, note: 880,
    fact: 'Майже як Земля за розміром, але густої атмосфери з вуглекислого газу, як у Венери, «Вебб» у неї не побачив.' },
  { name: 'd', a: 0.0223, r: 0.79, p: 4.05, color: [0.66, 0.5, 0.38], ice: 0, water: 0.15, temp: 288, note: 784,
    fact: 'На внутрішньому краю зони води: тут може бути і пекло, і океан — поки невідомо.' },
  { name: 'e', a: 0.0293, r: 0.92, p: 6.1, color: [0.45, 0.5, 0.42], ice: 0.15, water: 0.55, temp: 251, note: 659.3,
    fact: 'Найкращий у системі кандидат на рідку воду: розміром і теплом вона найближча до Землі.' },
  { name: 'f', a: 0.0385, r: 1.05, p: 9.21, color: [0.55, 0.6, 0.66], ice: 0.45, water: 0.4, temp: 219, note: 587.3,
    fact: 'Холодніша: можливо, під кригою в неї ховається океан, як на супутниках Юпітера.' },
  { name: 'g', a: 0.0469, r: 1.13, p: 12.35, color: [0.62, 0.68, 0.74], ice: 0.6, water: 0.25, temp: 198, note: 523.3,
    fact: 'Найбільша в системі, на зовнішньому краю зони, де ще може бути рідка вода.' },
  { name: 'h', a: 0.0619, r: 0.76, p: 18.77, color: [0.8, 0.84, 0.88], ice: 0.9, water: 0, temp: 173, note: 440,
    fact: 'Найдальша й одна з найменших: найімовірніше, крижаний світ.' },
];
const STAR_INFO: CardInfo = {
  kicker: 'Червоний карлик · 40 світлових років',
  name: 'TRAPPIST-1',
  rows: [
    ['Маса', '9 % маси Сонця'],
    ['Розмір', 'трохи більший за Юпітер'],
    ['Температура', '≈ 2 300 °C — удвічі холодніша за Сонце'],
    ['Вік', '≈ 7,6 мільярда років'],
  ],
  fact: 'Періоди сусідніх планет співвідносяться майже як цілі числа (8:5, 5:3, 3:2…) — це резонансний ланцюжок; тут кожна планета дзвенить своєю нотою, завершуючи оберт.',
};
/** The camera's resting view when we pull back from a close-up. */
const OVERVIEW = { dist: 7.2, el: 0.5, az: 0.8 };
/** Where liquid water could be (AU), roughly: e, f and g fall inside. */
const HZ = [0.025, 0.05];

/**
 * «TRAPPIST-1»: a cool red dwarf 40 light-years away and its seven Earth-sized planets, all
 * closer to their star than Mercury is to the Sun, three in the zone where water could stay
 * liquid. Orbits and years are to scale with each other (a day here is two seconds). The
 * planets keep one face to the star, as such close planets do.
 */
export class Trappist implements CuriousScene {
  readonly name = 'trappist' as const;
  readonly group = new THREE.Group();
  readonly interactive = true;
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};
  onHover: (name: string | null) => void = () => {};
  onFocus: (info: CardInfo | null) => void = () => {};

  private controls: OrbitControls;
  /** The viewer has taken the camera (dragged or scrolled): the opening flight stops. */
  private user = false;
  private hovered: number | 'star' | null = null;
  private focused: number | 'star' | null = null;
  private flight: { t: number; from: THREE.Vector3; fromTarget: THREE.Vector3 } | null = null;
  private lastFocus = new THREE.Vector3();
  private hits: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private downAt = { x: 0, y: 0, t: 0 };
  private turns: number[] = [];
  private tmp = new THREE.Vector3();

  private t = 0;
  private told = 0;
  private star: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private glow = new Glow('#ff7a3a', 4, 2.2);
  private flare = new Glow('#ffb48a', 3, 3);
  private zone: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private planets: { mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>; orbit: number; period: number; phase: number }[] = [];
  private orbitMat = new THREE.LineBasicMaterial({ color: 0xffb07a, transparent: true, opacity: 0, depthWrite: false });
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(private ctx: Ctx) {
    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uTime: globalUniforms.uTime, uFade: { value: 0 }, uFlare: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal);
            vView = cameraPosition - wp.xyz;
            vLocal = normalize(position);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          ${NOISE}
          uniform float uTime;
          uniform float uFade;
          uniform float uFlare;
          varying vec3 vN;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
            float cells = snoise(vLocal * 7.0 + uTime * 0.04) * 0.5 + 0.5;
            // Big dark spots: red dwarfs are heavily spotted.
            float spots = smoothstep(0.45, 0.7, snoise(vLocal * 2.2 + 4.0));
            vec3 col = mix(vec3(0.75, 0.16, 0.05), vec3(1.0, 0.45, 0.18), cells);
            col *= 1.0 - spots * 0.55;
            col *= mix(0.35, 1.0, pow(mu, 0.6));
            col += vec3(1.0, 0.6, 0.4) * uFlare * smoothstep(0.55, 0.9, snoise(vLocal * 3.0 + 9.0));
            gl_FragColor = vec4(col * 1.6 * uFade, 1.0);
          }`,
      }),
    );

    // The temperate zone: a faint green band, softest at its edges.
    this.zone = new THREE.Mesh(
      new THREE.RingGeometry(HZ[0] * AU, HZ[1] * AU, 160, 1),
      new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: 0 } },
        vertexShader: /* glsl */ `
          varying float vR;
          void main() {
            vR = length(position.xy);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uAlpha;
          varying float vR;
          void main() {
            float x = (vR - ${(HZ[0] * AU).toFixed(2)}) / ${((HZ[1] - HZ[0]) * AU).toFixed(2)};
            float a = smoothstep(0.0, 0.25, x) * (1.0 - smoothstep(0.75, 1.0, x));
            gl_FragColor = vec4(vec3(0.2, 0.7, 0.4) * a * uAlpha, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.zone.rotation.x = -Math.PI / 2;

    const planetMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uIce: { value: 0 }, uWater: { value: 0 }, uFade: { value: 0 }, uSeed: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vPos;
        varying vec3 vLocal;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vPos = wp.xyz;
          vLocal = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        uniform vec3 uColor;
        uniform float uIce;
        uniform float uWater;
        uniform float uFade;
        uniform float uSeed;
        varying vec3 vN;
        varying vec3 vPos;
        varying vec3 vLocal;
        void main() {
          vec3 n = normalize(vN);
          vec3 toStar = normalize(-vPos);
          float lit = max(dot(n, toStar), 0.0);
          float land = snoise(vLocal * 3.0 + uSeed) * 0.5 + snoise(vLocal * 7.0 + uSeed * 2.0) * 0.25;
          vec3 col = uColor * (0.75 + 0.5 * land);
          col = mix(col, vec3(0.08, 0.2, 0.35), uWater * smoothstep(0.05, -0.2, land));
          col = mix(col, vec3(0.88, 0.92, 0.96), uIce * smoothstep(0.55, 0.95, abs(vLocal.y) + land * 0.3 + (1.0 - lit) * 0.4));
          // Lit in the star's red light; the night side keeps a faint glow of its own.
          vec3 light = vec3(1.0, 0.55, 0.32) * lit * 1.6 + vec3(0.05, 0.02, 0.02);
          float rim = pow(1.0 - clamp(dot(n, normalize(cameraPosition - vPos)), 0.0, 1.0), 3.0);
          gl_FragColor = vec4((col * light + vec3(1.0, 0.5, 0.3) * rim * lit * 0.25) * uFade, 1.0);
        }`,
    });
    PLANETS.forEach((p, i) => {
      const mat = planetMat.clone();
      mat.uniforms.uColor.value.setRGB(p.color[0], p.color[1], p.color[2]);
      mat.uniforms.uIce.value = p.ice;
      mat.uniforms.uWater.value = p.water;
      mat.uniforms.uSeed.value = i * 3.7;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.19 * p.r, 32, 24), mat);
      this.planets.push({ mesh, orbit: p.a * AU, period: p.p * DAY, phase: i * 2.1 });
      // A generous invisible target for the pointer.
      const hit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.index = i;
      mesh.add(hit);
      this.hits.push(hit);
      const pts: number[] = [];
      for (let k = 0; k < 160; k++) {
        const a = (k / 160) * Math.PI * 2;
        pts.push(Math.cos(a) * p.a * AU, 0, Math.sin(a) * p.a * AU);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.group.add(mesh, new THREE.LineLoop(geo, this.orbitMat));
    });
    planetMat.dispose();
    const starHit = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    starHit.userData.index = -1;
    this.hits.push(starHit);
    this.stars = createStarfield(2600, 90, 77) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    this.group.add(this.stars, this.zone, this.glow, this.star, this.flare, starHit);

    this.controls = new OrbitControls(ctx.camera, ctx.canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.7;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 22;
  }

  /** The scene stays until the viewer leaves (Esc or «Назад»). */
  get finished(): boolean {
    return false;
  }

  get wantsPointer(): boolean {
    return this.hovered !== null;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.user = false;
    this.hovered = null;
    this.focused = null;
    this.flight = null;
    this.turns = this.planets.map((p) => Math.floor(p.phase / (Math.PI * 2)));
    this.controls.enabled = false;
    this.controls.target.set(0, 0, 0);
    const c = this.ctx.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('wheel', this.onWheel, { passive: true });
    this.update(0);
  }

  /** Esc: back out of a close-up first; from the overview, leave. */
  requestExit(): boolean {
    if (this.focused === null) return false;
    this.unfocus();
    return true;
  }

  closeCard(): void {
    this.unfocus();
  }

  private takeCamera(): void {
    if (this.user) return;
    this.user = true;
    this.controls.target.set(0, 0, 0);
    this.controls.enabled = true;
  }

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.takeCamera();
  };

  private onWheel = () => this.takeCamera();

  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 6 || performance.now() - this.downAt.t > 600) return;
    if (this.hovered !== null) this.focus(this.hovered);
    else if (this.focused !== null) this.unfocus();
  };

  private updateHover(): void {
    const { pointer, camera } = this.ctx;
    let h: number | 'star' | null = null;
    if (pointer.inside && !this.flight) {
      this.raycaster.setFromCamera(pointer.ndc, camera);
      const hit = this.raycaster.intersectObjects(this.hits, false)[0];
      if (hit) h = hit.object.userData.index === -1 ? 'star' : (hit.object.userData.index as number);
    }
    if (h === this.hovered) return;
    this.hovered = h;
    this.onHover(h === null ? null : h === 'star' ? 'TRAPPIST-1' : `TRAPPIST-1 ${PLANETS[h].name}`);
  }

  private info(i: number): CardInfo {
    const p = PLANETS[i];
    const zone = p.a >= HZ[0] && p.a <= HZ[1];
    return {
      kicker: zone ? 'Екзопланета · у зоні, де може бути вода' : 'Екзопланета · TRAPPIST-1',
      name: `TRAPPIST-1 ${p.name}`,
      // (Values with numbers are built in the page's language: the dictionary holds fixed text.)
      rows:
        lang === 'en'
          ? [
              ['Розмір', `${decimal(p.r, 2)} × Earth`],
              ['Рік', `${decimal(p.p, 2)} Earth days`],
              ['До зорі', `${decimal(p.a * 149.6, 1)} million km`],
              ['Температура', `≈ ${p.temp - 273} °C (without air)`],
            ]
          : [
              ['Розмір', `${decimal(p.r, 2)} × Земля`],
              ['Рік', `${decimal(p.p, 2)} земної доби`],
              ['До зорі', `${decimal(p.a * 149.6, 1)} млн км`],
              ['Температура', `≈ ${p.temp - 273} °C (без атмосфери)`],
            ],
      fact: p.fact,
    };
  }

  private focusPos(which: number | 'star', out: THREE.Vector3): THREE.Vector3 {
    return which === 'star' ? out.set(0, 0, 0) : out.copy(this.planets[which].mesh.position);
  }

  private focus(which: number | 'star'): void {
    this.takeCamera();
    this.focused = which;
    this.flight = { t: 0, from: this.ctx.camera.position.clone(), fromTarget: this.controls.target.clone() };
    this.onFocus(which === 'star' ? STAR_INFO : this.info(which));
  }

  private unfocus(): void {
    if (this.focused === null) return;
    this.focused = null;
    this.flight = { t: 0, from: this.ctx.camera.position.clone(), fromTarget: this.controls.target.clone() };
    this.onFocus(null);
  }

  /** Where the camera settles for the current focus (a planet: close, on its lit side). */
  private restPose(target: THREE.Vector3, pos: THREE.Vector3): void {
    if (this.focused === null) {
      target.set(0, 0, 0);
      pos.set(Math.cos(OVERVIEW.el) * Math.sin(OVERVIEW.az), Math.sin(OVERVIEW.el), Math.cos(OVERVIEW.el) * Math.cos(OVERVIEW.az)).multiplyScalar(OVERVIEW.dist);
      return;
    }
    this.focusPos(this.focused, target);
    if (this.focused === 'star') {
      pos.copy(this.flight ? this.flight.from : this.ctx.camera.position).normalize().multiplyScalar(2.6);
      return;
    }
    const r = 0.19 * PLANETS[this.focused].r;
    const out = this.tmp.copy(target).normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(out).normalize();
    pos.copy(target).addScaledVector(out, -r * 3.2).addScaledVector(side, r * 4.5).add(new THREE.Vector3(0, r * 2.2, 0));
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const captions: [number, string, number][] = [
      [0.8, 'TRAPPIST-1: червоний карлик за 40 світлових років', 4],
      [5.6, 'Довкола нього — сім планет завбільшки із Землю', 4],
      [10.4, 'Усі вони ближче до зорі, ніж Меркурій до Сонця', 4],
      [15.2, 'Три — у зоні, де може триматися рідка вода', 4],
      [20.2, 'Рік на найближчій планеті триває півтора дня', 4.2],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }
    const fade = smooth(0, 1.4, t);

    // A flare now and then (red dwarfs are restless).
    const f = Math.max(0, Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.2));
    const flare = Math.pow(f, 6);
    this.star.material.uniforms.uFade.value = fade;
    // (Opaque bodies faded right out would be black disks over the stars: hide them.)
    this.star.visible = fade > 0.01;
    this.star.material.uniforms.uFlare.value = flare;
    this.glow.intensity = fade * (0.85 + flare * 0.6);
    this.flare.intensity = fade * flare * 0.8;

    this.planets.forEach((p, i) => {
      const a = p.phase + (t / p.period) * Math.PI * 2;
      p.mesh.position.set(Math.cos(a) * p.orbit, 0, -Math.sin(a) * p.orbit);
      p.mesh.material.uniforms.uFade.value = fade;
      p.mesh.visible = fade > 0.01;
      // Tidally locked: one face always to the star.
      p.mesh.rotation.y = a;
      // Each completed orbit rings the planet's note: the resonant chain, made audible.
      const turn = Math.floor(a / (Math.PI * 2));
      if (turn > this.turns[i] && t > 1) this.ctx.audio.note(PLANETS[i].note, Math.cos(a) * 0.6, 0.05);
      this.turns[i] = turn;
    });
    this.orbitMat.opacity = 0.16 * fade;
    this.zone.material.uniforms.uAlpha.value = fade * smooth(14.6, 16.4, t) * 0.16;

    const cam = this.ctx.camera;
    cam.up.set(0, 1, 0);
    if (!this.user) {
      // The opening flight, until the viewer takes the camera.
      const dist = lerp(7.5, 5.2, smooth(8, 22, t));
      const el = THREE.MathUtils.degToRad(lerp(34, 14, smooth(6, 24, t)));
      const az = 0.8 + t * 0.07;
      cam.position.set(Math.cos(el) * Math.sin(az) * dist, Math.sin(el) * dist, Math.cos(el) * Math.cos(az) * dist);
      cam.lookAt(0, 0, 0);
    } else if (this.flight) {
      // Fly to the focus (it keeps moving, so aim at where it is now).
      this.flight.t = Math.min(1, this.flight.t + dt / 1.8);
      const k = this.flight.t * this.flight.t * (3 - 2 * this.flight.t);
      const target = new THREE.Vector3();
      const pos = new THREE.Vector3();
      this.restPose(target, pos);
      cam.position.lerpVectors(this.flight.from, pos, k);
      this.controls.target.lerpVectors(this.flight.fromTarget, target, k);
      cam.lookAt(this.controls.target);
      if (this.flight.t >= 1) {
        this.flight = null;
        if (this.focused !== null) this.focusPos(this.focused, this.lastFocus);
      }
    } else {
      // Ride along with a focused planet; the viewer can still orbit round it.
      if (this.focused !== null) {
        const P = this.focusPos(this.focused, this.tmp);
        cam.position.add(P.clone().sub(this.lastFocus));
        this.controls.target.copy(P);
        this.lastFocus.copy(P);
      }
      this.controls.update();
    }
    this.updateHover();
    this.glow.face(cam);
    this.flare.face(cam);
    this.stars.material.uniforms.uOpacity.value = 0.7 * fade;
    this.stars.position.copy(cam.position);
  }

  exit(): void {
    const c = this.ctx.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('wheel', this.onWheel);
    this.controls.enabled = false;
    if (this.hovered !== null) this.onHover(null);
    if (this.focused !== null) this.onFocus(null);
    this.hovered = null;
    this.focused = null;
  }

  dispose(): void {
    this.controls.dispose();
    disposeObject(this.group);
  }
}
