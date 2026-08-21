import {
  Execution,
  Game,
  Player,
  Unit,
  UnitType,
  WarShips,
} from "../game/Game";
import { TileRef } from "../game/GameMap";

export class MoveWarshipExecution implements Execution {
  constructor(
    private readonly owner: Player,
    private readonly unitIds: number[],
    private readonly position: TileRef,
  ) {}

  init(mg: Game, _ticks: number): void {
    if (!mg.isValidRef(this.position)) {
      console.warn(`MoveWarshipExecution: position ${this.position} not valid`);
      return;
    }
    // Cache warship list and build a lookup map — avoids repeated iteration
    const warshipMap = new Map(
      this.owner.units(...WarShips.types).map((u) => [u.id(), u]),
    );
    // Deduplicate ids so each warship is only moved once
    const dedupedIds = [...new Set(this.unitIds)];

    const ships: Unit[] = [];
    for (const unitId of dedupedIds) {
      const warship = warshipMap.get(unitId);
      if (!warship || !warship.isActive()) continue;
      ships.push(warship);
    }

    if (ships.length === 0) return;

    const formation = this.computeFormation(ships);
    const fleetMoveRate = this.computeFleetMoveRate(ships);

    for (const warship of ships) {
      const offset = formation.get(warship.id()) ?? { dx: 0, dy: 0 };
      const x = mg.x(this.position) + offset.dx;
      const y = mg.y(this.position) + offset.dy;
      const formationTile =
        mg.isValidCoord(x, y) && mg.isWater(mg.ref(x, y))
          ? mg.ref(x, y)
          : this.position;

      warship.updateWarshipState({
        patrolTile: formationTile,
        fleetMoveRate,
      });
      warship.setTargetTile(undefined);
    }
  }

  /**
   * Assign each ship a compact, evenly-spaced grid slot with missile ships
   * (MissileShip + MissileDefenseShip) placed in the center.
   */
  private computeFormation(
    ships: Unit[],
  ): Map<number, { dx: number; dy: number }> {
    const spacing = 5;

    // Core ships (missile / missile-defense) take the innermost slots.
    const ordered = [...ships].sort((a, b) => {
      const aCore = isCoreShip(a.type());
      const bCore = isCoreShip(b.type());
      if (aCore === bCore) return 0;
      return aCore ? -1 : 1;
    });

    // Generate a square grid and sort by distance from center so the
    // innermost slots are assigned first.
    const gridSize = Math.ceil(Math.sqrt(ships.length));
    const half = Math.floor(gridSize / 2);
    const offsets: { dx: number; dy: number }[] = [];
    for (let i = 0; i < gridSize * gridSize; i++) {
      const row = Math.floor(i / gridSize) - half;
      const col = (i % gridSize) - half;
      offsets.push({ dx: col * spacing, dy: row * spacing });
    }
    offsets.sort(
      (a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy),
    );

    const result = new Map<number, { dx: number; dy: number }>();
    ordered.forEach((ship, i) => result.set(ship.id(), offsets[i]));
    return result;
  }

  /** Missile ships move every other tick; warships every tick. A fleet takes the slowest rate. */
  private computeFleetMoveRate(ships: Unit[]): number {
    return Math.max(
      ...ships.map((s) => (s.type() === UnitType.Warship ? 1 : 2)),
    );
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

function isCoreShip(type: UnitType): boolean {
  return type === UnitType.MissileShip || type === UnitType.MissileDefenseShip;
}
