import type { TickSchedulerService, TickSpec } from "../tick-scheduler.service";

/** Spec double for {@link TickSchedulerService}: records what a feature service registered and lets a spec run it. */
export class FakeTicks {
  readonly registered: TickSpec[] = [];
  readonly disabled: string[] = [];
  readonly handlers = new Map<string, (job: { name: string; data: unknown }) => unknown>();
  readonly enqueued: Array<{ name: string; data: object; jobId: string; at: Date }> = [];
  readonly removed: string[] = [];
  enabled = true;

  async register(spec: TickSpec): Promise<void> {
    this.registered.push(spec);
  }
  async disable(name: string): Promise<void> {
    this.disabled.push(name);
  }
  handle(name: string, run: (job: { name: string; data: unknown }) => unknown): void {
    this.handlers.set(name, run);
  }
  async enqueueAt(name: string, data: object, jobId: string, at: Date): Promise<void> {
    this.enqueued.push({ name, data, jobId, at });
  }
  async removeJob(jobId: string): Promise<void> {
    this.removed.push(jobId);
  }

  /** The spec of a registered tick. */
  spec(name: string): TickSpec {
    const s = [...this.registered].reverse().find((r) => r.name === name);
    if (!s) throw new Error(`tick ${name} was not registered (have: ${this.registered.map((r) => r.name).join(", ") || "none"})`);
    return s;
  }
  /** Run a registered tick's handler once, like the scheduler worker would. */
  async run(name: string): Promise<void> {
    await this.spec(name).run();
  }
  asService(): TickSchedulerService {
    return this as unknown as TickSchedulerService;
  }
}
