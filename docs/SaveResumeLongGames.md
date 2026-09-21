# Safe saving & resume for the longest private-lobby games

Status: design / proposal. No behavior changes are made by this document.
Audience: anyone touching `src/core/Checkpoint*`, `src/core/GameRunner.ts`,
`src/client/SaveManager.ts`, `src/client/ClientGameRunner.ts`,
`src/server/GameServer.ts`, `src/server/SaveStore.ts`.

This document (a) states exactly how private-lobby saves work today, (b) derives
the longest game the rules allow and what the save artifacts look like at that
length, and (c) lays out a phased plan to make saving and resuming safe at that
length on desktop and mobile clients and on the shared game server.

---

## 1. Goal and non-goals

**Goal.** A private, creator-owned multiplayer game can be saved and resumed
safely at the maximum length the game rules permit, on the largest maps, without
data loss, desync, unbounded memory/disk growth, or an unjoinable resume.

"Safe" means all of:

1. **Correctness** — a resumed game is bit-identical to an uninterrupted game.
   Checkpoints are an optimization and must never be required for correctness.
2. **Bounded resources** — client RAM, server RAM, server disk, and transfer
   sizes stay within budgets for the whole game and for the sum of all saves.
3. **No cliff** — a resume that cannot use a checkpoint still works and does not
   have to deliver or replay the entire history in one blocking operation.

**Non-goals.** Public/matchmade games are still not persisted. Lobby listing,
admin-bot routes, and cosmetic/stat archival are out of scope.

---

## 2. How saves work today (private lobbies)

### 2.1 Authority model

The server never simulates. Every client runs the deterministic core
(`src/core/`) in a Web Worker. A game is reproducible from `GameStartInfo` plus
the ordered intent log (`turns`) — i.e. `PartialGameRecord`. So a save is:
`GameStartInfo` + dense `turns[]`, optionally plus a `GameCheckpoint` so resume
replays only the suffix instead of turn 0.

### 2.2 Artifacts

| Layer                                 | Shape                                                                                        | Where                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| `SavedLobby` / `SavedLobbyHeadSchema` | config, seats (PII), stage, `gameStartInfo`, `turns`, `numTurns`, `checkpoint?`, `gitCommit` | `src/core/Schemas.ts`         |
| `SavedGame` / `SavedGameHeadSchema`   | client-local mirror of a save                                                                | `src/core/Schemas.ts`         |
| `GameCheckpoint`                      | full authoritative core state                                                                | `src/core/Checkpoint.ts`      |
| tagged-JSON codec                     | bigint/typed-array tags for wire/store                                                       | `src/core/CheckpointCodec.ts` |

_PII rule:_ `persistentID`/`publicId` live only in `SavedLobby` (server) and never
cross to a browser; `claimableSeats` exposes `{clientID, username, claimed}`.

### 2.3 Server store layout (`src/server/SaveStore.ts`)

Per game, under a per-shard directory (`workerIndex(gameID)`):

```
<id>.head.json          small mutable head; rewritten each save (plain JSON)
<id>.meta.json          listing row; never decompressed
<id>.history.gz         append-only; one JSON turn per line, one gzip member per append
<id>.checkpoint.json.gz gzip(tagged-JSON checkpoint); rewritten each save when present
<id>.json.gz            legacy single-blob, read-only fallback
```

`load` clamps history to `head.numTurns`, so a half-written append is harmless.
IDs are validated with `GAME_ID_REGEX`.

### 2.4 Cadence and cost

- Server `endTurn()` pushes each turn and, every `SAVE_EVERY_TURNS = 25`,
  calls `scheduleSave(true)` (`GameServer.ts:1679`). `force` bypasses
  `SAVE_MIN_INTERVAL_MS = 3000`; the only throttle is single-in-flight
  de-duplication (`GameServer.ts:516-566`).
- `SaveStore.save(snapshot, fromTurn)` validates/encodes only the head and turns
  `>= fromTurn`, appends the delta to `history.gz`, rewrites `head.json` and
  `meta.json`, and — whenever `snapshot.checkpoint !== undefined` — re-gzips and
  rewrites `checkpoint.json.gz` **even if the checkpoint did not change**.
