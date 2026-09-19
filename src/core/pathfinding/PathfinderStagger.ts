import { WaterPathFinder } from "./PathFinder";

/**
 * B2: the per-ship pathfinder rebuild stagger is a process-global counter, not
 * per-execution state. It decides how many ticks a ship keeps using its cached
 * route after the water graph changes (a water nuke), so it must round-trip
 * through a checkpoint: a fresh process would otherwise hand new ships a
 * different stagger than the run being resumed, changing when they switch to
 * the new graph and therefore where they are on the intervening ticks.
 */
export class PathfinderStagger {
  private value = 0;

  constructor(private readonly spread: number) {}

  /** Next stagger slot in `[0, spread)`, advancing the counter. */
  next(): number {
    return this.value++ % this.spread;
  }

  snapshot(): number {
    return this.value;
  }

  restore(value: number): void {
    this.value = value;
  }
}

export const tradeShipStagger = new PathfinderStagger(
  WaterPathFinder.STAGGER_SPREAD,
);
export const transportShipStagger = new PathfinderStagger(
  WaterPathFinder.STAGGER_SPREAD,
);
