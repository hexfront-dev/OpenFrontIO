import { Game, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";

const FORMATION_SPACING = 15;

function isCoreShip(type: UnitType): boolean {
  return type === UnitType.MissileShip || type === UnitType.MissileDefenseShip;
}

/**
 * Ticks between movement steps for a ship. Warships move every tick; missile
 * ships move every 2 ticks.
 */
export function shipMoveInterval(type: UnitType): number {
  if (type === UnitType.Warship) return 1;
  return 2;
}

/** A fleet takes the slowest member's rate. */
export function computeFleetMoveRate(ships: Unit[]): number {
  return Math.max(
    ...ships.map((s) => shipMoveInterval(s.type())),
  );
}

/**
 * Find the nearest unused water tile to (baseX, baseY) by searching
 * expanding Chebyshev rings. Avoids collapsing ships onto a single tile
 * when a formation slot lands on land near the shore.
 */
function findWaterTile(
  mg: Game,
  baseX: number,
  baseY: number,
  usedTiles: Set<TileRef>,
): TileRef | undefined {
  for (let r = 0; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = baseX + dx;
        const y = baseY + dy;
        if (!mg.isValidCoord(x, y)) continue;
        const tile = mg.ref(x, y);
        if (mg.isWater(tile) && !usedTiles.has(tile)) {
          return tile;
        }
      }
    }
  }
  return undefined;
}

/**
 * Assign each ship a compact, evenly-spaced grid slot around `anchor`, with
 * missile ships (MissileShip + MissileDefenseShip) in the center. Sets each
 * ship's patrolTile and fleetMoveRate.
 */
export function assignFleetFormation(
  mg: Game,
  ships: Unit[],
  anchor: TileRef,
): void {
  if (ships.length === 0) return;

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
    offsets.push({
      dx: col * FORMATION_SPACING,
      dy: row * FORMATION_SPACING,
    });
  }
  offsets.sort(
    (a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy),
  );

  const fleetMoveRate = computeFleetMoveRate(ships);
  const usedTiles = new Set<TileRef>();
  const anchorX = mg.x(anchor);
  const anchorY = mg.y(anchor);

  ordered.forEach((ship, i) => {
    const offset = offsets[i];
    const formationTile =
      findWaterTile(mg, anchorX + offset.dx, anchorY + offset.dy, usedTiles) ??
      anchor;

    usedTiles.add(formationTile);
    ship.updateWarshipState({ patrolTile: formationTile, fleetMoveRate });
    ship.setTargetTile(undefined);
  });
}

/** Compute the centroid tile of a group of ships (rounded to nearest tile). */
export function computeFleetCentroid(mg: Game, ships: Unit[]): TileRef {
  let sumX = 0;
  let sumY = 0;
  for (const s of ships) {
    sumX += mg.x(s.tile());
    sumY += mg.y(s.tile());
  }
  const cx = Math.round(sumX / ships.length);
  const cy = Math.round(sumY / ships.length);
  if (mg.isValidCoord(cx, cy)) {
    return mg.ref(cx, cy);
  }
  return ships[0].tile();
}
