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
  /** Starts straight from the previous view, without fading through black. */
  readonly seamless?: boolean;
  /** Takes the pointer (and wheel) for its own camera and clicks. */
  readonly interactive?: boolean;
  /** The pointer is over something clickable. */
  readonly wantsPointer?: boolean;
  /** Esc / N: the scene leaves on its own terms; returns true when it has handled it. */
  requestExit?(): boolean;
  /** The info card's close button. */
  closeCard?(): void;
}

/** An info card with free-form rows (planets use their own fixed set). */
export interface CardInfo {
  kicker: string;
  name: string;
  rows: [string, string][];
  fact: string;
}

export const CURIOUS = [
  { name: 'nucleo', title: 'Перші 3 хвилини', sub: 'Як з’явилися ядра гелію' },
  { name: 'supernova', title: 'Наднова', sub: 'Звідки в нас залізо й кисень' },
  { name: 'moon', title: 'Народження Місяця', sub: 'Зіткнення з Теєю' },
  { name: 'pulsar', title: 'Пульсар', sub: 'Нейтронна зоря-маяк' },
] as const;

/** The menu's scenes, plus «Гаргантюа», reached only through the wormhole near Saturn. */
export type CuriousName = (typeof CURIOUS)[number]['name'] | 'gargantua';
