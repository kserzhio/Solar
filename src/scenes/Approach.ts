import * as THREE from 'three';
import { config, particleCount } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, colorUniform, gaussian, globalUniforms, mulberry32 } from '../shaders/common';
import type { Ctx, SceneModule } from '../app/types';
import { ASTEROID_BELT, OVERVIEW, PLANETS, planetAngle } from '../data/planets';
import { GALAXY_VERT_COMMON, HERO_SHAPE, HERO_SPIN, heroStarLocal, sampleDustParticle, sampleGalaxyParticle } from './galaxy';
import { Glow, createDeepField, createStarfield, disposeObject, lerp, smooth } from './util';

/** Progress at which the dive into the arm hands over to the young star's disk. */
const CUT = 0.56;
/** Camera distance to the young Sun right after the hand-over (disk-scene units). */
const HANDOFF_DISTANCE = 7;

/**
 * Scene 4: the camera picks the hero spiral galaxy, dives into an arm towards one
 * star, and then watches its gas-dust disk pull together into planets.
 */
export class Approach implements SceneModule {
  readonly name = 'approach' as const;
  readonly group = new THREE.Group();
  active = false;

  /** progress 0..1 (timeline), diskFade for the hand-off to the solar system. */
  params = { progress: 0, diskFade: 1 };

  private galaxyGroup = new THREE.Group();
  private diskGroup = new THREE.Group();
  private galaxy: THREE.ShaderMaterial;
  private dust: THREE.ShaderMaterial;
  private disk: THREE.ShaderMaterial;
  private star = new Glow('#fff1d6', 1, 2.4);
  private youngSun = new Glow('#ffd59a', 9, 3.2);
  private starfield = createStarfield(4000, 300, 9);
  /** Far galaxies behind ours, left behind as we dive into it. */
  private deep = createDeepField(3200, 310, 11);
  private unregister: (() => void)[] = [];

