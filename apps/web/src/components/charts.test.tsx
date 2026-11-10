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
import { fireEvent, within, act } from "@testing-library/react";
import { niceMax, fmtAxis, pickTimeTicks, pointXs, nearestIndex, seriesStats, formatTick, Sparkline } from "./charts";
import { ChartCard, detectGaps, buildRuns, linePath, seriesHasData, seriesColor, seriesDash, type ChartSeries } from "./charts";
import { vi } from "vitest";

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
  it("with times, NaN gaps break the line and points sit at their time (not compacted by index)", () => {
    const { container } = render(<Sparkline data={[5, 7, Number.NaN, Number.NaN, 6, 8]} times={[0, 10, 20, 30, 40, 100]} width={100} />);
    const lines = container.querySelectorAll("polyline");
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute("points")!.split(" ").map((p) => p.split(",")[0])).toEqual(["0.0", "10.0"]);
    expect(lines[1].getAttribute("points")!.split(" ").map((p) => p.split(",")[0])).toEqual(["40.0", "100.0"]);
  });
  it("with times and an interval, a step > 3x the interval breaks the line", () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 4]} times={[0, 10, 20, 500]} interval={10} width={100} />);
    expect(container.querySelectorAll("polyline").length + container.querySelectorAll("circle").length).toBe(2);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
  it("fixedMax pins the scale (a 10% series sits low, not stretched to the top)", () => {
    const { container } = render(<Sparkline data={[10, 10]} fixedMax={100} height={20} />);
    const y = Number(container.querySelector("polyline")!.getAttribute("points")!.split(" ")[0].split(",")[1]);
    expect(y).toBeGreaterThan(15); // low in a 20px box
  });
});

// ── v2: series model, stacked, hide-when-empty, gaps, table view, true-px sizing ─────────────────────────
describe("chart v2 helpers", () => {
  it("detectGaps is OPT-IN: only an explicit interval flags steps > 3× it; nothing is ever inferred", () => {
    const ts = [0, 60_000, 120_000, 600_000, 660_000];
    expect(detectGaps(ts)).toEqual([false, false, false, false, false]); // no interval → no inferred gap
    expect(detectGaps(ts, 0)).toEqual([false, false, false, false, false]);
    expect(detectGaps(ts, 60_000)).toEqual([false, false, false, true, false]);
    expect(detectGaps([0, 60_000, 230_000], 60_000)).toEqual([false, false, false]); // 170s < 180s (LTTB-tolerant)
    expect(detectGaps([0, 60_000, 250_000], 60_000)).toEqual([false, false, true]);
    expect(detectGaps(undefined)).toEqual([]);
  });
  it("buildRuns splits on gaps and on invalid points; linePath emits one subpath per run", () => {
    expect(buildRuns(5, [false, false, true, false, false])).toEqual([[0, 1], [2, 4]]);
    expect(buildRuns(4, [], (i) => i !== 1)).toEqual([[0, 0], [2, 3]]);
    const d = linePath([0, 10, 20, 30], [1, 2, 3, 4], [[0, 1], [2, 3]]);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(linePath([0], [1], [[0, 0]])).toBe(""); // a lone point is a dot, not a line
  });
  it("seriesHasData / seriesColor", () => {
    expect(seriesHasData([NaN, undefined as unknown as number])).toBe(false);
    expect(seriesHasData([NaN, 0])).toBe(true);
    expect(seriesColor(0)).toBe("var(--chart-1)");
    expect(seriesColor(4)).toBe("var(--chart-5)");
    expect(seriesColor(5)).toBe("var(--c-tx3)"); // never cycled
  });
});

