export type DeviceCheck =
  | { ok: true }
  | { ok: false; reason: 'mobile' | 'webgl' };

export const MIN_WIDTH = 1024;

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Desktop-only gate. Runs before Three.js is loaded so the stub opens instantly.
 * Screen size uses the longer side: a laptop with OS scaling (e.g. 1366px at 150%)
 * reports fewer than 1024 CSS px in one dimension but is still a desktop.
 */
export function detectDevice(): DeviceCheck {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // Some embedded/hidden contexts report a 0×0 screen; fall back to the window then.
  const screenWidth =
    Math.max(window.screen.width, window.screen.height) || Math.max(window.innerWidth, window.innerHeight);
  if (coarse || screenWidth < MIN_WIDTH) return { ok: false, reason: 'mobile' };
  if (!hasWebGL2()) return { ok: false, reason: 'webgl' };
  return { ok: true };
}
