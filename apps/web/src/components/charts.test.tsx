import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { MetricChart } from "./charts";

afterEach(cleanup);

describe("MetricChart", () => {
  it("renders the last value without crashing", () => {
    render(<MetricChart data={[1, 2, 3.456]} label="CPU" unit="%" decimals={1} />);
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("3.5%")).toBeTruthy();
  });

  it("tolerates a non-finite series (undefined/NaN) without throwing — coerces to 0", () => {
    // An older agent omits a newer metric field → its live sample reaches the chart as undefined.
    const dirty = [1, NaN, undefined as unknown as number];
    expect(() => render(<MetricChart data={dirty} label="Disk" unit=" MB/s" decimals={1} />)).not.toThrow();
    expect(screen.getByText("0.0 MB/s")).toBeTruthy(); // last coerced to 0, not "NaN"/crash
  });

  it("renders an empty series as 0", () => {
    render(<MetricChart data={[]} label="Net" unit="%" />);
    expect(screen.getByText("0%")).toBeTruthy();
  });
});

// ── P3: time axis, crosshair + tooltip, min/avg/max, auto-scale, peak band ────────────────────────────────
import { fireEvent, within } from "@testing-library/react";
import { niceMax, fmtAxis, pickTimeTicks, pointXs, nearestIndex, seriesStats, formatTick, Sparkline } from "./charts";

const T0 = Date.UTC(2026, 10, 7, 10, 0, 0);
const MIN = 60_000;
const times = (n: number, step = MIN) => Array.from({ length: n }, (_, i) => T0 + i * step);

describe("chart helpers", () => {
  it("niceMax rounds an auto-scaled ceiling up to 1/2/2.5/5/10 × 10^k", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1.3)).toBe(2);
    expect(niceMax(2.4)).toBe(2.5);
    expect(niceMax(3.2)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(980)).toBe(1000);
  });
  it("fmtAxis stays compact for the narrow Y gutter", () => {
    expect(fmtAxis(100)).toBe("100");
    expect(fmtAxis(12.5)).toBe("12.5");
    expect(fmtAxis(0.25)).toBe("0.25");
    expect(fmtAxis(0)).toBe("0");
  });
  it("pickTimeTicks spans first→last evenly; single point → one centred tick; no/invalid times → none", () => {
    const t = pickTimeTicks(times(61), 4);
    expect(t).toHaveLength(4);
    expect(t[0]).toEqual({ frac: 0, ts: T0 });
    expect(t[3]).toEqual({ frac: 1, ts: T0 + 60 * MIN });
    expect(t[1].ts).toBe(T0 + 20 * MIN);
    expect(pickTimeTicks([T0])).toEqual([{ frac: 0.5, ts: T0 }]);
    expect(pickTimeTicks(undefined)).toEqual([]);
    expect(pickTimeTicks([T0, Number.NaN])).toEqual([]);
  });
  it("pointXs is time-proportional (gaps stay gaps), index-spaced without times, centred for one point", () => {
    expect(pointXs(3, [0, 100, 1000], 600)).toEqual([0, 60, 600]);
    expect(pointXs(3, undefined, 600)).toEqual([0, 300, 600]);
    expect(pointXs(1, [5], 600)).toEqual([300]);
    expect(pointXs(0, [], 600)).toEqual([]);
  });
  it("nearestIndex + seriesStats", () => {
    expect(nearestIndex([0, 100, 300], 240)).toBe(2);
    expect(nearestIndex([0, 100, 300], 40)).toBe(0);
    expect(seriesStats([])).toBeNull();
    expect(seriesStats([2, 4, 9])).toEqual({ min: 2, avg: 5, max: 9 });
  });
  it("formatTick: clock time for a short window, a date for a multi-day one", () => {
    expect(formatTick(T0, 3600_000)).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(formatTick(T0, 7 * 86_400_000)).not.toMatch(/:/);
  });
});

