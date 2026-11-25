import { monitorEventLoopDelay, PerformanceObserver, type IntervalHistogram } from "perf_hooks";
import { getHeapStatistics } from "v8";

export interface HealthSample {
  t: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
  /** Garbage-collection time inside this window. */
  gcMs: number;
}

/** What a sample reads from. Injectable so the sampler is unit-testable without real memory pressure. */
export interface SamplerSources {
  now(): number;
  memory(): { rss: number; heapUsed: number; external: number };
  heapLimit(): number;
  /** Event-loop delay percentiles over the window since the last call, in ms; resets the window. */
  takeLoop(): { p50: number; p99: number; max: number };
  /** GC milliseconds since the last call; resets the counter. */
  takeGcMs(): number;
}

export const SAMPLE_EVERY_MS = 20_000;
/** 45 x 20 s = 15 minutes of history, ~4 KB. */
export const SAMPLE_KEEP = 45;

const NS_PER_MS = 1e6;

/** The real sources: process.memoryUsage, V8 heap limit, perf_hooks event-loop histogram and a GC PerformanceObserver. */
export function processSources(): SamplerSources & { stop(): void } {
  const hist: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  let gcMs = 0;
  const gc = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcMs += e.duration;
  });
  try {
    gc.observe({ entryTypes: ["gc"] });
  } catch {
    // GC entries are not available on every runtime build: the field just stays 0.
  }
  return {
    now: () => Date.now(),
    memory: () => {
      const m = process.memoryUsage();
      return { rss: m.rss, heapUsed: m.heapUsed, external: m.external };
    },
    heapLimit: () => getHeapStatistics().heap_size_limit,
    takeLoop: () => {
      // An empty histogram reports NaN/min-int: treat "no ticks yet" as 0.
      const ok = hist.count > 0;
      const r = ok ? { p50: hist.percentile(50) / NS_PER_MS, p99: hist.percentile(99) / NS_PER_MS, max: hist.max / NS_PER_MS } : { p50: 0, p99: 0, max: 0 };
      hist.reset();
      return r;
    },
    takeGcMs: () => {
      const v = gcMs;
      gcMs = 0;
      return v;
    },
    stop: () => {
      hist.disable();
      gc.disconnect();
    },
  };
}

/** Fixed-size in-memory ring of process samples. Nothing is persisted: a sample is a few numbers every 20 s. */
export class HubHealthSampler {
  private readonly ring: HealthSample[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sources: SamplerSources,
    private readonly keep = SAMPLE_KEEP,
  ) {}

  sample(): HealthSample {
    const mem = this.sources.memory();
    const loop = this.sources.takeLoop();
    const s: HealthSample = {
      t: this.sources.now(),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapLimitBytes: this.sources.heapLimit(),
      externalBytes: mem.external,
      loopP50Ms: loop.p50,
      loopP99Ms: loop.p99,
      loopMaxMs: loop.max,
      gcMs: this.sources.takeGcMs(),
    };
    this.ring.push(s);
    while (this.ring.length > this.keep) this.ring.shift();
    return s;
  }

  /** Start the periodic sample (unref'd so it never keeps the process alive). Takes one right away. */
  start(everyMs = SAMPLE_EVERY_MS): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latest(): HealthSample | null {
    return this.ring.length ? this.ring[this.ring.length - 1] : null;
  }

  history(): readonly HealthSample[] {
    return this.ring;
  }
}
