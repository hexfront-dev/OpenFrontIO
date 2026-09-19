import { TrainStationExecutionCheckpoint } from "../../src/core/Checkpoint";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { TrainExecution } from "../../src/core/execution/TrainExecution";
import { TrainStationExecution } from "../../src/core/execution/TrainStationExecution";
import { WinCheckExecution } from "../../src/core/execution/WinCheckExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { Railroad } from "../../src/core/game/Railroad";
import { TrainStation } from "../../src/core/game/TrainStation";
import { GameID } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

const gameID: GameID = "checkpoint_rail";

interface BuiltGame {
  game: GameImpl;
  alphaId: string;
}

/**
 * A single spawned human on the fully deterministic `plains` map, matching the
 * ships checkpoint tests: the same builder always produces the same game.
 */
async function buildBase(): Promise<BuiltGame> {
  const game = (await setup("plains", {
    infiniteGold: true,
    instantBuild: true,
    infiniteTroops: true,
  })) as GameImpl;

  const alpha = new PlayerInfo(
    "alpha",
    PlayerType.Human,
    "client_alpha",
    "alpha_id",
  );
  game.addPlayer(alpha);

  game.addExecution(
    new SpawnExecution(gameID, game.player(alpha.id).info(), game.ref(0, 0)),
  );
  executeTicks(game, 2);
  game.addExecution(new WinCheckExecution());

  return { game, alphaId: alpha.id };
}

/**
 * Builds three city stations in a line (tiles 0, 2 and 4) joined by two
 * railroads, then adds a train running A -> C. Ownership is taken first so
 * PlayerExecution does not delete the cities.
 */
function buildRailway(game: GameImpl, playerId: string): void {
  const player = game.player(playerId);
  for (let tile = 0; tile <= 6; tile++) {
    player.conquer(tile);
  }

  const stations = [0, 2, 4].map(
    (tile) => new TrainStation(game, player.buildUnit(UnitType.City, tile, {})),
  );

  const net = game.railNetwork();
  const stationManager = net.stationManager();
  stations.forEach((station) => stationManager.addStation(station));

  const link = (
    a: TrainStation,
    b: TrainStation,
    tiles: number[],
    id: number,
  ) => {
    const railroad = new Railroad(a, b, tiles, id);
    a.addRailroad(railroad);
    b.addRailroad(railroad);
  };
  link(stations[0], stations[1], [0, 1, 2], 1);
  link(stations[1], stations[2], [2, 3, 4], 2);

  net.recomputeClusters();
  game.addExecution(
    new TrainExecution(net, player, stations[0], stations[2], 1),
  );
}

function drainHashes(game: Game, ticks: number): number[] {
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const updates = game.executeNextTick();
    for (const update of updates[GameUpdateType.Hash]) {
      hashes.push(update.hash);
    }
  }
  return hashes;
}

describe("B2 rail checkpoints", () => {
  test("captures a connected rail network instead of refusing", async () => {
    const { game, alphaId } = await buildBase();
    buildRailway(game, alphaId);
    executeTicks(game, 3);

    const stationManager = game.railNetwork().stationManager();
    expect(stationManager.getAll().size).toBe(3);

    const checkpoint = game.checkpoint();
    // The pre-B2 guard refused whenever more than one station existed.
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.railNetwork).toBeDefined();
    expect(checkpoint!.railNetwork!.stations).toHaveLength(3);
    expect(checkpoint!.railNetwork!.railroads).toHaveLength(2);
  });

  test("restores a live train and rail network, replaying the suffix identically", async () => {
    const { game: original, alphaId } = await buildBase();
    buildRailway(original, alphaId);

    // Two ticks: the execution initializes on the first, spawns the train and
    // moves it into the middle railroad (A->B) on the second.
    executeTicks(original, 3);
    expect(original.units(UnitType.Train).length).toBeGreaterThan(0);

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.railNetwork).toBeDefined();

    const expectedHashes = drainHashes(original, 30);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildBase();
    restored.restoreFromCheckpoint(checkpoint!);

    // Rail network rebuilt from the checkpoint, not from construction events.
    const restoredStations = restored.railNetwork().stationManager();
    expect(restoredStations.getAll().size).toBe(3);
    for (const station of checkpoint!.railNetwork!.stations) {
      const rebuilt = restoredStations.getById(station.id);
      expect(rebuilt).toBeDefined();
      expect(rebuilt!.unit.id()).toBe(station.unitId);
      expect(rebuilt!.getRailroads().size).toBeGreaterThan(0);
    }
    expect(restored.units(UnitType.Train).length).toBeGreaterThan(0);

    const actualHashes = drainHashes(restored, 30);
    expect(actualHashes).toEqual(expectedHashes);
  });

  test("checkpoints a station execution's station and PRNG", async () => {
    const { game, alphaId } = await buildBase();
    const player = game.player(alphaId);
    for (let tile = 0; tile <= 6; tile++) {
      player.conquer(tile);
    }
    const factory = player.buildUnit(UnitType.Factory, 0, {});
    game.addExecution(new TrainStationExecution(factory, true));
    executeTicks(game, 2);

    const checkpoint = game.checkpoint();
    expect(checkpoint).toBeDefined();
    const execCp = checkpoint!.executions.find(
      (e) => e.kind === "train_station",
    );
    expect(execCp).toBeDefined();
    const data = execCp!.data as TrainStationExecutionCheckpoint;
    expect(data.stationId).not.toBeNull();
    expect(data.random).not.toBeNull();

    const { game: restored } = await buildBase();
    restored.restoreFromCheckpoint(checkpoint!);

    const rebuilt = restored
      .railNetwork()
      .stationManager()
      .getById(data.stationId!);
    expect(rebuilt).toBeDefined();
    expect(rebuilt!.unit.id()).toBe(factory.id());
    expect(restored.unit(factory.id())!.hasTrainStation()).toBe(true);
  });
});
