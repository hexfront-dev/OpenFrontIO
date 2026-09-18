import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GameView } from "../../src/client/view/GameView";
import {
  decodeRenderSnapshot,
  encodeRenderSnapshot,
} from "../../src/client/view/RenderSnapshot";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import {
  makeEmptyGu,
  makeGameView,
  makeNameViewData,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../util/viewStubs";

// Node 26 ships an experimental localStorage that is undefined without
// --localstorage-file; PlayerView reads UserSettings during construction. See
// testnotes.md (environment-only failures).
beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function populatedView(): GameView {
  const view = makeGameView({ width: 8, height: 8, myClientID: "client-a" });
  const gu = makeEmptyGu(7, {
    packedTileUpdates: new Uint32Array([0, 1, 1, 2, 2, 1]),
    updates: {
      ...makeEmptyGu(7).updates,
      [GameUpdateType.Player]: [makePlayerUpdate()],
      [GameUpdateType.Unit]: [makeUnitUpdate({ id: 1, ownerID: 1 })],
    },
    playerNameViewData: {
      "player-a": makeNameViewData({ x: 3, y: 4, size: 12 }),
    },
  });
  view.update(gu);
  return view;
}

describe("RenderSnapshot", () => {
  it("round-trips through encode/decode", () => {
    const snapshot = populatedView().exportRenderSnapshot();
    const decoded = decodeRenderSnapshot(encodeRenderSnapshot(snapshot));
    expect(decoded).toBeDefined();
    expect(decoded!.tick).toBe(snapshot.tick);
    expect(decoded!.width).toBe(snapshot.width);
    expect(decoded!.height).toBe(snapshot.height);
    expect(Array.from(decoded!.tileState)).toEqual(
      Array.from(snapshot.tileState),
    );
    expect(decoded!.players).toHaveLength(snapshot.players.length);
    expect(decoded!.units).toHaveLength(snapshot.units.length);
  });

  it("rejects a malformed payload", () => {
    expect(decodeRenderSnapshot("not json")).toBeUndefined();
    expect(decodeRenderSnapshot("{}")).toBeUndefined();
    expect(
      decodeRenderSnapshot(
        JSON.stringify({
          v: 1,
          tick: 0,
          w: 4,
          h: 4,
          tiles: "",
          players: [],
          units: [],
          names: [],
        }),
      ),
    ).toBeUndefined();
  });

  it("applies into a fresh view and reproduces the render state", () => {
    const source = populatedView();
    source.refreshFrame();
    const snapshot = source.exportRenderSnapshot();
    const decoded = decodeRenderSnapshot(encodeRenderSnapshot(snapshot))!;

    const target = makeGameView({
      width: 8,
      height: 8,
      myClientID: "client-a",
    });
    target.applyRenderSnapshot(decoded);

    const a = source.frameData();
    const b = target.frameData();
    expect(Array.from(b.tileState)).toEqual(Array.from(a.tileState));
    expect(b.tick).toBe(snapshot.tick);
    expect(b.inSpawnPhase).toBe(a.inSpawnPhase);
    expect(b.players.size).toBe(a.players.size);
    expect(b.units.size).toBe(a.units.size);
    expect(b.names.size).toBe(a.names.size);
    expect(b.names.get("player-a")).toEqual(a.names.get("player-a"));

    const sourcePlayer = source.players().find((p) => p.id() === "player-a");
    const targetPlayer = target.players().find((p) => p.id() === "player-a");
    expect(targetPlayer?.smallID()).toBe(sourcePlayer?.smallID());
    expect(targetPlayer?.state.gold).toBe(sourcePlayer?.state.gold);
    expect(targetPlayer?.state.troops).toBe(sourcePlayer?.state.troops);
  });
});