- Client `SaveManager` records turns and persists every `SAVE_EVERY_TURNS = 25`
  (`SaveManager.ts:12`), plus on `pagehide`/`visibilitychange`, appending only
  the delta to IndexedDB (`openfront-saves` v2, stores `saves`/`meta`/`turns`).
  `MAX_SAVES = 30` caps the **number** of saves, not bytes.

### 2.5 Checkpoint capture and transport

- Worker captures at `CHECKPOINT_EVERY_TURNS = 200`
  (`Worker.worker.ts:159-175`) by calling `GameImpl.checkpoint()`, which returns
  `undefined` (→ full-replay fallback) if any live execution cannot serialize.
- `GameImpl.checkpoint()` (`GameImpl.ts:1482`) copies every player, unit, attack,
  alliance, the whole `map` and `miniMap` state, stats, counters and executions.
- `GameCheckpoint.ticks` semantics: a checkpoint at tick T covers turns `[0,T)`.
- The lobby **creator's** client volunteers the blob:
  `ClientGameRunner.uploadCheckpoint` → `encodeCheckpoint` (tagged JSON, base64
  for typed arrays) → `Transport.sendCheckpoint` → server
  `handleClientCheckpoint` (`GameServer.ts:1102`), accepted only if private +
  creator + `<= MAX_CHECKPOINT_TRANSFER_BYTES` (900 000 chars) + decodes +
  `0 <= ticks <= turns.length` + not older than the held one.
- On resume, `GameServer.sendStartGameMsg` (`GameServer.ts:1603`) sends the
  checkpoint plus turns `checkpoint.ticks..end`; otherwise it sends the whole
  history from `lastTurn`. Client `beginCatchUp` hides the replay off-screen.
- Old/foreign checkpoints are dropped (`decodeCheckpoint` + `isGameCheckpoint`,
  `gitCommit` match), which is the fail-safe to full replay.

---

## 3. How long can a game be?

Length is bounded by **game rules**, not by the save system.

| Limit                                 | Value                   | Source                                      |
| ------------------------------------- | ----------------------- | ------------------------------------------- |
| Spawn phase (private FFA, non-random) | 300 turns               | `Config.numSpawnPhaseTurns()`               |
| Hard winner cutoff                    | 170 min of game time    | `WinCheckExecution.HARD_TIME_LIMIT_SECONDS` |
| Tick rate                             | 10 ticks/s              | `elapsedGameSeconds = ticks/10`             |
| Server wall-clock kill                | 3 h from `durationBase` | `GameServer.ts:157,1807`                    |

`durationBase` is reset to `Date.now()` on restore (`GameServer.ts:351`), so the
3 h wall clock is **per session**, while game time (`ticks`, `startTick`) is
preserved by the checkpoint (`GameImpl.ts:1565-1566`). The win check therefore
fires at 170 min of _game_ time regardless of how many times the save is resumed.

**Maximum turns = 300 + 170·60·10 = 102 300 turns** (≈ 2 h 50 m of game time).
A custom `maxTimerValue` can only shorten this. So "longest game" is a fixed,
computable number: **~102 k turns**, and every design budget below is sized for
it.

---

## 4. Artifact sizes at maximum length

### 4.1 The checkpoint floor is the map, not the game length

`GameMap.exportMapState()` (`GameMap.ts:164`) copies raw `terrain` (Uint8) and
`state` (Uint16) for **both** the main map and the 4x minimap. That is a
**fixed** 3 bytes per tile, independent of how long the game has run:

| Map (Normal size)       | main tiles | mini tiles | raw bytes | tagged-JSON ≈ ×4/3 |
| ----------------------- | ---------- | ---------- | --------- | ------------------ |
| World (2000×1000)       | 2 000 000  | 500 000    | 7.5 MB    | ~10 MB             |
| Giant World (4108×1948) | 8 002 384  | 2 000 596  | 30.0 MB   | ~40 MB             |
| Compact Giant           | 2 000 596  | 500 149    | 7.5 MB    | ~10 MB             |