  private startPos = new THREE.Vector3();
  private startLook = new THREE.Vector3();
  private curve = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]);
  private starWorld = new THREE.Vector3();
  private look = new THREE.Vector3();
  private v = new THREE.Vector3();
  private lastP = 0;
  /** Direction from the star to the camera in the last frame of the dive. */
  private cutDir = new THREE.Vector3(0, 0.3, 1).normalize();
  /** Angular size of the star's glow at the hand-over, so the young Sun can match it. */
  private cutAngular = 0.4;
  private pathDir = new THREE.Vector3();
  /** Short-lived flashes of planetesimals colliding while planets assemble. */
  private impacts: { glow: Glow; age: number; life: number; planet: number; offset: THREE.Vector3; size: number }[] = [];
  /** Gas envelopes accreting around the giant planets. */
  private envelopes: { glow: Glow; planet: number }[] = [];

  constructor(private ctx: Ctx) {
    this.galaxy = this.buildGalaxy();
    this.dust = this.buildDust();
    this.disk = this.buildDisk();
    this.buildGas();
    this.galaxyGroup.add(this.star);
    this.diskGroup.add(this.youngSun);
    for (let i = 0; i < 16; i++) {
      const glow = new Glow('#fff0d8', 1, 2.6);
      glow.intensity = 0;
      this.impacts.push({ glow, age: 1, life: 1, planet: 0, offset: new THREE.Vector3(), size: 1 });
      this.diskGroup.add(glow);
    }
    PLANETS.forEach((pl, i) => {
      if (pl.kind !== 'gas' && pl.kind !== 'ice') return;
      const glow = new Glow(pl.kind === 'gas' ? '#ffcf96' : '#9cc6ff', 1, 2.0);
      glow.intensity = 0;
      this.envelopes.push({ glow, planet: i });
      this.diskGroup.add(glow);
    });
    this.group.add(this.galaxyGroup, this.diskGroup, this.starfield, this.deep);
  }

  private buildGalaxy(): THREE.ShaderMaterial {
    const count = particleCount('heroGalaxy');
    const rand = mulberry32(77);
    const local = new Float32Array(count * 4);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      local.set(sampleGalaxyParticle(rand, HERO_SHAPE), i * 4);
      seeds.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    // Positions are computed in the shader; a dummy attribute keeps three.js happy.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aLocal', new THREE.BufferAttribute(local, 4));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${GALAXY_VERT_COMMON}
        uniform float uTime;
        uniform float uFade;
        uniform float uSpin;
        uniform float uRadius;
        uniform vec4 uQuat;
        uniform vec3 uCenter;
        uniform vec3 uCore;
        uniform vec3 uArm;
        uniform vec3 uHII;
        attribute vec4 aLocal;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec3 lp = galaxyLocal(aLocal, uSpin, uTime);
          lp += (aSeed.xyz - 0.5) * 0.012;
          vec3 p = uCenter + rotateByQuat(lp * uRadius, uQuat);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float viewZ = -mv.z;
          // Fade particles that rush past the lens so they don't smear the frame.
          float near = smoothstep(0.004 * uRadius, 0.035 * uRadius, viewZ);
          vColor = galaxyColor(aLocal.w, uCore, uArm, uHII) * (aLocal.x < 0.15 ? 1.15 : 1.0) * (0.6 + aSeed.w * 0.8);
          vAlpha = uFade * near * (aLocal.x < 0.15 ? 0.14 : 0.24);
          gl_PointSize = min(pointSize(0.0045 * uRadius * (0.5 + aSeed.z), viewZ, vAlpha), 14.0);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uTime: globalUniforms.uTime,
        uFade: { value: 0 },
        uSpin: { value: HERO_SPIN },
        uRadius: { value: this.ctx.hero.radius },
        uQuat: { value: new THREE.Vector4() },
        uCenter: { value: this.ctx.hero.position },
        uCore: colorUniform(config.colors.galaxyCore),
        uArm: colorUniform(config.colors.galaxyArm),
        uHII: colorUniform(config.colors.galaxyHII),
      },
    );
    const q = this.ctx.hero.quaternion;
    material.uniforms.uQuat.value.set(q.x, q.y, q.z, q.w);
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.galaxyGroup.add(points);
    this.unregister.push(this.ctx.quality.register(geometry, count));
    return material;
  }

  /** Dark dust lanes: normal-blended particles that absorb the starlight behind them. */
  private buildDust(): THREE.ShaderMaterial {
    const count = Math.round(16000 * config.particleScale);
    const rand = mulberry32(78);
    const local = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) local.set(sampleDustParticle(rand, HERO_SHAPE), i * 4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aLocal', new THREE.BufferAttribute(local, 4));
    const g = this.galaxy.uniforms;
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: g.uTime, uFade: { value: 0 }, uSpin: g.uSpin, uRadius: g.uRadius, uQuat: g.uQuat, uCenter: g.uCenter, uViewScale: globalUniforms.uViewScale },
      vertexShader: /* glsl */ `
        ${GALAXY_VERT_COMMON}
        uniform float uTime;
        uniform float uFade;
        uniform float uSpin;
        uniform float uRadius;
        uniform vec4 uQuat;
        uniform vec3 uCenter;
        attribute vec4 aLocal;
        varying float vAlpha;
        void main() {
          vec3 p = uCenter + rotateByQuat(galaxyLocal(aLocal, uSpin, uTime) * uRadius, uQuat);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float viewZ = -mv.z;
          vAlpha = uFade * 0.32 * smoothstep(0.01 * uRadius, 0.06 * uRadius, viewZ) * (0.5 + aLocal.w)
            * (1.0 - smoothstep(0.38, 0.7, aLocal.x)) * smoothstep(0.12, 0.2, aLocal.x);
          gl_PointSize = min(pointSize(0.016 * uRadius, viewZ, vAlpha), 22.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float d = dot(c, c);
          if (d > 1.0) discard;
          gl_FragColor = vec4(0.035, 0.022, 0.016, exp(-d * 3.0) * vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 1;
    this.galaxyGroup.add(points);
    this.unregister.push(this.ctx.quality.register(geometry, count));
    return material;
  }

  private buildDisk(): THREE.ShaderMaterial {
    const count = particleCount('disk');
    const rand = mulberry32(5);
    const info = new Float32Array(count * 4);
    const ball = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const weights = PLANETS.map((p) => 0.6 + p.size * 1.6);
    const total = weights.reduce((a, b) => a + b, 0);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const roll = rand();
      let kind = 0;
      if (roll < 0.74) {
        let r = rand() * total;
        let ring = 0;
        while ((r -= weights[ring]) > 0 && ring < PLANETS.length - 1) ring++;
        info.set([ring, (rand() * 2 - 1) * Math.PI, gaussian(rand), gaussian(rand)], i * 4);
        v.randomDirection().multiplyScalar(Math.cbrt(rand()));
        ball.set([v.x, v.y, v.z], i * 3);
      } else if (roll < 0.86) {
        kind = 1;
        info.set([lerp(ASTEROID_BELT.inner, ASTEROID_BELT.outer, rand()), rand() * Math.PI * 2, 0, gaussian(rand)], i * 4);
      } else {
        kind = 2;
        info.set([2.6 + Math.pow(rand(), 1.4) * 30, rand() * Math.PI * 2, 0, gaussian(rand)], i * 4);
      }
      seeds.set([rand(), rand(), rand(), kind], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geometry.setAttribute('aBall', new THREE.BufferAttribute(ball, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

    const n = PLANETS.length;
    const material = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform float uOrbit[${n}];
        uniform float uAngle[${n}];
        uniform float uSize[${n}];
        uniform float uClump;
        uniform float uFade;
        uniform float uClock;
        uniform vec3 uDisk;
        attribute vec4 aInfo;
        attribute vec3 aBall;
        attribute vec4 aSeed;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec3 p;
          float alpha = 1.0;
          float r;
          if (aSeed.w < 0.5) {
            int i = int(aInfo.x + 0.5);
            float R = uOrbit[i];
            float c = smoothstep(aSeed.x * 0.4, aSeed.x * 0.4 + 0.6, uClump);
            float ang = uAngle[i] + aInfo.y * (1.0 - c);
            float width = 0.35 + R * 0.05;
            r = R + aInfo.z * width * (1.0 - c);
            p = vec3(cos(ang) * r, aInfo.w * 0.12 * (1.0 - c), -sin(ang) * r);
            p += aBall * uSize[i] * c;
            alpha = 1.0 + c * 0.6;
          } else {
            r = aInfo.x;
            float ang = aInfo.y + uClock * 0.16 * pow(7.7 / r, 1.5);
            p = vec3(cos(ang) * r, aInfo.w * (0.05 + r * 0.012), -sin(ang) * r);
            alpha = aSeed.w < 1.5 ? mix(1.0, 0.55, uClump) : (1.0 - uClump * 0.9);
          }
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vec3 hot = vec3(1.0, 0.9, 0.72);
          vec3 icy = vec3(0.5, 0.6, 0.85);
          vec3 col = mix(hot, uDisk, smoothstep(2.5, 9.0, r));
          col = mix(col, icy, smoothstep(16.0, 28.0, r));
          vColor = col * (0.6 + aSeed.y * 0.8);
          vAlpha = uFade * alpha * (0.25 + aSeed.z * 0.4);
          gl_PointSize = pointSize(0.085 * (0.5 + aSeed.z), -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uOrbit: { value: PLANETS.map((p) => p.orbit) },
        uAngle: { value: PLANETS.map(() => 0) },
        uSize: { value: PLANETS.map((p) => p.size * 0.9) },
        uClump: { value: 0 },
        uFade: { value: 1 },
        uClock: { value: 0 },
        uDisk: colorUniform(config.colors.disk),
      },
    );
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.diskGroup.add(points);
    this.unregister.push(this.ctx.quality.register(geometry, count));
    return material;
  }

  /**
   * The glowing gas of the disk under the particles. Early on, spiral density waves run
   * through it; as the planets grow they carve dark gaps along their orbits, leaving the
   * concentric rings seen in ALMA images of young stars (HL Tauri).
   */
  private buildGas(): void {
    const u = this.disk.uniforms;
    const n = PLANETS.length;
    const geometry = new THREE.RingGeometry(0.9, 36, 320, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        // Shared with the particle disk, so the two always agree.
        uFade: u.uFade,
        uClump: u.uClump,
        uClock: u.uClock,
        uOrbit: u.uOrbit,
        uDisk: u.uDisk,
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        uniform float uFade;
        uniform float uClump;
        uniform float uClock;
        uniform float uOrbit[${n}];
        uniform vec3 uDisk;
        varying vec3 vPos;
        void main() {
          float r = length(vPos.xz);
          float ang = atan(-vPos.z, vPos.x);
          // Surface brightness: bright inner disk, a long dim tail, an inner hole by the star.
          float dens = smoothstep(0.9, 2.2, r) * (exp(-r / 6.5) * 0.85 + exp(-r / 22.0) * 0.25);
          // Thin out to nothing well before the mesh ends, so no rim shows.
          dens *= 1.0 - smoothstep(22.0, 34.0, r);
          // Spiral density waves while the disk is young and massive.
          float waves = (1.0 - smoothstep(0.15, 0.6, uClump));
          float arms = 0.5 + 0.5 * cos(2.0 * (ang + log(r) * 2.4) - uClock * 0.35);
          dens *= mix(1.0, 0.45 + arms * 1.1, waves * 0.7);
          // Gaps opened by the forming planets, with slightly brighter rims.
          float open = smoothstep(0.08, 0.55, uClump);
          float gap = 0.0;
          float rim = 0.0;
          for (int i = 0; i < ${n}; i++) {
            float R = uOrbit[i];
            float w = 0.16 + R * 0.03;
            float x = (r - R) / w;
            gap += exp(-x * x);
            float e = abs(x) - 1.9;
            rim += exp(-e * e * 2.5);
          }
          dens *= 1.0 - min(gap, 1.0) * open * 0.9;
          dens *= 1.0 + rim * open * 0.35;
          // Turbulent texture and faint ringlets.
          dens *= 0.78 + 0.32 * snoise(vec3(vPos.xz * 0.55, uClock * 0.04)) + 0.06 * sin(r * 9.0);
          vec3 hot = vec3(1.0, 0.86, 0.62);
          vec3 icy = vec3(0.42, 0.52, 0.8);
          vec3 col = mix(hot, uDisk, smoothstep(2.0, 8.0, r));
          col = mix(col, icy, smoothstep(14.0, 28.0, r));
          // Most of the gas is swept up or blown away as the planets finish forming.
          float k = dens * uFade * (1.0 - uClump * 0.6) * 0.55;
          gl_FragColor = vec4(col * max(k, 0.0), 1.0);
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0;
    this.diskGroup.add(mesh);
  }

  private heroWorld(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const { position, quaternion, radius } = this.ctx.hero;
    return out.copy(local).multiplyScalar(radius).applyQuaternion(quaternion).add(position);
  }

  enter(): void {
    this.params.progress = 0;
    this.params.diskFade = 1;
    this.lastP = 0;
    const cam = this.ctx.camera;
    this.startPos.copy(cam.position);
    cam.getWorldDirection(this.v);
    this.startLook.copy(cam.position).addScaledVector(this.v, cam.position.distanceTo(this.ctx.hero.position));
    this.galaxyGroup.visible = true;
    this.diskGroup.visible = false;
  }

  update(dt: number, time: number): void {
    const p = this.params.progress;
    const cam = this.ctx.camera;
    const reduced = this.ctx.reducedMotion;

    if (p < CUT) {
      this.galaxyGroup.visible = true;
      this.diskGroup.visible = false;
      const q = p / CUT;
      // The galaxy dissolves in the final moments of the dive, leaving only the star.
      const dissolve = 1 - smooth(0.86, 1.0, q);
      this.galaxy.uniforms.uFade.value = smooth(0, 0.12, q) * dissolve;
      this.dust.uniforms.uFade.value = smooth(0.04, 0.2, q) * dissolve;

      heroStarLocal(time, this.v);
      this.heroWorld(this.v, this.starWorld);
      const starLocal = this.v.clone();
      const outward = starLocal.clone().setY(0).normalize();
      const pts = this.curve.points;
      pts[0].copy(this.startPos);
      this.heroWorld(new THREE.Vector3(0.1, 1.35, 0.45), pts[1]);
      this.heroWorld(starLocal.clone().addScaledVector(outward, 0.06).add(new THREE.Vector3(0, 0.32, 0)), pts[2]);
      this.heroWorld(starLocal.clone().addScaledVector(outward, 0.004).add(new THREE.Vector3(0, 0.014, 0)), pts[3]);
      const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2.2) / 2;
      this.curve.getPoint(Math.min(e, 1), cam.position);

      this.look.lerpVectors(this.startLook, this.ctx.hero.position, smooth(0, 0.3, q));
      this.look.lerp(this.starWorld, smooth(0.35, 0.8, q));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);

      // The chosen star brightens as we close in.
      const d = cam.position.distanceTo(this.starWorld);
      const glowSize = Math.max(0.04, d * 0.09);
      this.star.position.copy(this.starWorld);
      this.star.face(cam);
      this.star.scale.setScalar(glowSize);
      this.star.intensity = lerp(0.2, reduced ? 1.4 : 2.2, smooth(0.4, 1, q)) + smooth(0.92, 1, q) * (reduced ? 0.3 : 0.8);
      // Remember the viewing direction and apparent size for a seamless hand-over.
      this.cutDir.subVectors(cam.position, this.starWorld).normalize();
      this.cutAngular = glowSize / Math.max(d, 1e-4);
      this.starfield.position.copy(cam.position);
      this.deep.position.copy(cam.position);
      this.deep.material.uniforms.uOpacity.value = 0.8 * (1 - smooth(0.25, 0.75, q));
      this.lastP = p;
      return;
    }

    // ---- Disk phase, around the young Sun at the origin.
    this.galaxyGroup.visible = false;
    this.deep.material.uniforms.uOpacity.value = 0;
    this.diskGroup.visible = true;
    const q = (p - CUT) / (1 - CUT);
    if (this.lastP < CUT) this.ctx.orbitClock.t = 0;
    this.lastP = p;
    this.ctx.orbitClock.t += dt;

    const u = this.disk.uniforms;
    u.uClump.value = smooth(0.25, 0.92, q);
    u.uFade.value = this.params.diskFade;
    u.uClock.value = this.ctx.orbitClock.t;
    const angles = u.uAngle.value as number[];
    PLANETS.forEach((pl, i) => (angles[i] = planetAngle(pl, this.ctx.orbitClock.t)));

    // The disk condenses out of the dark around the star we just reached.
    u.uFade.value = this.params.diskFade * smooth(0, 0.2, q);
    this.updateAccretion(dt, u.uClump.value as number, angles);

    // Seamless hand-over: the camera keeps the dive's viewing direction and stands at the
    // distance where the young Sun looks exactly as big as the star did. It drifts in a
    // little further, then cranes up and back to reveal the whole disk.
    const settle = smooth(0, 0.12, q);
    const pull = smooth(0.06, 1, q);
    const pullE = 1 - Math.pow(1 - pull, 2.6);
    const dist = lerp(HANDOFF_DISTANCE * (1 - 0.22 * settle), OVERVIEW.distance, pullE);
    const elev = lerp(0.2, OVERVIEW.elevation, pullE);
    const azim = lerp(0.9, OVERVIEW.azimuth, pullE);
    this.pathDir.set(Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev));
    const turn = smooth(0.04, 0.75, q);
    this.v.copy(this.cutDir).lerp(this.pathDir, turn).normalize();
    cam.position.copy(this.v).multiplyScalar(dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);

    // Young Sun: starts with the star's apparent size and brightness, then settles.
    const startScale = (this.cutAngular * HANDOFF_DISTANCE) / 9;
    const match = 1 - smooth(0, 0.3, q);
    this.youngSun.scale.setScalar(lerp(1, startScale, match));
    this.youngSun.intensity = lerp(1.4, reduced ? 1.7 : 3.0, match) * Math.max(0.25, this.params.diskFade);
    this.youngSun.face(cam);
    this.starfield.position.copy(cam.position);
  }

  /** Impacts and growing gas envelopes while the rings pull together into planets. */
  private updateAccretion(dt: number, clump: number, angles: number[]): void {
    const cam = this.ctx.camera;
    const fade = this.params.diskFade;
    const planetPos = (i: number, out: THREE.Vector3) =>
      out.set(Math.cos(angles[i]) * PLANETS[i].orbit, 0, -Math.sin(angles[i]) * PLANETS[i].orbit);

    // Collisions peak mid-way through the assembly.
    const rate = 22 * Math.sin(Math.PI * Math.min(1, clump)) * fade;
    if (dt > 0 && Math.random() < rate * dt) {
      const free = this.impacts.find((f) => f.age >= f.life);
      if (free) {
        const weights = PLANETS.map((p) => 0.5 + p.size);
        let r = Math.random() * weights.reduce((a, b) => a + b, 0);
        let idx = 0;
        while ((r -= weights[idx]) > 0 && idx < PLANETS.length - 1) idx++;
        const spread = (0.35 + PLANETS[idx].orbit * 0.05) * (1 - clump) + PLANETS[idx].size * 0.7;
        free.planet = idx;
        free.offset.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 2).multiplyScalar(spread);
        free.age = 0;
        free.life = 0.35 + Math.random() * 0.35;
        free.size = 1.3 + Math.random() * 1.6 + PLANETS[idx].size * 1.2;
      }
    }
    for (const f of this.impacts) {
      if (f.age >= f.life) {
        f.glow.intensity = 0;
        continue;
      }
      f.age += dt;
      const k = Math.min(1, f.age / f.life);
      planetPos(f.planet, f.glow.position).add(f.offset);
      f.glow.scale.setScalar(f.size * (0.6 + k * 0.6));
      f.glow.intensity = Math.pow(Math.sin(Math.PI * k), 0.6) * 2.2 * fade;
      f.glow.face(cam);
    }

    // Giants sweep up gas from the disk: soft halos swell as they assemble.
    for (const e of this.envelopes) {
      const pl = PLANETS[e.planet];
      planetPos(e.planet, e.glow.position);
      const grow = smooth(0.5, 0.95, clump);
      e.glow.scale.setScalar(pl.size * (3 + grow * 2.5));
      e.glow.intensity = grow * 0.45 * fade;
      e.glow.face(cam);
    }
  }

  exit(): void {}

  applyConfig(): void {
    const c = config.colors;
    this.galaxy.uniforms.uCore.value.set(c.galaxyCore);
    this.galaxy.uniforms.uArm.value.set(c.galaxyArm);
    this.galaxy.uniforms.uHII.value.set(c.galaxyHII);
    this.disk.uniforms.uDisk.value.set(c.disk);
  }

  dispose(): void {
    this.unregister.forEach((u) => u());
    disposeObject(this.group);
  }
}

export { CUT as APPROACH_CUT };
