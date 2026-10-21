import type { Ctx } from '../app/types';
import { Gargantua } from './Gargantua';
import { Merger } from './Merger';
import { MoonBirth } from './MoonBirth';
import { Nucleosynthesis } from './Nucleosynthesis';
import { Pulsar } from './Pulsar';
import { SunFuture } from './SunFuture';
import { Supernova } from './Supernova';
import { Trappist } from './Trappist';

/**
 * The optional scenes («Для допитливих» and Gargantua), in a chunk of their own: none is
 * needed for the film, so the app loads them in the background once it has started (or when
 * one is asked for first).
 */
export function createOptionalScenes(ctx: Ctx) {
  return {
    menu: [
      new Nucleosynthesis(ctx),
      new Supernova(ctx),
      new MoonBirth(ctx),
      new Pulsar(ctx),
      new Merger(ctx),
      new SunFuture(ctx),
      new Trappist(ctx),
    ],
    gargantua: new Gargantua(ctx),
  };
}