The **plaintext** transfer cap is **900 000 chars**
(`MAX_CHECKPOINT_TRANSFER_BYTES`) under a **1 MiB** frame limit
(`MAX_WEBSOCKET_PAYLOAD_BYTES`). No Normal-size map fits that single frame — even
the default World map is ~11× over budget before any player/unit data.

Phase 7 lifted this by gzipping the blob and, when still too large, splitting it
across `checkpoint_chunk` frames under
`MAX_CHECKPOINT_COMPRESSED_TRANSFER_BYTES`. Eligibility is now a static capture
predicate over the map's fixed floor (`mapStateFitsCheckpointCapture`, ceiling
`MAX_CHECKPOINT_CAPTURE_BYTES = 64 MiB`), sized above the largest shipped map, so
**every map captures a checkpoint** and relies on compression to fit. Measured
gzip output stays far below the compressed cap even on the largest maps (e.g.
Sol ~82 MB tagged-JSON → ~1.7 MB gzipped for a synthetic full-map state). A
future map above the capture ceiling (or a checkpoint that fails to compress
under the cap) still degrades to full-history replay.

### 4.2 The history is the always-required artifact

`history.gz` holds one JSON turn per line, appended in ≤25-turn gzip members.
At 102 300 turns that is ~4 092 members. Size is dominated by intent density;
budget **5–40 MB compressed** per long private game. This file must always be
retrievable and replayable — checkpoints cannot be assumed.

### 4.3 Client memory

At max length the turn log exists in up to four places at once:

1. Worker `GameRunner.turns` (never trimmed; `GameRunner.ts:96,134-142`).
2. Main-thread `SaveManager.turns` (dense full history; `SaveManager.ts:17,61`).
3. Main-thread `latestCheckpoint` (one full checkpoint, forever;
   `ClientGameRunner.ts:877,1006`) — up to ~30 MB raw on Giant.
4. IndexedDB turn rows.

For ~102 k turns with intents this is tens of MB per JS context before the
checkpoint; the worker copy is pure waste because executed turns are dead.

---

## 5. Safety invariants

Any change must preserve all of these.

- **I1 — Full replay is always sufficient.** Missing/unreadable/oversized/foreign
  checkpoint ⇒ replay from turn 0. Never error.
- **I2 — Checkpoints are `gitCommit`- and version-pinned.** A mismatch drops the
  blob (`decodeCheckpoint`, `isGameCheckpoint`, `commitMatches`).
- **I3 — Turns are dense and authoritative.** `endTurn` numbers a turn as
  `turns.length`; `numTurns` is the authority on load.
- **I4 — Restore is in-place and never re-runs a side-effecting constructor/init**
  (`GameImpl.restoreFromCheckpoint`; execution `restoreCheckpoint`).
- **I5 — Determinism is preserved.** Checked state includes all PRNG states and
  every state-mutating execution; checkpoints/codecs may not introduce
  non-determinism.
- **I6 — PII never reaches a browser.** Applies to any new save/chunk payload.
- **I7 — Derived state is rebuilt, not trusted** (unit grid, border tiles,
  pathfinder/water caches, memos).

---

## 6. Risk register

Severity: H = can break or block long games; M = degrades; L = hygiene.

### Simulation / core

- **H — Checkpoint bloat from unbounded per-player histories.** `targets_`
  (`PlayerImpl.ts:1033`), `outgoingEmojis_` (`:1063`), `sentDonations`
  (`:1181/:1201`) and `pastOutgoingAllianceRequests` (`GameImpl.ts:483,498`) are
  append-only and are captured in `PlayerCheckpoint` (`Checkpoint.ts:175-227`).
  They grow with gameplay, inflating encode/decode cost and checkpoint size, and
  `canTarget`/`canSendEmoji`/`canDonate*`/`canSendAllianceRequest` scan/sort them
  on every hover (`GameRunner.playerActions`, and they gate real executions).
- **L — `_expiredAlliances` is dead** (never written anywhere, upstream too), so
  its checkpoint capture is harmless but useless.
- Reassuring: `PlayerImpl.hash()` ignores those arrays, so pruning stale entries
  is behavior-neutral; no numeric overflow (ticks are JS numbers to 2^53, gold is
  bigint, hash uses deliberate 32-bit `imul`).

