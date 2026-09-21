# Performance playbook (client, worker, server)

Status: reference. Audience: anyone touching performance-sensitive code, or
investigating a stall, hitch, or server bottleneck. For the save/resume design
specifically see `SaveResumeLongGames.md`; this document is the general "where
does the cost live and how do I prove it" guide.

---

## 1. Execution model (the mental model that matters)

OpenFrontIO has four places code runs, and the same function costs very
different things depending on which one it is in:

| Place                   | Thread                | Cadence                          | What a bad cost blocks   |
| ----------------------- | --------------------- | -------------------------------- | ------------------------ |
| `src/core/` simulation  | per-client Web Worker | 10 ticks/s (100 ms/tick)         | every client's sim       |
| `src/client/` rendering | main thread           | per frame (60 fps)               | input + rendering        |
| `src/client/` saves     | main thread           | autosave / checkpoint cadence    | input + rendering        |
| `src/server/`           | Node cluster process  | per intent/turn/save, per client | all games on that worker |

Key consequences:

- **`src/core` is per-client and deterministic.** A cost added there runs on
  every player's machine. It must stay dependency-free and deterministic (seeded
  PRNG, no floating-point where integers are expected). Core changes **must**
  include tests.
- **The server never simulates.** It relays intents, assembles turns, and
  persists saves. So server performance is about sockets, per-turn work, and
  disk, not game logic.
- **The main thread is precious.** Anything multi-millisecond on the main thread
  is a dropped frame or a frozen UI. Move work to the worker or make it async.

---

## 2. Cadences and constants worth memorising

| Thing                         | Value                                | Where                                                       |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| Tick rate                     | 10/s (100 ms)                        | `ClientEnv.turnIntervalMs`                                  |
| Periodic state hash           | every 10 ticks                       | `GameImpl.executeNextTick`                                  |
| Worker tick yield             | 32 ticks/drain (not a cap)           | `MAX_TICKS_BEFORE_YIELD`, `Worker.worker.ts`                |
| Client autosave               | 25 turns                             | `SAVE_EVERY_TURNS`, `SaveManager.ts`                        |
| Checkpoint capture            | 500 turns (≈50 s)                    | `CHECKPOINT_EVERY_TURNS`, `Checkpoint.ts`                   |
| Checkpoint version            | 2                                    | `CHECKPOINT_VERSION`, `Checkpoint.ts`                       |
| Server save trigger           | creator leaves, or graceful shutdown | `GameServer.handleClientDisconnect`, `GameManager.flushAll` |
| Save retention prune          | hourly                               | `SAVE_PRUNE_INTERVAL_MS`, `server/SaveStore.ts`             |
| WebSocket frame cap (inbound) | 1 MiB                                | `MAX_WEBSOCKET_PAYLOAD_BYTES`                               |
| Checkpoint plaintext cap      | 900 000 chars                        | `MAX_CHECKPOINT_TRANSFER_BYTES`                             |
| Checkpoint compressed cap     | 16 MiB                               | `MAX_CHECKPOINT_COMPRESSED_TRANSFER_BYTES`                  |
| Capture ceiling (map floor)   | 64 MiB                               | `MAX_CHECKPOINT_CAPTURE_BYTES`                              |
| Client save caps              | 30 saves / 64 MiB each / 512 MiB sum | `client/SaveStore.ts`                                       |
| Server retention              | 20/creator, 30 days, 2 GiB/shard     | `server/SaveStore.ts`                                       |

Turns and ticks are 1:1 (`elapsedGameSeconds = ticks / 10`).

---

## 3. Hot paths to think about before anything else

### Per tick (×10/s, ×every client) — the danger zone

- `GameImpl.executeNextTick` and every `Execution.tick`. An O(map) scan here is a
  permanent tax. **The cautionary tale:** `GameImpl.hash()` was briefly made to
  walk every owned tile of every player; it runs every 10 ticks, so it scanned
  millions of tiles **per second**. It is now an incremental, order-independent
  XOR checksum (`tileOwnershipChecksum`) maintained in `conquer`/`relinquish`.
- `PlayerExecution.tick` and `PlayerImpl.pruneTransient` run every tick per
  player — keep them O(window), not O(history).
- Pathfinding / spatial queries: the most allocation-sensitive code in `core`.

### Per frame (main thread)

- Pixi/WebGL layers, Lit re-renders, `player.borderTiles()` snapshots posted to
  the worker (`GameRunner.playerActions`). Avoid rebuilding large arrays per
  hover/frame.

