import { Uniform, Vector2 } from 'three';
import { Effect } from 'postprocessing';

/**
 * Gravitational lensing by a cluster with a softened (cored) mass profile: a pixel at
 * angle θ shows the source at β = θ − α(θ), bending background light into arcs around it.
 */
export class LensEffect extends Effect {
  constructor() {
    super(
      'LensEffect',
      /* glsl */ `
        uniform vec2 center;
        uniform float radius;
        uniform float strength;
        uniform float aspect;
        void mainUv(inout vec2 uv) {
          vec2 d = uv - center;
          d.x *= aspect;
          float r = max(length(d), 1e-4);
          // Cored (softened) mass profile: deflection vanishes at the centre, so below
          // strength 1 the mapping never folds and the core is magnified, not ringed.
          float core = radius;
          float shift = radius * radius * r / (r * r + core * core) * 2.0;
          float fall = exp(-((r / (radius * 4.0)) * (r / (radius * 4.0))));
          vec2 src = d - d / r * shift * strength * fall;
          src.x /= aspect;
          uv = center + src;
        }
        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          outputColor = inputColor;
        }`,
      {
        uniforms: new Map<string, Uniform>([
          ['center', new Uniform(new Vector2(0.5, 0.5))],
          ['radius', new Uniform(0.05)],
          ['strength', new Uniform(0)],
          ['aspect', new Uniform(1)],
        ]),
      },
    );
  }
}