### Client machine

- **H — History retained ~2× in JS** (worker + main) for the whole game.
- **H — Checkpoint encode before the size check.** `uploadCheckpoint`
  (`ClientGameRunner.ts:936-940`) builds the full tagged-JSON string, then tests
  `> 900_000`. On any real map that is a multi-MB (up to ~40 MB) allocation every
  200 ticks, discarded.
- **M — `latestCheckpoint` retained all game** (one full checkpoint).
- **M — IndexedDB quota.** `MAX_SAVES = 30` caps count, not bytes; long saves can
  raise `QuotaExceededError` and never persist.

### Server

- **H — Checkpoint sidecar rewritten every autosave.** `persistSave` runs every
  25 turns, forced, and `SaveStore.save` re-gzips/writes `checkpoint.json.gz`
  whenever present, even unchanged (`SaveStore.ts:187-189`).
- **H — Resume without a usable checkpoint sends the whole history in one
  `start` frame** (`GameServer.ts:1631-1646`). This is the path every real map
  takes today, and it worsens with length. `ws` `maxPayload` bounds inbound only,
  so outbound isn't rejected but the client/proxy must absorb it.
- **M — No retention cap** on the server store; many long saves fill `SAVE_DIR`.
  No declared volume ⇒ a restart also loses everything.
- **M — Server decodes every uploaded checkpoint** (`handleClientCheckpoint`,
  `GameServer.ts:1119`) and retains the string for the game's lifetime.
- **L — `turns` in server RAM all game**, freed when `Finished` and pruned
  (`GameManager.ts:204-214`).

---

## 7. Target design

The design separates **correctness (history)** from **speed (checkpoint)** and
makes both scale to 102 300 turns.

### D1. History is the source of truth, delivered in chunks

Resume must not depend on a checkpoint. Replace the single giant `start` backlog
with a streaming protocol:

- `start` carries metadata only: `gameStartInfo`, `myClientID`,
  `lobbyCreatedAt`, `numTurns`, `checkpoint?`, and a `chunkSize`.
- The server streams turn ranges as `turn_chunk` messages (reuse the existing
  worker `"turns"` path and `GameRunner.addTurns`).
- The client begins `beginCatchUp(numTurns - turnsSeen)` immediately and replays
  chunks as they arrive; back-pressure is a simple per-connection in-flight cap.
- A reconnect that already has state uses its `lastTurn` as today.

This removes the frame-size/latency cliff and lets replay overlap transfer.

### D2. Checkpoint is best-effort and size-governed

- **Budget guard before encoding.** Compute the projected encoded size from
  `tiles` (main + mini) + entity counts; if over budget, do not encode and do not
  upload. This alone removes the ~40 MB encode on large maps.
- **Map eligibility.** Maintain a static "checkpoint-capable" predicate from the
  map's tile count (e.g. raw map bytes + overhead ≤ budget). Large maps
  deliberately rely on chunked replay instead of checkpoints — no silent cliff.
- **Optional compressed/chunked transport (stretch).** If checkpoints on large
  maps are wanted, gzip with `CompressionStream`/zlib and split across frames,
  with a hard server-side byte cap and per-minute limit. Treat as a follow-up,
  gated on a bandwidth budget.

### D3. Bound simulation transients

- Prune `targets_`, `outgoingEmojis_`, `sentDonations`,
  `pastOutgoingAllianceRequests` entries older than their windows
  (`targetDuration`, `emojiMessageDuration`, `donateCooldown`,
  `allianceRequestCooldown`). Behavior-neutral per §6.
- Capture only the in-window subset in `PlayerCheckpoint`, so even a mis-timed
  prune cannot bloat the blob.
- Either remove the `_expiredAlliances` capture or start populating it.

### D4. Eliminate write amplification on the server

- Split checkpoint persistence from turn persistence: write
  `checkpoint.json.gz` only when the checkpoint actually changed (compare
  `checkpointTurn` and/or a cheap hash), instead of on every `save()`.
- Keep the head/meta rewrite; it is small.

### D5. Client memory is O(backlog), not O(history)

