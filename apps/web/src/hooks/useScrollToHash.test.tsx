import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollToHash } from "./useScrollToHash";

// Manual rAF queue so a test decides when each frame fires.
let queue: Array<() => void> = [];
function flushFrame() {
  const run = queue;
  queue = [];
  run.forEach((fn) => fn());
}

beforeEach(() => {
  queue = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    queue.push(() => cb(0));
    return queue.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    queue = [];
  });
  window.history.replaceState(null, "", "/projects/p1");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

function addNode(id: string) {
  const el = document.createElement("div");
  el.id = id;
  el.scrollIntoView = vi.fn();
  document.body.appendChild(el);
  return el;
}

describe("useScrollToHash", () => {
  it("scrolls to the node once it appears late, then drops the hash", () => {
    window.history.replaceState(null, "", "/projects/p1#env-e1");
    renderHook(() => useScrollToHash("env-", true));
    flushFrame();
    flushFrame();
    const el = addNode("env-e1");
    flushFrame();
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/projects/p1");
  });

  it("gives up after 40 frames", () => {
    window.history.replaceState(null, "", "/projects/p1#env-e1");
    renderHook(() => useScrollToHash("env-", true));
    let frames = 0;
    while (queue.length && frames < 200) {
      flushFrame();
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(42);
    expect(queue.length).toBe(0);
    // hash is left alone when nothing was found
    expect(window.location.hash).toBe("#env-e1");
  });

  it("ignores a hash that does not match the prefix", () => {
    window.history.replaceState(null, "", "/projects/p1#other-e1");
    const el = addNode("other-e1");
    renderHook(() => useScrollToHash("env-", true));
    expect(queue.length).toBe(0);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it("waits for ready", () => {
    window.history.replaceState(null, "", "/projects/p1#env-e1");
    const el = addNode("env-e1");
    const { rerender } = renderHook(({ ready }) => useScrollToHash("env-", ready), { initialProps: { ready: false } });
    expect(queue.length).toBe(0);
    rerender({ ready: true });
    flushFrame();
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
