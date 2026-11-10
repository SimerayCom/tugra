import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { WorldMap, mapShapes, volumeBin, binFill } from "./world-map";

afterEach(cleanup);
const wrap = (rows: { country: string; requests: number }[]) =>
  render(
    <I18nProvider>
      <WorldMap rows={rows} />
    </I18nProvider>,
  );
const bin = (a2: string) => Number(document.querySelector(`[data-country="${a2}"]`)!.getAttribute("data-bin"));

describe("volumeBin / binFill", () => {
  it("is 0 for no/invalid data and 1..5 (monotonic, max=5) otherwise", () => {
    for (const v of [0, -1, NaN, Infinity]) expect(volumeBin(v, 100)).toBe(0);
    expect(volumeBin(5, 0)).toBe(0);
    expect(volumeBin(100, 100)).toBe(5);
    const bins = [1, 10, 100, 1000, 100000].map((v) => volumeBin(v, 100000));
    expect(bins).toEqual([...bins].sort((a, b) => a - b));
    expect(bins.every((b) => b >= 1 && b <= 5)).toBe(true);
  });
  it("uses theme tokens only (no hardcoded colours) and a neutral land fill for no data", () => {
    expect(binFill(0)).toContain("var(--c-tx3)");
    expect(binFill(3)).toContain("var(--c-a)");
    expect(binFill(3)).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("mapShapes", () => {
  it("projects the bundled topology (Antarctica dropped, Kosovo mapped to XK, US present)", () => {
    const shapes = mapShapes();
    expect(shapes.length).toBeGreaterThan(160);
    expect(shapes.every((s) => s.d.startsWith("M"))).toBe(true);
    expect(shapes.some((s) => s.alpha2 === "US")).toBe(true);
    expect(shapes.some((s) => s.alpha2 === "XK")).toBe(true);
    expect(shapes.some((s) => s.fallbackName === "Antarctica")).toBe(false);
  });
});

describe("WorldMap", () => {
  it("shades countries by volume; unknown/overflow codes shade nothing and do not throw", () => {
    wrap([{ country: "US", requests: 1000 }, { country: "DE", requests: 10 }, { country: "ZZ", requests: 500 }, { country: "??", requests: 5 }]);
    expect(bin("US")).toBe(5);
    expect(bin("DE")).toBeGreaterThanOrEqual(1);
    expect(bin("DE")).toBeLessThan(5);
    expect(bin("FR")).toBe(0);
    expect(screen.getByText("More (up to 1,000)")).toBeTruthy();
  });
  it("renders with an empty set: every country neutral, no throw", () => {
    wrap([]);
    const all = screen.getAllByTestId("world-map-country");
    expect(all.length).toBeGreaterThan(160);
    expect(all.every((p) => p.getAttribute("data-bin") === "0")).toBe(true);
    expect(screen.getByText("No data")).toBeTruthy();
  });
  it("is decorative-with-alternative: labelled figure, aria-hidden svg", () => {
    wrap([{ country: "US", requests: 3 }]);
    const fig = screen.getByTestId("world-map");
    expect(fig.getAttribute("aria-label")).toMatch(/Countries list/);
    expect(fig.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
  it("hover tooltip shows the localized country name and request count; no-data countries say so", () => {
    wrap([{ country: "US", requests: 1234 }]);
    fireEvent.pointerEnter(document.querySelector('[data-country="US"]')!);
    expect(screen.getByTestId("world-map-tooltip").textContent).toBe("United States: 1,234 requests");
    fireEvent.pointerEnter(document.querySelector('[data-country="FR"]')!);
    expect(screen.getByTestId("world-map-tooltip").textContent).toBe("France: no requests");
    fireEvent.pointerLeave(screen.getByTestId("world-map").firstElementChild!);
    expect(screen.queryByTestId("world-map-tooltip")).toBeNull();
  });
  it("tooltip falls back to the topology name for a feature Intl cannot name (Kosovo/XK)", () => {
    wrap([{ country: "XK", requests: 7 }]);
    expect(bin("XK")).toBeGreaterThanOrEqual(1);
    fireEvent.pointerEnter(document.querySelector('[data-country="XK"]')!);
    expect(screen.getByTestId("world-map-tooltip").textContent).toMatch(/: 7 requests$/);
  });
  it("touch tap persists the tooltip past pointerleave; an outside tap dismisses it", () => {
    wrap([{ country: "US", requests: 1234 }]);
    fireEvent.pointerDown(document.querySelector('[data-country="US"]')!, { pointerType: "touch" });
    expect(screen.getByTestId("world-map-tooltip").textContent).toBe("United States: 1,234 requests");
    fireEvent.pointerLeave(screen.getByTestId("world-map").firstElementChild!, { pointerType: "touch" });
    expect(screen.getByTestId("world-map-tooltip")).toBeTruthy();
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(screen.queryByTestId("world-map-tooltip")).toBeNull();
  });
  it("touch tooltip auto-dismisses after a timeout", () => {
    vi.useFakeTimers();
    try {
      wrap([{ country: "US", requests: 1 }]);
      fireEvent.pointerDown(document.querySelector('[data-country="US"]')!, { pointerType: "touch" });
      expect(screen.getByTestId("world-map-tooltip")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(4100);
      });
      expect(screen.queryByTestId("world-map-tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("tooltip wraps within the wrapper and its left edge is clamped to a measured box (no horizontal overflow)", () => {
    wrap([{ country: "US", requests: 1 }]);
    const wrapper = screen.getByTestId("world-map").firstElementChild as HTMLElement;
    wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 200 });
    try {
      fireEvent.pointerEnter(document.querySelector('[data-country="US"]')!, { clientX: 295, clientY: 50 });
      const tipEl = screen.getByTestId("world-map-tooltip");
      expect(tipEl.style.left).toBe("100px"); // 300 - 200, not 295 - 100 + overflow
      expect(tipEl.style.maxWidth).toBe("100%");
      fireEvent.pointerEnter(document.querySelector('[data-country="US"]')!, { clientX: 2, clientY: 50 });
      expect(screen.getByTestId("world-map-tooltip").style.left).toBe("0px");
    } finally {
      delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    }
  });
});
