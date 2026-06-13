import { Execution, Game, Player, Unit } from "../game/Game";

export class BatchUpgradeStructureExecution implements Execution {
  private structure: Unit | undefined;
  private levelsUpgraded = 0;
  private ticksRemaining = 0;
  private active = true;

  constructor(
    private player: Player,
    private unitId: number,
    private count: number,
  ) {}

  init(mg: Game): void {
    this.structure = mg.unit(this.unitId);
    if (this.structure && this.structure.owner() !== this.player) {
      console.warn(`structure not owned by player`);
      this.structure = undefined;
    }

    if (this.structure === undefined) {
      console.warn(`structure is undefined`);
      this.active = false;
      return;
    }

    if (!this.player.canUpgradeUnit(this.structure)) {
      console.warn(
        `[BatchUpgradeStructureExecution] unit cannot be upgraded`,
      );
      this.active = false;
      return;
    }

    const info = mg.unitInfo(this.structure.type());
    const duration = info.constructionDuration ?? 0;

    for (let i = 0; i < this.count; i++) {
      if (!this.player.canUpgradeUnit(this.structure)) break;
      const cost = info.cost(mg, this.player);
      if (this.player.gold() < cost) break;
      this.player.upgradeUnit(this.structure);
      this.levelsUpgraded++;
    }

    if (this.levelsUpgraded === 0) {
      this.active = false;
      return;
    }

    if (duration > 0) {
      this.structure.setUnderConstruction(true);
      this.ticksRemaining = this.levelsUpgraded * duration;
    } else {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    if (this.ticksRemaining > 0) {
      this.ticksRemaining -= ticks;
      return;
    }
    if (this.structure) {
      this.structure.setUnderConstruction(false);
    }
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
