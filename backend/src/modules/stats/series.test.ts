import { describe, expect, it } from "vitest";
import { fillSeries, slotSizeMs, type SeriesPoint } from "./series.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const START = new Date("2026-10-01T00:00:00Z");

function at(offsetMs: number, fields: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    t: new Date(START.getTime() + offsetMs),
    totalChecks: 1,
    failures: 0,
    avgMs: 100,
    p95Ms: 100,
    ...fields,
  };
}

describe("slotSizeMs", () => {
  it("keeps the base slot when checks are more frequent", () => {
    expect(slotSizeMs(15 * MIN, 60)).toBe(15 * MIN);
    expect(slotSizeMs(HOUR, 300)).toBe(HOUR);
  });

  it("grows the slot to fit longer intervals", () => {
    expect(slotSizeMs(15 * MIN, 1800)).toBe(30 * MIN);
    expect(slotSizeMs(15 * MIN, 3600)).toBe(HOUR);
    expect(slotSizeMs(HOUR, 5 * 3600)).toBe(6 * HOUR);
  });

  it("caps at one day", () => {
    expect(slotSizeMs(HOUR, 3 * 86400)).toBe(24 * HOUR);
  });
});

describe("fillSeries", () => {
  it("adds empty slots where nothing was checked", () => {
    const points = [at(0), at(15 * MIN), at(HOUR)];
    const filled = fillSeries(points, START, new Date(START.getTime() + HOUR), 15 * MIN);

    expect(filled.map((point) => point.t.getTime() - START.getTime())).toEqual([
      0,
      15 * MIN,
      30 * MIN,
      45 * MIN,
      HOUR,
    ]);
    expect(filled[2]).toMatchObject({ totalChecks: 0, failures: 0, avgMs: null, p95Ms: null });
    expect(filled[3]).toMatchObject({ totalChecks: 0, avgMs: null });
    expect(filled[4]).toMatchObject({ totalChecks: 1, avgMs: 100 });
  });

  it("starts and ends on slot boundaries", () => {
    const filled = fillSeries(
      [],
      new Date(START.getTime() + 7 * MIN),
      new Date(START.getTime() + 31 * MIN),
      15 * MIN,
    );
    expect(filled.map((point) => point.t.getTime() - START.getTime())).toEqual([
      0,
      15 * MIN,
      30 * MIN,
    ]);
  });

  it("merges smaller points into a bigger slot", () => {
    const points = [
      at(0, { totalChecks: 3, failures: 1, avgMs: 100, p95Ms: 150 }),
      at(15 * MIN, { totalChecks: 1, failures: 0, avgMs: 500, p95Ms: 400 }),
    ];
    const [slot] = fillSeries(points, START, START, HOUR);

    expect(slot.totalChecks).toBe(4);
    expect(slot.failures).toBe(1);
    // Weighted: (3 * 100 + 1 * 500) / 4
    expect(slot.avgMs).toBe(200);
    expect(slot.p95Ms).toBe(400);
  });

  it("ignores untimed points in the average", () => {
    const points = [
      at(0, { totalChecks: 2, avgMs: 300 }),
      at(15 * MIN, { totalChecks: 5, failures: 5, avgMs: null, p95Ms: null }),
    ];
    const [slot] = fillSeries(points, START, START, HOUR);

    expect(slot.totalChecks).toBe(7);
    expect(slot.avgMs).toBe(300);
  });
});