- Worker `GameRunner`: drop executed turns (base offset / ring buffer) so only
  the unexecuted backlog is retained.
- `SaveManager`: keep `numTurns` + the unpersisted tail; turn rows already live in
  IndexedDB. Do not retain the full dense array.
- Hold `latestCheckpoint` only between capture and upload.

### D6. Storage lifecycle

- Server: retention policy (newest-N per creator and/or max age) plus a size
  budget; fail saves gracefully on disk-full; document the required mounted
  `SAVE_DIR`.
- Client: request `navigator.storage.persist()`, monitor
  `navigator.storage.estimate()`, and evict/deny when over a per-save byte cap.

---

## 8. Implementation plan

Phased, each phase independently shippable and revertible. Every phase keeps I1.

### Phase 0 — Measurement & guardrails (no behavior change)

- Add metrics: checkpoint raw/encoded bytes, encode ms, skip reason, chunks per
  resume, history bytes, save latency, quota failures.
- Add a dev-only assertion/test that computes the encoded checkpoint size for
  representative maps and fails if it exceeds budget.
- Files: `src/core/CheckpointCodec.ts` (expose a `projectCheckpointBytes`),
  `GameRunner`/`ClientGameRunner` logging, telemetry types.

### Phase 1 — Bound simulation transients (fixes §6 H)

- Add `pruneTransient()` on `PlayerImpl`, invoked on write and/or from
  `PlayerExecution.tick`, and use windowed capture in `checkpoint()`.
- Tests: long simulated run asserting array lengths stay bounded and that
  behavior (`canTarget`/`canSendEmoji`/`canDonate*`/`canSendAllianceRequest`)
  is unchanged across the prune.
- Files: `src/core/game/PlayerImpl.ts`, `src/core/game/PlayerExecution.ts`,
  tests under `tests/core/`.

### Phase 2 — Client checkpoint budget guard (fixes §6 H)

- Pre-check projected size before `encodeCheckpoint`; skip upload silently.
- Only re-encode when `ticks` advanced.
- Tests: large-map checkpoint is skipped without allocating the string (spy on
  `encodeCheckpoint`).
- Files: `src/core/CheckpointCodec.ts`, `src/client/ClientGameRunner.ts`,
  `tests/ClientGameRunner*.test.ts`.

### Phase 3 — Server conditional checkpoint write (fixes §6 H)

- Track the persisted checkpoint identity; write the sidecar only on change.
- Tests: two saves with an unchanged checkpoint produce one sidecar write;
  a changed checkpoint produces an update.
- Files: `src/server/SaveStore.ts`, `src/server/GameServer.ts`,
  `tests/server/SaveStore.test.ts`.

### Phase 4 — Chunked history resume (fixes §6 H)

- Add `turn_chunk` (or extend the wire) and stream the backlog; client catch-up
  consumes chunks with back-pressure.
- Back-compat: keep the single `turns` field as a one-chunk degenerate case.
- Tests: a multi-chunk resume replays identically to an uninterrupted game; no
  frame exceeds the cap; slow-client back-pressure.
- Files: `src/core/Schemas.ts`, `src/server/GameServer.ts`
  (`sendStartGameMsg`/`startResumedGame`), `src/client/ClientGameRunner.ts`,
  `src/core/worker/WorkerMessages.ts`.

### Phase 5 — Client memory O(backlog) (fixes §6 H)

- Worker drops executed turns; `SaveManager` stops retaining full history.
- Tests: worker turn buffer bounded under sustained load; save still dense.
- Files: `src/core/GameRunner.ts`, `src/core/worker/Worker.worker.ts`,
  `src/client/SaveManager.ts`.

### Phase 6 — Storage lifecycle (fixes §6 M)

- Server retention/prune job + size budget + disk-full handling; client quota
  handling and `persist()` request.
- Files: `src/server/SaveStore.ts`, server startup/config, `src/client/SaveStore.ts`.

### Phase 7 — Optional compressed/chunked checkpoint transport

- Only if Phase 0 metrics show value above the map-eligibility threshold. Gzip +
  chunk + hard server cap. This is the only way checkpoints help on large maps,
  and it is explicitly optional.

---

