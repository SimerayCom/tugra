import { describe, it, expect, vi } from "vitest";
import { subscribeToast, emitToast } from "./toast-bus";

describe("toast-bus", () => {
  it("delivers emitted toasts to subscribers", () => {
    const seen: unknown[] = [];
    const off = subscribeToast((t) => seen.push(t));
    emitToast("boom", "error");
    off();
    expect(seen).toEqual([{ message: "boom", type: "error" }]);
  });

  it("defaults the type to info", () => {
    const fn = vi.fn();
    const off = subscribeToast(fn);
    emitToast("hi");
    off();
    expect(fn).toHaveBeenCalledWith({ message: "hi", type: "info" });
  });

  it("stops delivering after unsubscribe", () => {
    const fn = vi.fn();
    const off = subscribeToast(fn);
    off();
    emitToast("nope", "info");
    expect(fn).not.toHaveBeenCalled();
  });

  it("fans out to multiple subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeToast(a);
    const offB = subscribeToast(b);
    emitToast("x", "success");
    offA();
    offB();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
