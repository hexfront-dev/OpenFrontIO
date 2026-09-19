import { TileRef } from "../../game/GameMap";

/**
 * Lightweight min-heap specialised for (priority:number, tile:TileRef) pairs.
 * - priorities stored in a contiguous Float32Array
 * - tiles stored in a parallel object array
 */
export class FlatBinaryHeap {
  /** parallel arrays: pri[ i ] is the priority of tiles[ i ] */
  private pri: Float32Array;
  private tiles: TileRef[];
  private len = 0; // current number of elements

  constructor(capacity = 1024) {
    this.pri = new Float32Array(capacity);
    this.tiles = new Array<TileRef>(capacity);
  }

  /** remove every element without reallocating */
  clear(): void {
    this.len = 0;
  }

  /** current heap size */
  size(): number {
    return this.len;
  }

  //insert tiles
  enqueue(tile: TileRef, priority: number): void {
    if (this.len === this.pri.length) this.grow(); // ensure space
    let i = this.len++;

    /* sift-up */
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (priority >= this.pri[parent]) break;
      this.pri[i] = this.pri[parent];
      this.tiles[i] = this.tiles[parent];
      i = parent;
    }
    this.pri[i] = priority;
    this.tiles[i] = tile;
  }

  /** remove and return the lowest-priority tile (no per-call allocation) */
  dequeue(): TileRef {
    if (this.len === 0) throw new Error("heap empty");

    const topTile = this.tiles[0];

    const lastPri = this.pri[--this.len];
    const lastTile = this.tiles[this.len];

    /* sift-down */
    let i = 0;
    while (true) {
      const left = (i << 1) + 1;
      if (left >= this.len) break;
      const right = left + 1;
      const child =
        right < this.len && this.pri[right] < this.pri[left] ? right : left;
      if (lastPri <= this.pri[child]) break;
      this.pri[i] = this.pri[child];
      this.tiles[i] = this.tiles[child];
      i = child;
    }
    this.pri[i] = lastPri;
    this.tiles[i] = lastTile;
    return topTile;
  }

  /** double the underlying storage */
  private grow(): void {
    const newCap = this.pri.length << 1;

    const newPri = new Float32Array(newCap);
    newPri.set(this.pri);
    this.pri = newPri;

    this.tiles.length = newCap;
  }

  /**
   * B2: raw snapshot of the live heap slots. The array layout is preserved
   * (rather than re-enqueueing) so equal-priority tie-breaking and hence
   * dequeue order are identical after a restore.
   */
  snapshot(): { priorities: number[]; tiles: TileRef[] } {
    return {
      priorities: Array.from(this.pri.subarray(0, this.len)),
      tiles: this.tiles.slice(0, this.len),
    };
  }

  /** B2: overwrite the heap from a snapshot() taken by the same build. */
  restore(snapshot: { priorities: number[]; tiles: TileRef[] }): void {
    const len = snapshot.tiles.length;
    if (this.pri.length < len) {
      this.pri = new Float32Array(len);
      this.tiles.length = len;
    }
    for (let i = 0; i < len; i++) {
      this.pri[i] = snapshot.priorities[i];
      this.tiles[i] = snapshot.tiles[i];
    }
    this.len = len;
  }
}