describe("MetricChart v2", () => {
  const wrapI18n = (ui: React.ReactElement) => render(<I18nProvider>{ui}</I18nProvider>);
  const ov: ChartSeries[] = [
    { key: "in", label: "Net in", values: [1, 2, 3, 4] },
    { key: "out", label: "Net out", values: [4, 3, 2, 9] },
  ];

  it("legacy single `values` path still renders as before (colour, header value, stats, slider)", () => {
    const { container } = wrapI18n(<MetricChart data={[10, 20, 60]} times={times(3)} label="CPU" unit="%" color="var(--c-lapis)" />);
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "CPU" })).toBeTruthy();
    expect(screen.queryByTestId("chart-legend")).toBeNull();
    expect(container.querySelectorAll('[data-testid^="chart-line-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="chart-line-value"]')!.getAttribute("stroke")).toBe("var(--c-lapis)");
  });

  it("a one-entry `series` keeps the caller's colour and behaves like a single series", () => {
    const { container } = wrapI18n(
      <MetricChart series={[{ key: "cpu", label: "CPU", values: [1, 2, 3] }]} label="CPU" unit="%" color="var(--c-g)" />,
    );
    expect(container.querySelector('[data-testid="chart-line-cpu"]')!.getAttribute("stroke")).toBe("var(--c-g)");
    expect(screen.queryByTestId("chart-legend")).toBeNull();
  });

  it("overlay: one line per series in fixed slot colours, a legend, and a tooltip sorted desc", () => {
    const { container } = wrapI18n(<MetricChart series={ov} times={times(4)} label="Network" unit=" MB/s" decimals={1} />);
    expect(container.querySelectorAll('[data-testid^="chart-line-"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="chart-line-in"]')!.getAttribute("stroke")).toBe("var(--chart-1)");
    expect(container.querySelector('[data-testid="chart-line-out"]')!.getAttribute("stroke")).toBe("var(--chart-2)");
    expect(within(screen.getByTestId("chart-legend")).getAllByRole("listitem")).toHaveLength(2);
    // Each legend entry carries that series' latest value (the multi-series header has none).
    const legendVals = () => within(screen.getByTestId("chart-legend")).getAllByRole("listitem").map((li) => li.textContent);
    expect(legendVals()).toEqual(["Net in4.0 MB/s", "Net out9.0 MB/s"]);
    expect(screen.queryByTestId("chart-stats")).toBeNull(); // per-series stats are single-series only
    const slider = screen.getByRole("slider", { name: "Network" });
    fireEvent.keyDown(slider, { key: "Home" }); // legend values follow the hovered point
    expect(legendVals()).toEqual(["Net in1.0 MB/s", "Net out4.0 MB/s"]);
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(legendVals()).toEqual(["Net in4.0 MB/s", "Net out9.0 MB/s"]);
    fireEvent.focus(slider); // newest point: in=4.0, out=9.0
    const rows = within(screen.getByTestId("chart-tooltip")).getAllByTestId("chart-tooltip-row");
    expect(rows.map((r) => r.textContent)).toEqual(["Net out9.0 MB/s", "Net in4.0 MB/s"]); // largest first
    expect(screen.queryByTestId("chart-tooltip-total")).toBeNull();
    expect(container.querySelectorAll('[data-testid="chart-hover-dot"]')).toHaveLength(2);
    expect(slider.getAttribute("aria-valuetext")).toContain("Net out 9.0 MB/s");
  });

  it("stacked: a filled segment per series, y-axis covers the total, tooltip adds a Total row", () => {
    const stack: ChartSeries[] = [
      { key: "used", label: "Used", values: [10, 20, 30], kind: "stacked" },
      { key: "cache", label: "Cache", values: [5, 5, 10], kind: "stacked" },
      { key: "free", label: "Free", values: [85, 75, 60], kind: "stacked" },
    ];
    const { container } = wrapI18n(<MetricChart series={stack} times={times(3)} label="RAM" unit="%" />);
    expect(container.querySelectorAll('[data-testid^="chart-stack-"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid^="chart-line-"]')).toHaveLength(0);
    expect(screen.getByTestId("chart-total").textContent).toBe("100%"); // header = total of the newest point
    fireEvent.focus(screen.getByRole("slider", { name: "RAM" }));
    const tip = screen.getByTestId("chart-tooltip");
    expect(within(tip).getAllByTestId("chart-tooltip-row")).toHaveLength(3);
    expect(within(tip).getByTestId("chart-tooltip-total").textContent).toBe("Total100%");
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("stacked totals above 100% auto-extend a percent axis instead of clipping", () => {
    wrapI18n(
      <MetricChart
        series={[
          { key: "a", label: "A", values: [80, 90], kind: "stacked" },
          { key: "b", label: "B", values: [80, 90], kind: "stacked" },
        ]}
        label="X"
        unit="%"
      />,
    );
    expect(screen.getByText("200%")).toBeTruthy();
  });

  it("hide-when-empty: an all-NaN series is dropped (no line, no legend entry); survivors keep their slot colour", () => {
    const { container } = wrapI18n(
      <MetricChart
        series={[
          { key: "a", label: "A", values: [NaN, NaN, NaN] },
          { key: "b", label: "B", values: [1, 2, 3] },
          { key: "c", label: "C", values: [3, 2, 1] },
        ]}
        label="Load"
        unit=""
      />,
    );
    expect(container.querySelector('[data-testid="chart-line-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-line-b"]')!.getAttribute("stroke")).toBe("var(--chart-2)"); // not repainted
    expect(within(screen.getByTestId("chart-legend")).queryByText("A")).toBeNull();
    expect(within(screen.getByTestId("chart-legend")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("hide-when-empty: if ALL series are empty the no-data state shows", () => {
    wrapI18n(
      <MetricChart
        series={[
          { key: "a", label: "A", values: [NaN, NaN] },
          { key: "b", label: "B", values: [] },
        ]}
        label="Load"
        unit=""
      />,
    );
    expect(screen.getByText("No data in this range")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Load" }).getAttribute("aria-valuetext")).toBe("No data in this range");
  });

  it("NaN inside a v2 series breaks the line (no false bridge)", () => {
    const { container } = wrapI18n(<MetricChart series={[{ key: "a", label: "A", values: [1, 2, NaN, 4, 5] }]} label="X" unit=" u" />);
    expect(container.querySelector('[data-testid="chart-line-a"]')!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
  });

  it("gap-as-break: a collection gap splits the path and shades the gap (aria-hidden)", () => {
    const ts = [0, 60_000, 120_000, 600_000, 660_000, 720_000].map((x) => T0 + x);
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3, 4, 5, 6]} times={ts} interval={60_000} label="CPU" unit="%" />);
    const d = container.querySelector('[data-testid="chart-line-value"]')!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(2); // broken in two, no straight bridge
    const gap = screen.getByTestId("chart-gap");
    expect(gap.getAttribute("aria-hidden")).toBe("true");
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("LTTB-style irregular but gap-free times with NO interval → one unbroken run, no gap shading (no inferred gaps)", () => {
    // spacing wanders ~0..2x the 60s bucket exactly like the hub's LTTB downsample
    const steps = [5, 118, 60, 2, 119, 61, 3, 117, 59, 120, 1, 118];
    const ts: number[] = [T0];
    for (const st of steps) ts.push(ts[ts.length - 1] + st * 1000);
    const { container } = wrapI18n(<MetricChart data={ts.map((_, i) => i + 1)} times={ts} label="CPU" unit="%" />);
    expect(container.querySelector('[data-testid="chart-line-value"]')!.getAttribute("d")!.match(/M/g)).toHaveLength(1);
    expect(screen.queryByTestId("chart-gap")).toBeNull();
  });

  it("an LTTB-jittery series stays unbroken even with an interval (steps <= 2x never exceed the 3x tolerance)", () => {
    const ts = [0, 118_000, 123_000, 241_000, 301_000].map((x) => T0 + x);
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3, 4, 5]} times={ts} interval={60_000} label="CPU" unit="%" />);
    expect(container.querySelector('[data-testid="chart-line-value"]')!.getAttribute("d")!.match(/M/g)).toHaveLength(1);
    expect(screen.queryByTestId("chart-gap")).toBeNull();
  });

  it("no gap when sampling is regular → a single unbroken path, no gap shading", () => {
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3, 4]} times={times(4)} label="CPU" unit="%" />);
    expect(container.querySelector('[data-testid="chart-line-value"]')!.getAttribute("d")!.match(/M/g)).toHaveLength(1);
    expect(screen.queryByTestId("chart-gap")).toBeNull();
  });

  it("Avg | Peak toggle (opt-in): default Avg keeps the band; Peak plots the peak line", () => {
    wrapI18n(<MetricChart data={[10, 20, 30]} peaks={[15, 90, 30]} times={times(3)} label="CPU" unit="%" peakToggle />);
    const group = screen.getByRole("group", { name: "Value shown" });
    const [avgBtn, peakBtn] = within(group).getAllByRole("button");
    expect(avgBtn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chart-peak-band")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy(); // header = newest avg
    fireEvent.click(peakBtn);
    expect(peakBtn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("chart-peak-band")).toBeNull();
    const slider = screen.getByRole("slider", { name: "CPU" });
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    const tip = screen.getByTestId("chart-tooltip");
    expect(within(tip).getByText("90%")).toBeTruthy();
    expect(within(tip).getByText("Avg 20%")).toBeTruthy();
  });

  it("no toggle controls unless asked (callers that pass peaks are unchanged)", () => {
    wrapI18n(<MetricChart data={[10, 20, 30]} peaks={[15, 90, 30]} times={times(3)} label="CPU" unit="%" />);
    expect(screen.queryByRole("group", { name: "Value shown" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("table view (opt-in): swaps the chart for an accessible table of time × series values", () => {
    wrapI18n(<MetricChart series={ov} times={times(4)} label="Network" unit=" MB/s" decimals={1} tableToggle />);
    expect(screen.getByRole("slider", { name: "Network" })).toBeTruthy();
    const btn = screen.getByRole("button", { name: "View as table" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("slider")).toBeNull();
    const table = screen.getByRole("table", { name: "Network — Table" });
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Time", "Net in", "Net out"]);
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 4);
    expect(within(table).getByText("9.0 MB/s")).toBeTruthy();
    fireEvent.click(btn); // back to the chart
    expect(screen.getByRole("slider", { name: "Network" })).toBeTruthy();
  });

  it("no table toggle by default", () => {
    wrapI18n(<MetricChart data={[1, 2]} label="CPU" unit="%" />);
    expect(screen.queryByRole("button", { name: "View as table" })).toBeNull();
  });

  it("single-series NaN never prints a literal 'NaN' (tooltip value + aria-valuetext) — it reads as an em dash / No data", () => {
    const { container } = wrapI18n(<MetricChart series={[{ key: "a", label: "A", values: [1, 2, NaN, 4, 5] }]} label="X" unit="u" />);
    const slider = screen.getByRole("slider", { name: "X" });
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).not.toContain("NaN");
    expect(slider.getAttribute("aria-valuetext")).toContain("No data");
    expect(screen.getByTestId("chart-tooltip").textContent).toBe("—");
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("stacked: a point where every stacked series is missing breaks the stack and reads 'No data', not 'Total 0'", () => {
    const st: ChartSeries[] = [
      { key: "u", label: "User", values: [10, NaN, 10], kind: "stacked" },
      { key: "s", label: "System", values: [10, NaN, 10], kind: "stacked" },
    ];
    const { container } = wrapI18n(<MetricChart series={st} label="CPU" unit="%" />);
    // runs [0,0] and [2,2] are single points → no band is drawn (the hole is never a zero-height bridge)
    expect(container.querySelector('[data-testid="chart-stack-u"]')).toBeNull();
    expect(container.innerHTML).not.toContain("NaN");
    const slider = screen.getByRole("slider", { name: "CPU" });
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuetext")).toContain("No data");
    expect(slider.getAttribute("aria-valuetext")).not.toContain("Total");
    expect(screen.queryByTestId("chart-tooltip-total")).toBeNull();
    expect(screen.getByTestId("chart-tooltip-nodata")).toBeTruthy();
  });

  it("stacked: a longer stack with one fully-missing point draws two separate bands (no bridge through the hole)", () => {
    const vals = (a: number[]) => a;
    const st: ChartSeries[] = [
      { key: "u", label: "User", values: vals([10, 12, NaN, 11, 13]), kind: "stacked" },
      { key: "s", label: "System", values: vals([5, 6, NaN, 5, 7]), kind: "stacked" },
    ];
    const { container } = wrapI18n(<MetricChart series={st} label="CPU" unit="%" />);
    expect(container.querySelector('[data-testid="chart-stack-u"]')!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
  });

  it("multi-series carry a non-colour dash encoding per slot (lines + legend swatch); a lone series stays solid", () => {
    const { container } = wrapI18n(<MetricChart series={ov} label="Network" unit=" MB/s" />);
    expect(container.querySelector('[data-testid="chart-line-in"]')!.getAttribute("stroke-dasharray")).toBeNull(); // slot 1 solid
    const dashOut = container.querySelector('[data-testid="chart-line-out"]')!.getAttribute("stroke-dasharray");
    expect(dashOut).toBe(seriesDash(1));
    expect(dashOut).toBeTruthy();
    const sw = Array.from(container.querySelectorAll('[data-testid="chart-legend-swatch"]')).map((e) => e.getAttribute("data-dash"));
    expect(sw).toEqual(["solid", seriesDash(1)]);
    expect(new Set([0, 1, 2, 3, 4, 5].map((i) => seriesDash(i) ?? "solid")).size).toBe(6);
  });

  it("the plotting svg is overflow:visible so edge hover dots are not clipped", () => {
    const { container } = wrapI18n(<MetricChart data={[1, 2, 3]} label="CPU" unit="%" />);
    expect((container.querySelector("svg") as SVGElement).style.overflow).toBe("visible");
  });

  it("lone series without controls keeps the original non-wrapping header; multi-series/controls may wrap", () => {
    const a = wrapI18n(<MetricChart data={[1, 2, 3]} label="CPU" unit="%" />);
    const hdr = a.container.firstElementChild!.firstElementChild as HTMLElement;
    expect(hdr.style.flexWrap).toBe("");
    a.unmount();
    const b = wrapI18n(<MetricChart series={ov} label="Network" unit=" MB/s" />);
    expect((b.container.firstElementChild!.firstElementChild as HTMLElement).style.flexWrap).toBe("wrap");
  });

  it("table view: region and table have distinct names, and a time gap is marked in the table", () => {
    const ts = [0, 60_000, 120_000, 600_000].map((x) => T0 + x);
    wrapI18n(<MetricChart series={ov} times={ts} interval={60_000} label="Network" unit=" MB/s" tableToggle />);
    fireEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getByRole("region", { name: "Network" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Network — Table" })).toBeTruthy();
    expect(screen.getAllByTestId("chart-table-gap")).toHaveLength(1);
  });

  it("ChartCard: title + description + controls slot + body, labelled region", () => {
    wrapI18n(
      <ChartCard title="Network" description="Bytes in and out per second" controls={<button>Opt</button>}>
        <MetricChart bare data={[1, 2]} label="Net" unit="%" />
      </ChartCard>,
    );
    expect(screen.getByRole("region", { name: "Network" })).toBeTruthy();
    expect(screen.getByText("Bytes in and out per second")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Opt" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Net" })).toBeTruthy();
  });

  describe("true-pixel sizing (ResizeObserver)", () => {
    const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    afterEach(() => {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
    });

    it("does not crash in jsdom without ResizeObserver and falls back to a sane viewBox", () => {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
      const { container } = wrapI18n(<MetricChart data={[1, 2, 3]} label="CPU" unit="%" />);
      expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 600 140");
      expect(container.querySelector("svg")!.getAttribute("preserveAspectRatio")).toBeNull(); // no distortion
    });

    it("draws at the measured pixel width: viewBox follows the observer; observer disconnects on unmount", () => {
      const disconnect = vi.fn();
      let cb: ((e: { contentRect: { width: number } }[]) => void) | undefined;
      class RO {
        constructor(c: typeof cb) {
          cb = c;
        }
        observe() {}
        disconnect = disconnect;
      }
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
      const { container, unmount } = wrapI18n(<MetricChart data={[1, 2, 3]} label="CPU" unit="%" />);
      act(() => cb!([{ contentRect: { width: 320 } }]));
      expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 320 140");
      const slider = screen.getByRole("slider", { name: "CPU" });
      fireEvent.focus(slider);
      // the newest point now sits at x = 320 (true px), not 600
      expect(screen.getByTestId("chart-crosshair").getAttribute("x1")).toBe("320");
      unmount();
      expect(disconnect).toHaveBeenCalled();
    });
  });

  it("theme-aware: multi-series colours are CSS variables (no hard-coded hex)", () => {
    const { container } = wrapI18n(<MetricChart series={ov} times={times(4)} label="Network" unit=" MB/s" tableToggle />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