### Per checkpoint (500 turns) and per save

- Worker: `GameImpl.checkpoint()` copies map state + entities; `postMessage`
  structured-clones it to the main thread (**no transfer list → a full copy**).
- Main thread: `SaveManager.persist` → IndexedDB; creator-only
  `ClientGameRunner.uploadCheckpoint` → `encodeCheckpointGzip` → transport.
- Server: `GameServer.persistSave` → `SaveStore.save` (head/meta rewrite, history
  append, **conditional** checkpoint sidecar). `acceptCheckpointWire` decodes
  every upload.

### Per message

- zbin encode/decode (`ZbinWire.ts`), per-message rate limiting, and JSON for
  HTTP. Frames stay under 1 MiB inbound.

---

## 4. Checkpoint/save cost model (measured baseline)

Measured with synthetic map-sized checkpoints on a desktop-class machine; treat
as a lower bound (browser `btoa` is slower than Node's `Buffer`).

| Map             | capture (worker) | worker→main clone | encode+gzip (creator) |
| --------------- | ---------------- | ----------------- | --------------------- |
| World 2000×1000 | ~2 ms            | ~18 ms            | ~41 ms (was ~347 ms)  |
| Sol 3236×1904   | ~4 ms            | ~24 ms            | ~? (was ~710 ms)      |
| Giant 4108×1948 | ~10 ms           | ~47 ms            | ~112 ms (was ~957 ms) |

At the 500-turn cadence that is a ~0.1–0.3% duty cycle per client; the old
200-turn cadence plus base64-JSON encode was the source of the original
stutter. Storage itself is cheap now: the client checkpoint lives in a
write-on-change IndexedDB sidecar, and the server rewrites
`*.checkpoint.json.gz` only when its identity changes.

---

## 5. Rules of thumb (the hard-won ones)

1. **No O(map)/O(history) work in per-tick code.** Prefer incremental aggregates.
   If you must scan, do it at save/checkpoint time, not every tick.
2. **Check size before allocating.** Gate with `projectCheckpointBytes` before
   `encodeCheckpoint`; never build a 40 MB string only to discard it.
3. **Write big blobs on change, not on a timer.** Reference-compare the object
   (the provider hands out a stable reference between captures).
4. **Don't base64-JSON large binary.** gzip raw typed-array bytes with a small
   tagged-JSON header (`GZCP` in `CheckpointCodec.ts`). Base64 inflates 33% and
   the JSON string build is the dominant cost.
5. **Structured clone is a copy.** `postMessage` without a transfer list copies
   every typed array worker→main. Use transferables where the buffer is owned.
6. **Derive, don't serialize — but respect order.** Owned tiles are rebuilt from
   `map.state` (checkpoint v2) instead of being serialized; consumers that used
   tile-set insertion order were made order-independent. Always audit iteration
   order before removing a serialized collection.
7. **Determinism is sacred in `src/core`.** Seeded PRNG, no external deps,
   integer math where the code expects it, and tests for every change. A "faster"
   reordering that changes PRNG draws is a desync bug.
8. **Bound transients.** `pruneTransient` keeps per-player histories `O(window)`;
   server retention keeps disk bounded; `dropOversizedCheckpoint` keeps a save
   under the per-save cap.
9. **Move expensive sync work off the main thread.** The worker already holds the
   checkpoint; encoding/gzip belongs there, not on the render thread.
10. **A cheaper cadence is a valid fix.** Halving frequency (e.g. 200→500 turns)
    is often safer than micro-optimising a hot path.

---

## 6. How to measure

- **Repo perf harness:** `npm run perf` (all), `perf:game`, `perf:client`,
  `perf:client-mem`, `perf:client-tick` (see `tests/perf/`).
- **Isolated synthetic benchmark** (fast, no game boot): reproduce the data
  shape and time the primitives. The checkpoint measurement used a small
  throwaway script that builds a map-sized `Uint8Array`/`Uint16Array`, then times
  `slice()`, `structuredClone()`, `JSON.stringify(replacer)`, and `zlib.gzipSync`.
  Caveat: Node numbers are a lower bound; browser `btoa`/`CompressionStream`
  differ.
- **Correctness gate for every change:**
  `npx vitest run <file>`, `npx tsc --noEmit`, `npm run lint`.
- **Full-suite baseline discipline:** this environment has known, pre-existing
  failures (Node 22's experimental `localStorage` is undefined — see
  `testnotes.md`). Before blaming your change for a failure, `git stash` and
  confirm the same files fail on a clean tree.

### Runtime diagnostics

- Emit `console.info`/`console.warn` per unit of work (e.g.
  `listSavedLobbies: w0 → 3 save(s)` / `w0 → HTTP 401`) and surface a short
  human-readable line in the UI when something fails. Silent `catch → []` is a
  debugging trap.
- Server: log the hashed creator prefix + result count, and the reason a request
  failed. Never log raw persistent ids.

---

## 7. Checklist for a performance change

- [ ] Which context does it run in (worker / main / server), and at what cadence?
- [ ] Does the cost scale with map tiles, players, units, or game length?
- [ ] Can it be incremental, memoised, or deferred instead of recomputed?
- [ ] Does it allocate a large transient (string / typed array)? Is the cheap
      check before the allocation?
- [ ] Does it preserve determinism (core) and exact round-trip (codec/schema)?
- [ ] Measured before/after with a benchmark or perf script?
- [ ] `vitest` (targeted + related suites), `tsc --noEmit`, `npm run lint`?
- [ ] Compared the full-suite failures against a clean baseline?

---

## 8. Gotchas and traps

- **History contains a feature and its revert.** Check `git log --oneline` for
  `Revert "..."` before assuming a feature is active (e.g. "checkpoint v2" was
  reverted and later re-landed).
- **`postMessage` copies** unless you pass a transfer list; the checkpoint path
  does not transfer.
- **`bytesToBase64` is not free** — it concatenates `String.fromCharCode(...)` in
  chunks and calls `btoa`. Never call it on the map; only on the small compressed
  result.
- **Browser gzip is async, but the JSON base64 before it is sync** — that sync
  string build is what froze the host.
- **Dev worker routing:** the Vite proxy only defines `/w0` and `/w1`
  (`vite.config.ts`). With `NUM_WORKERS > 2`, a game can be minted on `/w2`+, but
  the browser cannot reach `/w2/api/...` (the SPA fallback returns 200 HTML), so
  listing/resume silently fail. Keep the two in sync.
- **`SAVE_DIR` unwritable/unmounted** loses server saves on every restart; see
  `DEPLOYMENT.md`.
- **`src/client/SaveStore.ts` vs `src/server/SaveStore.ts`** are different
  modules with similar names; know which one you are in.
- **The worker yields, the main thread does not.** A 40 ms main-thread block is a
  visible hitch even though the worker stayed responsive.

---

## 9. File map (jump straight to the right file)

Purpose: skip repo-wide search. Start with 9.1, then jump to the group you need.
Paths are repo-relative.

### 9.1 Start here

- `src/core/game/GameImpl.ts` — sim state; `executeNextTick`, `hash` +
  `tileOwnershipChecksum`, `checkpoint`/`restoreFromCheckpoint`/`rebuildPlayerTiles`,
  `conquer`/`relinquish`.
- `src/core/worker/Worker.worker.ts` — sim loop, tick yield
  (`MAX_TICKS_BEFORE_YIELD`), `maybeSendCheckpoint`.
- `src/core/CheckpointCodec.ts` — checkpoint serialization: tagged-JSON +
  binary `GZCP` gzip, size projection, transfer/capture caps.
- `src/client/ClientGameRunner.ts` — main-thread game loop, `latestCheckpoint`,
  `uploadCheckpoint`, `beginCatchUp`, hash send.
- `src/client/SaveStore.ts` — client IndexedDB (saves / turns / checkpoints
  sidecar), caps, quota handling.
- `src/server/GameServer.ts` — turn loop, save trigger, checkpoint reassembly,
  `snapshot`.
- `src/server/SaveStore.ts` — server save layout, retention, conditional
  checkpoint sidecar.
- `docs/SaveResumeLongGames.md` — the save/resume design spec.

### 9.2 Core simulation

- `src/core/GameRunner.ts` — turn buffering/execution orchestration
  (`addTurns`, `pendingTurns`, checkpoint passthrough).
- `src/core/PseudoRandom.ts` — sfc32 PRNG; `state()`/`setState()`.
- `src/core/configuration/Config.ts` — `GameEnv` and config values (cooldowns,
  spawn turns).
- `src/core/game/Game.ts` — core interfaces (`Game`, `Player`, `Execution`,
  `Unit`) and the optional `checkpoint?` injection points.
- `src/core/game/GameMap.ts` — `terrain`/`state` typed arrays;
  `exportMapState`/`importMapState`, `ownerID`/`setOwnerID`.
- `src/core/game/PlayerImpl.ts` — player state; `checkpoint`/`restoreFromCheckpoint`,
  `pruneTransient`, `hash`, `tiles()`.
- `src/core/game/UnitImpl.ts` — units; checkpoint/restore, `hash`.
- `src/core/game/AttackImpl.ts`, `AllianceImpl.ts`, `AllianceRequestImpl.ts` —
  per-entity checkpoint/restore.
- `src/core/game/TileSet.ts` — compact **insertion-ordered** tile set; iteration
  order is part of determinism (see §5.6).
- `src/core/game/RailNetwork.ts` / `RailNetworkImpl.ts` — rail network checkpoint.
- `src/core/game/StatsImpl.ts` — deep-copied stats checkpoint.
- `src/core/game/DoomsdayClock.ts` — rot noise field (integer hashes).
- `src/core/game/WaterManager.ts` — **mutates terrain**, so terrain is not
  immutable across a game.

### 9.3 Checkpoint types, codec, schemas

- `src/core/Checkpoint.ts` — `GameCheckpoint`/`*Checkpoint` types,
  `CHECKPOINT_VERSION`, `CHECKPOINT_EVERY_TURNS`.
- `src/core/CheckpointCodec.ts` — codec + `projectCheckpointBytes` +
  `mapStateFits*` guards.
- `src/core/Schemas.ts` — zod intent/message/save schemas (`SavedLobby`,
  `SavedGame`) and their PII/size comments.
- `src/core/StatsSchemas.ts` — `AllPlayersStats`/`PlayerStats`.
- `src/core/ApiSchemas.ts` — API/JWT token payload.
- `src/core/ZbinWire.ts` — compact binary wire encode/decode.
- `src/core/Util.ts` — `simpleHash`, `toInt`, shared helpers.

### 9.4 Executions and pathfinding (checkpointed hot loops)

- `src/core/execution/ExecutionCheckpoints.ts` — `restoreExecution` switch:
  **every captured execution kind is registered here**.
- `src/core/execution/PlayerExecution.ts` — per-player per-tick
  (`pruneTransient`).
- `src/core/execution/AttackExecution.ts` — attack march (order-sensitive
  `handleDeadDefender`).
- `src/core/execution/DoomsdayClockExecution.ts` — rot; `LowestN` tie-breaking.
- `src/core/execution/nation/NationUtils.ts` — AI tile picks (order-sensitive
  `randTerritoryTile`).
- `src/core/execution/utils/FlatBinaryHeap.ts` — heap `snapshot`/`restore`
  (preserves dequeue tie order).
- `src/core/pathfinding/PathFinder.ts` — `WaterPathFinder` snapshot/restore.
- `src/core/pathfinding/PathFinderStepper.ts` — cached route snapshot.
- `src/core/pathfinding/PathFinder.Parabola.ts`,
  `PathFinder.Air.ts`, `PathfinderStagger.ts` — finder snapshots.
- `src/core/utilities/Line.ts` — bezier curve snapshot.

### 9.5 Worker boundary

- `src/core/worker/Worker.worker.ts` — sim loop, yield threshold, checkpoint
  emission, map loading.
- `src/core/worker/WorkerClient.ts` — main-thread worker handle, checkpoint
  callback, init/restore.
- `src/core/worker/WorkerMessages.ts` — worker message types (incl.
  `CheckpointMessage`).

### 9.6 Client main thread, saves, auth, transport

- `src/client/ClientGameRunner.ts` — game loop, checkpoint cache + upload,
  catch-up overlay.
- `src/client/SaveManager.ts` — autosave cadence, checkpoint provider.
- `src/client/SaveStore.ts` — IndexedDB v3 (`saves`/`meta`/`turns`/`checkpoints`),
  byte caps, quota eviction.
- `src/client/Api.ts` — `listSavedLobbies` (+ per-worker diagnostics),
  `createLobby`, `resumeSavedLobby`, `deleteSavedLobby`.
- `src/client/ClientEnv.ts` — `numWorkers`, `serverHttpBase`,
  `workerIndex`/`workerPath`.
- `src/client/Auth.ts` — `getPlayToken`, `userAuth`, local persistent id.
- `src/client/Transport.ts` — `sendCheckpoint`, `sendCheckpointChunk`, hash send.

### 9.7 Client UI / wiring

- `src/client/SavesModal.ts` — the saves window (server + local sections,
  diagnostics).
- `src/client/Main.ts` — modal router and `join-lobby` handling.
- `src/client/GameModeSelector.ts` — opens the saves modal.
- `src/client/HostLobbyModal.ts` — create-private-lobby flow.
- `src/client/LocalServer.ts` — solo/local resume path.
- `src/client/ResumeLoadingOverlay.ts` — hidden catch-up overlay.

### 9.8 Server and cluster

- `src/server/Server.ts` — cluster entry (master vs worker).
- `src/server/Master.ts` — forks workers, crash/restart, shutdown.
- `src/server/Worker.ts` — express routes (`/api/saves`, create/resume/delete),
  auth, join, save-store wiring, SIGINT/SIGTERM flush.
- `src/server/GameManager.ts` — game registry, `tick`, `restoreGame`, `flushAll`.
- `src/server/GameServer.ts` — turn loop, `handleClientDisconnect`,
  `scheduleSave`/`persistSave`/`flushSave`, checkpoint reassembly, `snapshot`.
- `src/server/SaveStore.ts` — filesystem/memory store, retention, conditional
  checkpoint sidecar, `list`.
- `src/server/Client.ts` — per-socket client (`persistentID`).
- `src/server/jwt.ts` — `verifyClientToken`.
- `src/server/ServerEnv.ts` — env access, `saveDir`/`saveWorkerDir`, worker index.
- `src/server/WorkerLobbyService.ts`, `IPCBridgeSchema.ts` — master↔worker IPC.
- `src/server/telemetry/MatchTelemetryConfig.ts` — `MAX_WEBSOCKET_PAYLOAD_BYTES`.

### 9.9 Build / config / deploy

- `vite.config.ts` — dev proxy `/w0`/`/w1`, random-worker create proxy,
  `BOOTSTRAP_CONFIG` (`numWorkers`).
- `nginx.conf` — production `/wN` routing.
- `package.json` — scripts (`dev`, `test`, `perf:*`, `lint`, `format`).
- `tsconfig.json` — typecheck config.
- `DEPLOYMENT.md` — the `SAVE_DIR` volume requirement.
- `testnotes.md` — known environment-only test failures (read this before
  trusting a red suite).
- `CLAUDE.md` — repo conventions (commands, core determinism, i18n rule).

### 9.10 Tests and perf harness

- Harness: `tests/util/Setup.ts` (build a test game), `tests/util/utils.ts`
  (`executeTicks`), `tests/util/GameServerHarness.ts` (GameServer/mock sockets).
- Checkpoints: `tests/core/Checkpoint.test.ts`,
  `CheckpointCodec.test.ts`, `CheckpointProjectiles.test.ts`,
  `CheckpointRail.test.ts`, `CheckpointShips.test.ts`,
  `PlayerTransientPrune.test.ts`, `GameRunnerTurnBuffer.test.ts`,
  `pathfinding/PathFinderStepper.test.ts`.
- Saves: `tests/server/GameServerSave.test.ts`, `tests/server/SaveStore.test.ts`,
  `tests/SaveStore.test.ts`, `tests/SaveManager.test.ts`,
  `tests/ListSavedLobbies.test.ts`.
- PRNG: `tests/PseudoRandom.test.ts`.
- Perf scripts: `tests/perf/run-all.ts`, `tests/perf/fullgame/FullGamePerf.ts`,
  `tests/perf/client/ClientUpdatePerf.ts`, `ClientMemoryPerf.ts`,
  `ClientTickPerf.ts`.

### 9.11 Docs

- `docs/Performance.md` — this file.
- `docs/SaveResumeLongGames.md` — save/resume design and phased plan.
- `docs/Architecture.md` — system overview.
- `docs/API.md`, `docs/Auth.md` — HTTP API and auth flow.
- `docs/Maps.md`, `docs/MapCreation.md` — map pipeline (tile counts drive budgets).

---

## 10. Commands

```bash
npm run inst                 # deps (do NOT use npm install)
npm run dev                  # client + server, hot reload
npm test                     # all tests
npx vitest run <file>        # one file
npx tsc --noEmit             # types
npm run lint                 # oxlint + eslint
npm run format               # prettier
npm run perf:game            # full-game sim perf
npm run perf:client          # client update perf
npm run perf:client-mem      # client memory perf
```
