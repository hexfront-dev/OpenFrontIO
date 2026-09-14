/**
 * Defense post line placement — samples integer tile positions along a
 * straight segment at a fixed Euclidean spacing so a dragged line of defense
 * posts has overlapping range circles with no gaps.
 *
 * This is pure geometry (no game state), so it lives alongside `Line.ts`.
 */

export interface DefensePostLinePoint {
  x: number;
  y: number;
}

/**
 * Sample floored tile coordinates along the segment from
 * `(startX, startY)` to `(endX, endY)`.
 *
 * - The first point is the floored start tile.
 * - Subsequent points are placed every `spacing` world units along the
 *   segment.
 * - The floored end tile is always appended (deduplicated) so the dragged
 *   segment is fully covered even when its length is not an exact multiple of
 *   `spacing`.
 * - Consecutive duplicate tiles are removed.
 */
export function sampleDefensePostLine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  spacing: number,
): DefensePostLinePoint[] {
  if (!(spacing > 0)) {
    throw new Error(`spacing must be positive, got ${spacing}`);
  }

  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.sqrt(dx * dx + dy * dy);

  const points: DefensePostLinePoint[] = [];
  if (length < 1) {
    points.push({ x: Math.floor(startX), y: Math.floor(startY) });
    return points;
  }

  const ux = dx / length;
  const uy = dy / length;
  const stepCount = Math.floor(length / spacing);
  for (let i = 0; i <= stepCount; i++) {
    const d = i * spacing;
    points.push({
      x: Math.floor(startX + ux * d),
      y: Math.floor(startY + uy * d),
    });
  }

  const end = { x: Math.floor(endX), y: Math.floor(endY) };
  const last = points[points.length - 1];
  if (last === undefined || last.x !== end.x || last.y !== end.y) {
    points.push(end);
  }

  // Drop consecutive duplicate tiles (possible with very small spacing).
  const deduped: DefensePostLinePoint[] = [];
  for (const p of points) {
    const prev = deduped[deduped.length - 1];
    if (prev === undefined || prev.x !== p.x || prev.y !== p.y) {
      deduped.push(p);
    }
  }
  return deduped;
}
