import { CURIOUS } from '../scenes/curious';

/**
 * Dev-only smoke test of every scene (`__selfTest()` in the console, or open the page with
 * `?selftest`): plays through the film at key moments, every level of the cosmic zoom, each
 * «Для допитливих» scene and the trip to Gargantua and back. At each stop it checks for
 * shader programs that failed to compile, console errors, and frames gone black (a sign of
 * NaNs in a shader). Results go to the console and to a panel on the page.
 */

export interface SelfTestResult {
  name: string;
  ok: boolean;
  /** Mean brightness of a grid of samples, 0..255. */
  brightness: number;
  detail: string;
}

/** The app's internals the test drives (it is dev tooling, so it reaches past `private`). */
type AppInternals = any;

const sleep = () => new Promise((r) => setTimeout(r, 0));

export async function runSelfTest(app: AppInternals): Promise<SelfTestResult[]> {
  const w = window as unknown as { __tick: (s: number) => void; __goTo: (t: number) => number };
  const results: SelfTestResult[] = [];
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' ').slice(0, 240));
    consoleError(...args);
  };
  const renderer = app.ctx.renderer;
  const gl: WebGL2RenderingContext = renderer.getContext();
  const step = async (seconds: number) => {
    for (let s = 0; s < seconds; s += 0.25) {
      w.__tick(Math.min(0.25, seconds - s));
      await sleep();
    }
  };
  const until = async (done: () => boolean, max: number) => {
    for (let s = 0; s < max && !done(); s += 0.25) await step(0.25);
    return done();
  };
  const brightness = () => {
    app.frame(performance.now());
    const px = new Uint8Array(4);
    const { width, height } = gl.canvas;
    let sum = 0;
    let n = 0;
    for (let i = 1; i <= 7; i++) {
      for (let j = 1; j <= 7; j++) {
        gl.readPixels(Math.floor((width * i) / 8), Math.floor((height * j) / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        sum += (px[0] + px[1] + px[2]) / 3;
        n++;
      }
    }
    return sum / n;
  };
  const failedPrograms = () =>
    (renderer.info.programs ?? []).filter((p: { diagnostics?: { runnable: boolean } }) => p.diagnostics && !p.diagnostics.runnable).length;
  const check = (name: string, minBrightness = 0.3, extra = '') => {
    const before = errors.length;
    const b = brightness();
    const bad = failedPrograms();
    const newErrors = errors.slice(before);
    const problems = [
      bad ? `${bad} shader(s) failed` : '',
      b < minBrightness ? 'black frame' : '',
      newErrors.length ? `console: ${newErrors[0]}` : '',
      extra,
    ].filter(Boolean);
    results.push({ name, ok: problems.length === 0, brightness: Math.round(b * 10) / 10, detail: problems.join('; ') });
    errors.length = 0;
  };

  try {
    // ---- The film, at key moments.
    app.ctx.audio.cuesEnabled = false;
    const end = app.director.endTime as number;
    for (const t of [1, 4, 9, 16, 26, 38, 52, 70, 90, 115, 140, 170, 200]) {
      if (t >= end - 1) break;
      w.__goTo(t);
      check(`Фільм · ${t} с`, t < 4 ? 0.05 : 0.3);
    }
    app.ctx.audio.cuesEnabled = true;

    // ---- The Solar System.
    app.pauses.delete('user');
    const skip = app.skipToFinal();
    await step(4);
    await skip;
    await step(3);
    check('Сонячна система');

    // ---- The cosmic zoom, level by level, and home.
    const zoom = app.scenes.get('zoom');
    for (let k = 1; k <= 5; k++) {
      zoom.goTo(k);
      await step(4.5);
      check(`Зум · рівень ${k}`, 0.05);
    }
    zoom.goHome();
    const home = await until(() => zoom.z < 0.01, 20);
    check('Зум · додому', 0.3, home ? '' : 'did not get home');

    // ---- «Для допитливих».
    for (const c of CURIOUS) {
      void app.openCurious(c.name);
      await until(() => !app.busy, 5);
      await step(3);
      check(`Для допитливих · ${c.title}`, 0.05);
      void app.closeCurious();
      const back = await until(() => !app.curious && !app.busy, 6);
      if (!back) results.push({ name: `${c.title}: повернення`, ok: false, brightness: 0, detail: 'did not return' });
    }

    // ---- Through the wormhole to Gargantua and back.
    const solar = app.scenes.get('solar');
    const g = app.scenes.get('gargantua');
    solar.enterWormhole();
    const arrived = await until(() => app.curious?.name === 'gargantua' && g.phase === 'explore', 30);
    check('Гаргантюа · прибуття', 0.3, arrived ? '' : 'did not arrive');
    g.focus('hole');
    await step(3);
    check('Гаргантюа · діра зблизька');
    // Both looks of the hole (and back to the viewer's own choice).
    const look = g.look;
    g.setLook(look === 'film' ? 'physics' : 'film');
    await step(2.5);
    check(`Гаргантюа · ${look === 'film' ? 'як насправді' : 'як у кіно'}`);
    g.setLook(look);
    await step(2.5);
    g.focus(0);
    await step(3.5);
    check('Гаргантюа · Міллер');
    g.requestExit();
    await step(2.5);
    g.requestExit();
    const homeAgain = await until(() => !app.curious && !app.busy && !solar.portal, 30);
    check('Назад біля Сатурна', 0.3, homeAgain ? '' : 'did not come back');
  } catch (e) {
    results.push({ name: 'exception', ok: false, brightness: 0, detail: String(e) });
  } finally {
    console.error = consoleError;
    app.ctx.audio.cuesEnabled = true;
    app.pauses.add('user');
  }

  console.table(results);
  (window as unknown as { __selfTestResults: SelfTestResult[] }).__selfTestResults = results;
  show(results);
  return results;
}

function show(results: SelfTestResult[]): void {
  document.querySelector('.selftest')?.remove();
  const failed = results.filter((r) => !r.ok).length;
  const box = document.createElement('div');
  box.className = 'selftest';
  box.style.cssText =
    'position:fixed;left:16px;top:16px;z-index:9999;max-height:80vh;overflow:auto;padding:12px 16px;background:rgba(5,6,10,.92);' +
    'border:1px solid rgba(255,255,255,.15);font:12px/1.6 ui-monospace,monospace;color:#e9ecf5;';
  box.innerHTML =
    `<b style="color:${failed ? '#ff8a7a' : '#8af0a8'}">Самотест: ${results.length - failed}/${results.length} гаразд</b><br>` +
    results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name} <span style="opacity:.55">${r.brightness}${r.detail ? ' · ' + r.detail : ''}</span>`).join('<br>');
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}
