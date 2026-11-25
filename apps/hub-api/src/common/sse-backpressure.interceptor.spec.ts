import { firstValueFrom, Subject, toArray } from "rxjs";
import { stallGuard, SseBackpressureInterceptor } from "./sse-backpressure.interceptor";

describe("stallGuard", () => {
  const msg = (n: number) => ({ data: "x".repeat(n) });

  it("passes everything through while the client keeps draining", async () => {
    const src = new Subject<{ data: string }>();
    const out = firstValueFrom(src.pipe(stallGuard(() => false, 100), toArray()));
    for (let i = 0; i < 50; i++) src.next(msg(50));
    src.complete();
    expect((await out).length).toBe(50);
  });

  it("completes the stream once a stalled client has queued more than the budget (runs the source teardown)", async () => {
    let torndown = false;
    const src = new Subject<{ data: string }>();
    const seen: unknown[] = [];
    const sub = src.pipe(stallGuard(() => true, 100)).subscribe({ next: (v) => seen.push(v), complete: () => (torndown = true) });
    src.next(msg(60)); // 60 queued
    expect(seen.length).toBe(1);
    src.next(msg(60)); // 120 > 100 → closed, message dropped
    expect(seen.length).toBe(1);
    expect(torndown).toBe(true);
    expect(src.observed).toBe(false); // unsubscribed from the producer
    sub.unsubscribe();
  });

  it("resets the budget when the response drains (a slow reader is not cut off)", async () => {
    let stalled = true;
    const src = new Subject<{ data: string }>();
    const seen: unknown[] = [];
    src.pipe(stallGuard(() => stalled, 100)).subscribe((v) => seen.push(v));
    src.next(msg(90));
    stalled = false;
    src.next(msg(90)); // drained → counter reset
    stalled = true;
    src.next(msg(90));
    expect(seen.length).toBe(3);
  });
});

describe("SseBackpressureInterceptor", () => {
  const ctxFor = (handler: object, res: object) =>
    ({ getType: () => "http", getHandler: () => handler, switchToHttp: () => ({ getResponse: () => res }) }) as never;

  it("leaves non-SSE handlers untouched", async () => {
    const handler = () => undefined;
    const next = { handle: jest.fn().mockReturnValue("passthrough") };
    expect(new SseBackpressureInterceptor().intercept(ctxFor(handler, {}), next as never)).toBe("passthrough");
  });

  it("guards @Sse handlers using the response's drain state", () => {
    const handler = () => undefined;
    Reflect.defineMetadata("__sse__", true, handler);
    const src = new Subject<{ data: string }>();
    const res = { writableNeedDrain: true };
    const next = { handle: () => src.asObservable() };
    let done = false;
    new SseBackpressureInterceptor().intercept(ctxFor(handler, res), next as never).subscribe({ complete: () => (done = true) });
    src.next({ data: "x".repeat(3 * 1024 * 1024) });
    expect(done).toBe(false);
    src.next({ data: "x".repeat(2 * 1024 * 1024) });
    expect(done).toBe(true);
  });
});
