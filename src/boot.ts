/** The static boot screen from index.html: progress while the app downloads, builds and compiles. */

export function setBoot(fraction: number, label?: string): void {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.style.setProperty('--p', String(Math.max(0, Math.min(1, fraction))));
  boot.classList.add('is-determinate');
  const text = boot.querySelector('.boot__label');
  if (label && text) text.textContent = label;
}

export function hideBoot(): void {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('is-done');
  window.setTimeout(() => boot.remove(), 900);
}

export function removeBoot(): void {
  document.getElementById('boot')?.remove();
}

/** Yields to the browser so the boot screen can repaint before heavy synchronous work. */
// rAF never fires in a background tab, so a timer guarantees we keep going there too.
export const nextFrame = () =>
  new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 60);
  });
