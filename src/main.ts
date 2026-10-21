import './styles.css';
import { detectDevice } from './device';
import { showStub } from './stub';
import { localizePage, nextFrame, removeBoot, setBoot } from './boot';

const root = document.getElementById('root')!;
localizePage();
const device = detectDevice();

async function boot(): Promise<void> {
  setBoot(0.08, 'Завантаження…');
  // Three.js and all scenes live in a separate chunk that only desktops download.
  const { App } = await import('./app/App');
  setBoot(0.3, 'Народжуються частинки…');
  await nextFrame();
  new App(root).start();
}

if (device.ok) {
  boot().catch((err) => {
    console.error(err);
    removeBoot();
    showStub(root, 'webgl');
  });
} else {
  removeBoot();
  showStub(root, device.reason);
}
