import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebounce } from "./useDebounce";

describe("useDebounce", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebounce("a", 400));
    expect(result.current).toBe("a");
  });

  it("only updates after the delay of no changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 400), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    expect(result.current).toBe("a"); // not yet
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("b"); // delay elapsed
  });

  it("resets the timer on rapid changes (only the last value lands)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 400), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    act(() => vi.advanceTimersByTime(200));
    rerender({ v: "c" });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe("a"); // "b" never landed — timer reset by "c"
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe("c");
  });
});
