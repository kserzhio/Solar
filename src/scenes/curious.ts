import type { SceneModule } from '../app/types';

/**
 * «Для допитливих»: short optional scenes outside the main film, started from the
 * final Solar System and returning to it in the same state.
 */
export interface CuriousScene extends SceneModule {
  readonly name: CuriousName;
  /** True once the scene has played to its end (the app then fades back). */
  readonly finished: boolean;
  onCaption: (text: string, hold: number) => void;
  onFlash: () => void;
}

export const CURIOUS = [
  { name: 'nucleo', title: 'Перші 3 хвилини', sub: 'Як з’явилися ядра гелію' },
  { name: 'supernova', title: 'Наднова', sub: 'Звідки в нас залізо й кисень' },
  { name: 'moon', title: 'Народження Місяця', sub: 'Зіткнення з Теєю' },
] as const;

export type CuriousName = (typeof CURIOUS)[number]['name'];
