import { Uniform, Vector3 } from 'three';
import { Effect } from 'postprocessing';

/** Lift / gamma / gain colour grading with saturation and contrast around mid-grey. */
export class GradeEffect extends Effect {
  constructor() {
    super(
      'GradeEffect',
      /* glsl */ `
        uniform vec3 lift;
        uniform vec3 gamma;
        uniform vec3 gain;
        uniform float saturation;
        uniform float contrast;
        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          vec3 c = max(inputColor.rgb, 0.0);
          c = c * gain + lift * (1.0 - min(c, 1.0));
          c = pow(max(c, 0.0), 1.0 / gamma);
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, saturation);
          c = 0.18 * pow(max(c, 0.0) / 0.18, vec3(contrast));
          outputColor = vec4(c, inputColor.a);
        }`,
      {
        uniforms: new Map<string, Uniform>([
          ['lift', new Uniform(new Vector3(0, 0, 0))],
          ['gamma', new Uniform(new Vector3(1, 1, 1))],
          ['gain', new Uniform(new Vector3(1, 1, 1))],
          ['saturation', new Uniform(1)],
          ['contrast', new Uniform(1)],
        ]),
      },
    );
  }
}

export interface Grade {
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  saturation: number;
  contrast: number;
}

/**
 * One look per scene, following the "temperature" of the universe: cool and quiet
 * before the bang, hot and dense in the plasma, teal-and-amber in the cosmos.
 */
export const GRADES = {
  intro: { lift: [0, 0.0008, 0.003], gamma: [1, 1, 1.02], gain: [0.97, 0.99, 1.04], saturation: 0.9, contrast: 1.03 },
  bang: { lift: [0.0015, 0.0008, 0], gamma: [1.02, 1, 0.97], gain: [1.05, 1, 0.9], saturation: 1.05, contrast: 1.05 },
  plasma: { lift: [0.003, 0.0008, 0], gamma: [1.03, 1, 0.95], gain: [1.06, 0.98, 0.86], saturation: 1.12, contrast: 1.08 },
  cosmos: { lift: [0, 0.0018, 0.005], gamma: [1, 1, 1], gain: [1.05, 1, 0.95], saturation: 1.14, contrast: 1.07 },
  approach: { lift: [0.0008, 0.001, 0.0035], gamma: [1.01, 1, 0.99], gain: [1.05, 1, 0.94], saturation: 1.08, contrast: 1.06 },
  solar: { lift: [0, 0.0008, 0.0025], gamma: [1, 1, 1], gain: [1.03, 1, 0.97], saturation: 1.05, contrast: 1.04 },
} satisfies Record<string, Grade>;

export type GradeName = keyof typeof GRADES;
