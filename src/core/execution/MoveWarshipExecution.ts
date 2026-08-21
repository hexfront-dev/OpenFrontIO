import { Execution, Game, Player, Unit, WarShips } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { assignFleetFormation } from "./FleetFormation";

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

    assignFleetFormation(mg, ships, this.position);
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
