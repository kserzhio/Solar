import * as THREE from 'three';
import { NOISE, POINT_SIZE, gaussian } from '../shaders/common';

/**
 * Galaxy particles are stored in a local polar form (radius, start angle, height)
 * so the vertex shader can apply differential rotation every frame for free.
 * Colour slot: 0..1 blends core → arm colour, 2 marks a pink HII region.
 */
export interface GalaxyShape {
  kind: 'spiral' | 'elliptical';
  arms: number;
  wind: number;
  /** Thickness of an elliptical (0 = flat, 1 = round). */
  roundness: number;
}

export function sampleGalaxyParticle(rand: () => number, shape: GalaxyShape): [number, number, number, number] {
  if (shape.kind === 'elliptical') {
    const x = gaussian(rand) * 0.42;
    const y = gaussian(rand) * 0.42 * shape.roundness;
    const z = gaussian(rand) * 0.42;
    const r = Math.hypot(x, z);
    return [r, Math.atan2(z, x), y, Math.min(1, 0.15 + r * 0.6)];
  }
  if (rand() < 0.16) {
    // Bulge.
    const r = Math.abs(gaussian(rand)) * 0.12;
    return [r, rand() * Math.PI * 2, gaussian(rand) * 0.07, rand() * 0.15];
  }
  const r = Math.min(1.25, -Math.log(1 - rand() * 0.97) * 0.3 + 0.04);
  const arm = Math.floor(rand() * shape.arms);
  // Near the centre the log-spiral winds very tightly; smear it into the bulge
  // so the core doesn't show bright concentric stripes.
  const spread = gaussian(rand) * (0.11 + 0.22 * (1 - Math.min(1, r)) + Math.max(0, 0.24 - r) * 9);
  const angle = (arm / shape.arms) * Math.PI * 2 + Math.log(r / 0.04) * shape.wind + spread;
  const h = gaussian(rand) * 0.022 * (1.2 - r * 0.5);
  const inArm = Math.exp(-spread * spread * 18);
  const color = rand() < 0.035 * inArm ? 2 : Math.min(1, 0.25 + r * 0.55 + inArm * 0.3);
  return [r, angle, h, color];
}

/** Shared vertex logic: rotate local polar coordinates and orient them in world space. */
export const GALAXY_VERT_COMMON = /* glsl */ `
  ${NOISE}
  ${POINT_SIZE}
  vec3 rotateByQuat(vec3 v, vec4 q) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }
  vec3 galaxyLocal(vec4 local, float spin, float time) {
    float r = local.x;
    float ang = local.y - time * spin / (0.18 + r);
    return vec3(cos(ang) * r, local.z, sin(ang) * r);
  }
  vec3 galaxyColor(float slot, vec3 core, vec3 arm, vec3 hii) {
    return slot > 1.5 ? hii : mix(core, arm, slot);
  }
`;

export function randomQuaternion(rand: () => number): THREE.Quaternion {
  const axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, rand() * Math.PI);
}

/** The galaxy we dive into: identical shape in the cosmos overview and the close-up. */
export const HERO_SHAPE: GalaxyShape = { kind: 'spiral', arms: 2, wind: 1.9, roundness: 0 };
export const HERO_SPIN = 0.06;

/** Dust lane particle: hugs the inner edge of an arm (same polar layout as stars). */
export function sampleDustParticle(rand: () => number, shape: GalaxyShape): [number, number, number, number] {
  const r = 0.15 + Math.pow(rand(), 1.2) * 0.55;
  const arm = Math.floor(rand() * shape.arms);
  const angle = (arm / shape.arms) * Math.PI * 2 + Math.log(r / 0.04) * shape.wind - 0.2 + gaussian(rand) * 0.06;
  return [r, angle, gaussian(rand) * 0.008, rand()];
}
export const HERO_STAR_RADIUS = 0.42;

/** Local (unit-radius) position of the star we fly to: it sits on arm 0 and co-rotates. */
export function heroStarLocal(time: number, out: THREE.Vector3): THREE.Vector3 {
  const r = HERO_STAR_RADIUS;
  const ang = Math.log(r / 0.04) * HERO_SHAPE.wind - (time * HERO_SPIN) / (0.18 + r);
  return out.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
}
