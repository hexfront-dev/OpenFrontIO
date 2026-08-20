import { Execution, Game, Player, WarShips } from "../game/Game";
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
    // Get water component of new TargetTile for connectivity check
    const newPatrolTileWaterComponent = mg.getWaterComponent(this.position);
    // Cache warship list and build a lookup map — avoids repeated iteration
    const warshipMap = new Map(
      this.owner.units(...WarShips.types).map((u) => [u.id(), u]),
    );
    // Deduplicate ids so each warship is only moved once
    const dedupedIds = [...new Set(this.unitIds)];
    const fleetFormation = this.computeFormation(dedupedIds.length);

    let idx = 0;
    for (const unitId of dedupedIds) {
      const warship = warshipMap.get(unitId);
      if (!warship) {
        console.warn(`MoveWarshipExecution: warship ${unitId} not found`);
        continue;
      }
      if (!warship.isActive()) {
        console.warn(`MoveWarshipExecution: warship ${unitId} is not active`);
        continue;
      }
      // Do not update the warship's patrolTile if it is in a different Water Component
      if (!mg.hasWaterComponent(warship.tile(), newPatrolTileWaterComponent!)) {
        continue;
      }

      const offset = fleetFormation[idx++] ?? { dx: 0, dy: 0 };
      const x = mg.x(this.position) + offset.dx;
      const y = mg.y(this.position) + offset.dy;
      const formationTile = mg.isValidCoord(x, y) && mg.isWater(mg.ref(x, y))
        ? mg.ref(x, y)
        : this.position;

      warship.updateWarshipState({
        patrolTile: formationTile,
      });
      warship.setTargetTile(undefined);
    }
  }

  /**
   * Spread warships in a grid around the target point.
   * For 1 ship: center. For 2: side by side. For 3+: grid layout.
   */
  private computeFormation(count: number): { dx: number; dy: number }[] {
    if (count <= 1) return [{ dx: 0, dy: 0 }];
    const offsets: { dx: number; dy: number }[] = [];
    const gridSize = Math.ceil(Math.sqrt(count));
    const half = Math.floor(gridSize / 2);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / gridSize) - half;
      const col = (i % gridSize) - half;
      offsets.push({ dx: col, dy: row });
    }
    return offsets;
}


  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