## 9. Test & soak plan

- **Golden core tests** (extend `tests/core/Checkpoint*.test.ts`): capture →
  restore into a fresh identical game → suffix hash equality, at several lengths.
- **Max-length soak**: drive a game to ~102 300 turns with N humans + AI on
  World and Giant (headless, `tests/util/Setup.ts`); assert:
  - checkpoint encoded size ≤ budget on eligible maps;
  - `history.gz` bytes and per-save latency within budget;
  - server checkpoint sidecar write count == number of distinct checkpoints;
  - no unbounded array growth in players/executions.
- **Resume equivalence** for chunked replay: resume mid-game from history only
  and from checkpoint + suffix; both must equal the uninterrupted hash stream.
- **Resource assertions**: worker/main turn buffers stay O(backlog); client
  memory does not grow with `turns.length`.
- **Quota/disk-failure tests**: simulated `QuotaExceededError` and ENOSPC leave a
  consistent older save and retry the delta.

## 10. Metrics

Checkpoint {raw bytes, encoded bytes, encode ms, skip reason}, history {bytes,
appends}, save {latency ms, failures}, resume {mode (checkpoint|history),
chunks, replay ticks, wall ms}, storage {server bytes per creator, client quota
estimate}, and desync counters. Alert on checkpoint encode ms and on history
bytes per game beyond budget.

## 11. Rollout and rollback

- Land Phases 0–3 behind no flag (pure wins). Phases 4–5 change the resume
  protocol; gate with a wire/feature flag and support the legacy single-frame
  path until all clients ship.
- Rollback is safe because I1 holds: disabling checkpoint transfer or chunking
  returns to full replay, which the phases make cheaper, not more fragile.
- Keep `gitCommit` pinning end-to-end so a mixed-version fleet falls back rather
  than desyncs.

## 12. Open decisions

1. Checkpoint eligibility threshold: map-tile count vs measured bytes? (Proposed:
   measured `projectCheckpointBytes` with a 700 000-char soft cap.)
2. Chunk size and in-flight cap for Phase 4 (proposed: 512 turns / 2 in flight).
3. Server retention policy shape (newest-N per creator vs age vs total bytes).
4. ~~Whether large-map checkpoint transport (Phase 7) is wanted at all, or
   whether chunked replay is the accepted answer for large maps.~~ Resolved:
   Phase 7 is implemented and the capture ceiling (`MAX_CHECKPOINT_CAPTURE_BYTES`)
   is sized so every shipped map captures; compression carries the upload. The
   compressed cap (`MAX_CHECKPOINT_COMPRESSED_TRANSFER_BYTES`) remains the bound
   and any over-cap checkpoint falls back to history replay.

## 13. Appendix — constants and references

| Constant                  | Value                          | Location                                    |
| ------------------------- | ------------------------------ | ------------------------------------------- |
| Spawn turns (private FFA) | 300                            | `Config.numSpawnPhaseTurns`                 |
| Hard game time            | 170 min                        | `WinCheckExecution.HARD_TIME_LIMIT_SECONDS` |
| Server max duration       | 3 h (per session)              | `GameServer.ts:157,351`                     |
| Client autosave           | 25 turns                       | `SaveManager.ts:12`                         |
| Server autosave           | 25 turns (forced)              | `GameServer.ts:91,1679`                     |
| Server min interval       | 3000 ms (bypassed when forced) | `GameServer.ts:92,529`                      |
| Checkpoint cadence        | 200 turns                      | `Checkpoint.ts:36`                          |
| Checkpoint transfer cap   | 900 000 chars                  | `CheckpointCodec.ts:30`                     |
| WS frame cap              | 1 MiB (inbound)                | `MatchTelemetryConfig.ts:3`, `Worker.ts:62` |
| Client save cap           | 30 saves                       | `SaveStore.ts:24`                           |
| Max turns                 | **102 300**                    | derived, §3                                 |

**Verification commands**

```bash
npx vitest run tests/core/Checkpoint*.test.ts tests/server/SaveStore.test.ts \
  tests/server/GameServerSave.test.ts tests/SaveManager.test.ts
npx tsc --noEmit
npm run lint
```
