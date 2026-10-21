import type * as THREE from 'three';
import type { Planet } from '../../data/planets';

/** Shared pieces of the Solar System's shaders. */

/** Vertex shader of the Sun and the planets: object, world and Sun-direction varyings. */
export const PLANET_VERT = /* glsl */ `
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

/** Which branch of the planet shader a kind of body uses. */
export const KIND_INDEX = { rocky: 0, earth: 1, gas: 2, ice: 3 } as const;

/** A planet as the Solar System scene keeps it. */
export interface PlanetView {
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
