# Tollhouse: changing its sprite and HUD UI

The Tollhouse currently borrows the **City** sprite and icon everywhere. This
note lists every place that decides how a building is drawn so the placeholder
can be swapped for dedicated art later.

The unit type is `UnitType.Tollhouse` (`src/core/game/Game.ts`), whose string
value is `"Tollhouse"`. The renderer keys everything off that string, so keep
the renderer's `UT_TOLLHOUSE` constant in sync.

## 1. Map sprite (what you see on the map)

Structures are drawn by `StructurePass` from a fixed-column sprite atlas
(`resources/atlases/icon-atlas.png`). The column is chosen by `STRUCTURE_ORDER`
in **both** passes, which must stay identical:

- `src/client/render/gl/passes/StructurePass.ts` — `STRUCTURE_ORDER` + the
  `cityCol` alias block in the constructor.
- `src/client/render/gl/passes/StructureLevelPass.ts` — same `STRUCTURE_ORDER`
  - the `cityCol` alias block (draws the level number above the building).

Because the Tollhouse has no atlas column yet, both constructors alias it to
the City column at runtime:

```ts
const cityCol = this.typeToAtlasCol.get(UT_CITY);
if (cityCol !== undefined) {
  this.typeToAtlasCol.set(UT_TOLLHOUSE, cityCol);
}
```

`UT_TOLLHOUSE` lives in `src/client/render/types/UnitType.ts` and is re-exported
from `src/client/render/types/index.ts`. It is also listed in `STRUCTURE_TYPES`
so the level pass treats it like any other structure.

### To give the Tollhouse its own map art

1. Add a new sprite for the Tollhouse to the icon atlas generation (the header
   of `StructurePass.ts` names `generate-sprite-atlases.mjs`; regenerate
   `resources/atlases/icon-atlas.png` with the extra column).
2. Insert `UT_TOLLHOUSE` into `STRUCTURE_ORDER` in **both** `StructurePass.ts`
   and `StructureLevelPass.ts`, at the position matching the new atlas column.
   The array index is the atlas column, so order matters.
3. Delete the two `cityCol` alias blocks (their `UT_CITY`/`UT_TOLLHOUSE`
   imports can then be trimmed if unused).
4. No wire/schema change is needed — the unit type already travels on
   `UnitUpdate.unitType`.

## 2. Build-menu HUD icon

`src/client/hud/layers/BuildMenu.ts`:

- `const cityIcon = assetUrl("images/CityIconWhite.svg");` is reused for the
  Tollhouse entry at the bottom of `buildTable`. Swap `icon: cityIcon` for a
  new `tollhouseIcon` and add its `assetUrl(...)` import. The asset should live
  under `resources/images/`.

## 3. Player info overlay (unit count chip + toll slider)

`src/client/hud/layers/PlayerInfoOverlay.ts`:

- `displayUnitCount(player, UnitType.Tollhouse, cityIcon)` — the small count
  chip next to City/Factory/Port. Pass a dedicated icon instead of `cityIcon`.
- `renderTollRate(player)` — the 0–100% toll slider shown when clicking another
  nation. It reads `myPlayer.tollRateForSmallID(...)` and emits
  `SendSetTollRateIntentEvent` (`src/client/Transport.ts` →
  `set_toll_rate` intent). Styling lives in that template; no icon involved.

## 4. Translations

Only `resources/lang/en.json` is edited by hand (Crowdin owns the rest):

- `unit_type.tollhouse` — the building name.
- `build_menu.desc.tollhouse` — the build-menu description.
- `tollhouse.rate_label` — the slider label.

Keys must stay alphabetically sorted (`tests/EnJsonSorted.test.ts`).

## 5. Persistent range overlay & toll notifications

Two behaviours are wired outside the icon system and may need touching if the
Tollhouse is reworked:

- **Range overlay (all players).** `RangeCirclePass`
  (`src/client/render/gl/passes/RangeCirclePass.ts`) draws a persistent
  translucent circle per Tollhouse via `updateTollhouseRanges(...)`. The list
  is built in `Renderer.updateStructures()` from the unit map using
  `config.tollhouseRange(level)`, so it always reflects the current level.
  Every Tollhouse range is amber (`TOLLHOUSE_COLOR`), regardless of owner, so
  every player sees the same overlay. Remove the
  `else if (u.unitType === UT_TOLLHOUSE ...)` branch in `Renderer.ts` and the
  `tollhouses` field/draw loop in `RangeCirclePass.ts` to drop it.
- **Toll payout + notification.** A toll is paid the instant a ship is tolled in
  `TradeShipExecution.applyTolls()`, not at arrival. The amount is a percentage
  of the value the ship will have on arrival: its value is a function of total
  distance travelled, so the remaining route length is found with a one-shot
  path query (`projectedArrivalValue`) and added to the distance covered so far.
  The amount already paid is recorded on the ship's toll ledger and subtracted
  from the trade endpoints' payout in `deductTolls()` when it arrives. The toller
  is notified with a private `MessageType.TOLL` event (`playerID =
toller.id()`), text `events_display.toll_earned` in `resources/lang/en.json`;
  its color is set in `src/client/Utils.ts` (`getMessageTypeClasses`).

## 6. Other places that reference structure icons (optional polish)

These are not required for the City placeholder to work, but a dedicated icon
would normally be added there too:

- `src/client/components/baseComponents/stats/PlayerStatsSummary.ts` —
  `otherUnitIcons` (game-end summary rows). The stats wire key is `"toll"`
  (see `src/core/StatsSchemas.ts`).
- `src/client/hud/layers/lib/StatsColumns.ts` — leaderboard column registry.
- `src/client/hud/layers/UnitDisplay.ts` — the persistent hotbar counter
  (already lists the Tollhouse with the City icon).
- `src/client/HelpModal.ts` — help/units reference panel.
- `src/client/components/GameConfigSettings.ts` — already lists the Tollhouse
  for the "disabled units" toggle (label only, no icon).
- `src/client/controllers/BuildPreviewController.ts` — the placement ghost's
  range circle uses `config().tollhouseRange(level)`; no sprite there.

## Quick reference: rules implemented

- Land structure, range = Factory range (`trainStationMaxRange()` = 100).
- Toll range: `+5%` per level, capped at `1.5x` base (level 11+).
- Toll capacity: `level` ships per `30`-tick window.
- A nation may toll a given ship at most once; the rate is a per-nation
  percentage (0–100) set from the other-nation info overlay.
- A ship bound for one of the toller's own ports is exempt (it passes free);
  only the ship's own owner is otherwise exempt, so allies/teammates still pay
  if a rate is set.
- Gold is paid to the Tollhouse owner the moment the ship is tolled, as a
  percentage of the value the ship will have at its destination (projected from
  the remaining route); that already-paid amount is subtracted from the trade
  endpoints' payout at arrival (`src/core/execution/TradeShipExecution.ts`).
  Registration happens as the ship traverses the range (`applyTolls`), and the
  endpoints' reduced payout is computed at `complete()` (`deductTolls`).
- Config lives in `src/core/configuration/Config.ts`:
  `tollhouseBaseRange`, `tollhouseRange`, `tollhouseMaxRange`,
  `tollhouseMaxTollsPerWindow`, `tollhouseTollCooldown`.
