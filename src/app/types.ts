import type * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Quality } from './Quality';

export type SceneName = 'singularity' | 'bang' | 'plasma' | 'cosmos' | 'approach' | 'solar' | 'zoom' | 'nucleo' | 'supernova' | 'moon' | 'pulsar' | 'gargantua';

export interface Pointer {
  /** Normalised device coordinates, -1..1. */
  ndc: THREE.Vector2;
  /** CSS pixels. */
  x: number;
  y: number;
  inside: boolean;
}

export interface Ctx {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  audio: AudioEngine;
  quality: Quality;
  pointer: Pointer;
  reducedMotion: boolean;
  /** Shared orbital clock so the protoplanetary disk hands planets to the solar system in place. */
  orbitClock: { t: number };
  /** Hero galaxy placement, shared by the cosmos and approach scenes. */
  hero: { position: THREE.Vector3; quaternion: THREE.Quaternion; radius: number };
  /** Gravitational lens request for this frame (screen UV centre, radius in screen heights). */
  lens: { center: THREE.Vector2; radius: number; strength: number };
  /** Depth-of-field request for this frame (world units; amount 0 = off). */
  dof: { distance: number; range: number; amount: number };
}

/**
 * Every scene is a self-contained module. The scene manager adds `group` to the
 * world on enter and removes it on exit; the GSAP master timeline decides when.
 */
export interface SceneModule {
  readonly name: SceneName;
  readonly group: THREE.Group;
  active: boolean;
  enter(): void;
  update(dt: number, time: number): void;
  exit(): void;
  applyConfig?(): void;
  dispose?(): void;
}
