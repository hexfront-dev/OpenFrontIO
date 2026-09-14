import { describe, expect, test } from "vitest";
import { sampleDefensePostLine } from "../../../src/core/utilities/DefensePostLine";

describe("sampleDefensePostLine", () => {
  test("places posts every spacing units along a straight horizontal line", () => {
    const points = sampleDefensePostLine(0, 0, 200, 0, 55);

    expect(points.map((p) => p.x)).toEqual([0, 55, 110, 165, 200]);
    for (const p of points) {
      expect(p.y).toBe(0);
    }
  });

  test("always includes the endpoint even when length is not a multiple of spacing", () => {
    const points = sampleDefensePostLine(0, 0, 130, 0, 55);

    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 130, y: 0 });
    // 0, 55, 110, then the endpoint 130.
    expect(points.map((p) => p.x)).toEqual([0, 55, 110, 130]);
  });

  test("floors coordinates to integer tiles", () => {
    const points = sampleDefensePostLine(10.9, 20.1, 10.9, 20.1, 55);

    expect(points).toEqual([{ x: 10, y: 20 }]);
  });

  test("zero-length segment returns a single point", () => {
    const points = sampleDefensePostLine(5.4, 7.6, 5.4, 7.6, 55);

    expect(points).toEqual([{ x: 5, y: 7 }]);
  });

  test("diagonal line spaces points evenly along the segment", () => {
    // A 3-4-5 triangle: length 165 = 3 * 55.
    const points = sampleDefensePostLine(0, 0, 99, 132, 55);

    expect(points.length).toBe(4);
    // Unit vector is (3/5, 4/5); at distance 55 the point is (33, 44).
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[1]).toEqual({ x: 33, y: 44 });
    expect(points[2]).toEqual({ x: 66, y: 88 });
    expect(points[3]).toEqual({ x: 99, y: 132 });
  });

  test("throws for non-positive spacing", () => {
    expect(() => sampleDefensePostLine(0, 0, 10, 10, 0)).toThrow();
    expect(() => sampleDefensePostLine(0, 0, 10, 10, -5)).toThrow();
  });
});
