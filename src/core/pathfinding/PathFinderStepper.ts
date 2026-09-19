import {
  PathFinder,
  PathResult,
  PathStatus,
  SteppingPathFinder,
} from "./types";

export interface StepperConfig<T> {
  equals: (a: T, b: T) => boolean;
  distance?: (a: T, b: T) => number;
  preCheck?: (from: T, to: T) => PathResult<T> | null;
}

/**
 * B2: serializable form of a stepper's cached route. Capturing the live
 * `path`/`pathIndex`/`lastTo` is what makes a resume replays the suffix
 * identically: a fresh stepper that re-ran A* could pick a different
 * equal-cost route under the finder's tie-breaking, so re-`init()` is not
 * equivalent.
 */
export interface PathFinderStepperSnapshot<T> {
  path: T[] | Uint32Array | null;
  pathIndex: number;
  lastTo: T | null;
  /**
   * Snapshot of the wrapped finder when it carries mutable state that affects
   * future recomputes (e.g. `AirPathFinder`'s seed). Absent for stateless or
   * cache-only finders such as the shared water chain.
   */
  finder?: unknown;
}

/** A `PathFinder` whose mutable fields can be captured and replayed. */
export interface SnapshotablePathFinder {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

/**
 * PathFinderStepper - wraps a PathFinder and provides step-by-step traversal
 *
 * Handles path caching, invalidation, and incremental movement.
 * Generic over any PathFinder<T> implementation.
 */
export class PathFinderStepper<T> implements SteppingPathFinder<T> {
  // Numeric paths (TileRefs) are stored as a Uint32Array: steppers hold their
  // whole path for the unit's entire journey, and paths across large maps run
  // to thousands of nodes, so halving the per-node size matters in aggregate.
  private path: T[] | Uint32Array | null = null;
  private pathIndex = 0;
  private lastTo: T | null = null;

  constructor(
    private finder: PathFinder<T>,
    private config: StepperConfig<T> = { equals: (a, b) => a === b },
  ) {}

  /**
   * Get the next step on the path from `from` to `to`.
   * Returns PathResult with status and optional next node.
   */
  next(from: T, to: T, dist?: number): PathResult<T> {
    // Domain-specific pre-check (validation, cluster, etc.)
    if (this.config.preCheck) {
      const result = this.config.preCheck(from, to);
      if (result) return result;
    }

    if (this.config.equals(from, to)) {
      return { status: PathStatus.COMPLETE, node: to };
    }

    // Distance-based early exit
    if (dist !== undefined && dist > 0 && this.config.distance) {
      if (this.config.distance(from, to) <= dist) {
        return { status: PathStatus.COMPLETE, node: from };
      }
    }

    // Invalidate cache if destination changed
    if (this.lastTo === null || !this.config.equals(this.lastTo, to)) {
      this.path = null;
      this.pathIndex = 0;
      this.lastTo = to;
    }

    // Compute path if not cached
    if (this.path === null) {
      let path: T[] | null;
      try {
        path = this.finder.findPath(from, to);
      } catch (err) {
        console.error("PathFinder threw an error during findPath", err);
        return { status: PathStatus.NOT_FOUND };
      }

      if (path === null) {
        return { status: PathStatus.NOT_FOUND };
      }

      this.path =
        path.length > 0 && typeof path[0] === "number"
          ? new Uint32Array(path as number[])
          : path;
      this.pathIndex = 0;
      if (path.length > 0 && this.config.equals(path[0], from)) {
        this.pathIndex = 1;
      }
    }

    const expectedPos = this.path[this.pathIndex - 1] as T;
    if (this.pathIndex > 0 && !this.config.equals(from, expectedPos)) {
      this.invalidate();
      this.lastTo = to;
      return this.next(from, to, dist);
    }

    // Check if we've reached the end
    if (this.pathIndex >= this.path.length) {
      return { status: PathStatus.COMPLETE, node: to };
    }

    // Return next step
    const nextNode = this.path[this.pathIndex] as T;
    this.pathIndex++;

    return { status: PathStatus.NEXT, node: nextNode };
  }

  invalidate(): void {
    this.path = null;
    this.pathIndex = 0;
    this.lastTo = null;
  }

  /** B2: capture the cached route exactly as it stands right now. */
  snapshot(): PathFinderStepperSnapshot<T> {
    const finder = this.finder as Partial<SnapshotablePathFinder>;
    return {
      // Copy so the snapshot is immune to later mutation of the live path.
      path: this.path === null ? null : this.path.slice(),
      pathIndex: this.pathIndex,
      lastTo: this.lastTo,
      finder:
        typeof finder.snapshot === "function" ? finder.snapshot() : undefined,
    };
  }

  /** B2: install a route captured by snapshot() on this (or a fresh) stepper. */
  restore(snapshot: PathFinderStepperSnapshot<T>): void {
    if (snapshot.path === null) {
      this.path = null;
    } else if (snapshot.path instanceof Uint32Array) {
      // Re-copy on restore as well; checkpoints may be shared across games.
      this.path = new Uint32Array(snapshot.path);
    } else {
      this.path = snapshot.path.slice();
    }
    this.pathIndex = snapshot.pathIndex;
    this.lastTo = snapshot.lastTo;
    if (snapshot.finder !== undefined) {
      const finder = this.finder as Partial<SnapshotablePathFinder>;
      finder.restore?.(snapshot.finder);
    }
  }

  /**
   * Returns a copy of the active path beginning at the node most recently
   * returned by next(). Returns null when there is no active traversal.
   */
  pathAfterNext(): T[] | Uint32Array | null {
    if (this.path === null || this.pathIndex === 0) return null;
    return this.path.slice(this.pathIndex - 1);
  }

  /** Computes a one-shot route without changing the cached route. */
  findPath(from: T | T[], to: T): T[] | null {
    if (this.config.preCheck) {
      const fromArray = Array.isArray(from) ? from : [from];

      const allFailed = fromArray.every((f) => {
        const result = this.config.preCheck!(f, to);
        return result?.status === PathStatus.NOT_FOUND;
      });

      if (allFailed) {
        return null;
      }
    }

    return this.finder.findPath(from, to);
  }
}
