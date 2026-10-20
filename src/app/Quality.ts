import type * as THREE from 'three';

interface Entry {
  geometry: THREE.BufferGeometry;
  count: number;
}

/**
 * Runtime quality scaler. Particle buffers are generated in random order, so
 * shrinking the draw range drops a uniform subset without rebuilding anything.
 */
export class Quality {
  factor = 1;
  private entries = new Set<Entry>();

  register(geometry: THREE.BufferGeometry, count: number): () => void {
    const entry = { geometry, count };
    this.entries.add(entry);
    this.apply(entry);
    return () => this.entries.delete(entry);
  }

  setFactor(factor: number): void {
    this.factor = factor;
    this.entries.forEach((e) => this.apply(e));
  }

  private apply(e: Entry): void {
    e.geometry.setDrawRange(0, Math.max(1, Math.floor(e.count * this.factor)));
  }
}