describe("MetricChart (P3)", () => {
  const wrapI18n = (ui: React.ReactElement) => render(<I18nProvider>{ui}</I18nProvider>);

  it("renders a time X-axis with readable tick labels when timestamps are given", () => {
    wrapI18n(<MetricChart data={[1, 2, 3, 4]} times={times(4)} label="CPU" unit="%" />);
    const axis = screen.getByTestId("chart-xaxis");
    expect(axis.children).toHaveLength(4);
    expect(axis.textContent).toMatch(/\d/);
  });

  it("omits the X-axis (but still draws) when no timestamps are supplied — existing callers keep working", () => {
    wrapI18n(<MetricChart data={[1, 2, 3]} label="CPU" unit="%" />);
    expect(screen.queryByTestId("chart-xaxis")).toBeNull();
    expect(screen.getByRole("slider", { name: "CPU" })).toBeTruthy();
  });

  it("MIN / AVG / MAX footer", () => {
    wrapI18n(<MetricChart data={[10, 20, 60]} times={times(3)} label="CPU" unit="%" decimals={1} />);
    const f = screen.getByTestId("chart-stats");
    expect(within(f).getByText("Min 10.0%")).toBeTruthy();
    expect(within(f).getByText("Avg 30.0%")).toBeTruthy();
    expect(within(f).getByText("Max 60.0%")).toBeTruthy();
  });

  it("percent stays 0–100; other units auto-scale to a nice ceiling over the data", () => {
    const { unmount } = wrapI18n(<MetricChart data={[1, 2, 3]} label="CPU" unit="%" />);
    expect(screen.getByText("100%")).toBeTruthy(); // fixed top of axis even for a near-idle series
    unmount();
    wrapI18n(<MetricChart data={[1, 2, 3.2]} label="Net" unit=" MB/s" decimals={1} />);
    expect(screen.getByText("5.0 MB/s")).toBeTruthy(); // 3.2 → nice ceiling 5, not 100
    expect(screen.queryByText("100.0 MB/s")).toBeNull();
  });

  it("keyboard: focusing shows the crosshair + tooltip at the newest point; arrows/Home/End move it; Escape hides", () => {
    wrapI18n(<MetricChart data={[10, 20, 30]} times={times(3)} label="CPU" unit="%" decimals={1} />);
    const slider = screen.getByRole("slider", { name: "CPU" });
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
    fireEvent.focus(slider);
    expect(screen.getByTestId("chart-crosshair")).toBeTruthy();
    expect(within(screen.getByTestId("chart-tooltip")).getByText("30.0%")).toBeTruthy();
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(within(screen.getByTestId("chart-tooltip")).getByText("20.0%")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toContain("20.0%");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(within(screen.getByTestId("chart-tooltip")).getByText("10.0%")).toBeTruthy();
    fireEvent.keyDown(slider, { key: "ArrowLeft" }); // clamps at the first point
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
  });

  it("tooltip shows the value AND its timestamp", () => {
    wrapI18n(<MetricChart data={[10, 20]} times={times(2)} label="CPU" unit="%" />);
    fireEvent.focus(screen.getByRole("slider", { name: "CPU" }));
    const tip = screen.getByTestId("chart-tooltip");
    expect(tip.textContent).toContain("20%");
    expect(tip.textContent).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it("pointer hover picks the nearest point by X and blur/leave clears it", () => {
    wrapI18n(<MetricChart data={[10, 20, 30, 40]} times={times(4)} label="CPU" unit="%" />);
    const slider = screen.getByRole("slider", { name: "CPU" });
    slider.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 140, width: 300, height: 140, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(slider, { clientX: 105 }); // ~35% along → nearest of [0, 1/3, 2/3, 1] is index 1
    expect(within(screen.getByTestId("chart-tooltip")).getByText("20%")).toBeTruthy();
    fireEvent.pointerMove(slider, { clientX: 300 });
    expect(within(screen.getByTestId("chart-tooltip")).getByText("40%")).toBeTruthy();
    fireEvent.blur(slider);
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
  });

  it("empty series: header 0, 'no data' note, no footer/axis/crosshair, no crash on keys or focus", () => {
    wrapI18n(<MetricChart data={[]} times={[]} label="Net" unit="%" />);
    expect(screen.getByText("No data in this range")).toBeTruthy();
    expect(screen.queryByTestId("chart-stats")).toBeNull();
    expect(screen.queryByTestId("chart-xaxis")).toBeNull();
    const slider = screen.getByRole("slider", { name: "Net" });
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
  });

  it("single point: renders a dot, one centred tick, stats, and a working tooltip (no divide-by-zero NaN)", () => {
    const { container } = wrapI18n(<MetricChart data={[42]} times={[T0]} label="CPU" unit="%" />);
    expect(screen.getByTestId("chart-xaxis").children).toHaveLength(1);
    expect(within(screen.getByTestId("chart-stats")).getByText("Avg 42%")).toBeTruthy();
    expect(container.innerHTML).not.toContain("NaN");
    fireEvent.focus(screen.getByRole("slider", { name: "CPU" }));
    expect(within(screen.getByTestId("chart-tooltip")).getByText("42%")).toBeTruthy();
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("mismatched times length degrades to an index axis without crashing", () => {
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3]} times={[T0]} label="CPU" unit="%" />);
    expect(screen.queryByTestId("chart-xaxis")).toBeNull();
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("peaks draw a faint max band, the tooltip reports the peak, and MAX reflects it", () => {
    wrapI18n(<MetricChart data={[10, 20, 30]} peaks={[15, 90, 30]} times={times(3)} label="CPU" unit="%" />);
    expect(screen.getByTestId("chart-peak-band")).toBeTruthy();
    expect(within(screen.getByTestId("chart-stats")).getByText("Max 90%")).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "CPU" });
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(within(screen.getByTestId("chart-tooltip")).getByText("Peak 90%")).toBeTruthy();
  });

  it("no peaks → no band; a peak series of the wrong length is ignored", () => {
    wrapI18n(<MetricChart data={[1, 2, 3]} peaks={[5]} times={times(3)} label="CPU" unit="%" />);
    expect(screen.queryByTestId("chart-peak-band")).toBeNull();
  });

  it("is responsive: the plot is fluid (100% wide SVG, min-width 0) — no fixed pixel width that overflows a phone", () => {
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3]} times={times(3)} label="CPU" unit="%" />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("100%");
    expect((container.firstChild as HTMLElement).style.minWidth).toBe("0px");
  });

  it("theme-aware: colours come from CSS variables (no hard-coded hex)", () => {
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3]} times={times(3)} label="CPU" unit="%" />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});

describe("Sparkline", () => {
  it("draws a polyline for a trend; fewer than two finite points → an em dash placeholder", () => {
    const { container, unmount } = render(<Sparkline data={[1, 5, 3]} label="trend" />);
    expect(container.querySelector("polyline")).toBeTruthy();
    expect(screen.getByRole("img", { name: "trend" })).toBeTruthy();
    unmount();
    render(<Sparkline data={[4, Number.NaN]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
  it("fixedMax pins the scale (a 10% series sits low, not stretched to the top)", () => {
    const { container } = render(<Sparkline data={[10, 10]} fixedMax={100} height={20} />);
    const y = Number(container.querySelector("polyline")!.getAttribute("points")!.split(" ")[0].split(",")[1]);
    expect(y).toBeGreaterThan(15); // low in a 20px box
  });
});
