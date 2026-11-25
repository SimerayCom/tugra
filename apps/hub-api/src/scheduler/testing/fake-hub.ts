import type { QueueHubService } from "../queue-hub.service";

type Processor = (job: { name: string; data: unknown }) => Promise<unknown> | unknown;

/** Spec double for {@link QueueHubService}: hands out recording fake queues/workers and never touches Redis. */
export class FakeHub {
  readonly queues = new Map<string, FakeQueue>();
  readonly processors = new Map<string, Processor>();
  readonly workerOpts = new Map<string, unknown>();
  enabled = true;

  queue(name: string): FakeQueue {
    const q = new FakeQueue(name);
    this.queues.set(name, q);
    return q;
  }
  worker(name: string, processor: Processor, opts?: unknown): { on: () => void; close: () => Promise<void> } {
    this.processors.set(name, processor);
    this.workerOpts.set(name, opts);
    return { on: () => undefined, close: async () => undefined };
  }
  asService(): QueueHubService {
    return this as unknown as QueueHubService;
  }
}

export class FakeQueue {
  readonly added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  repeatables: Array<{ name: string; key: string }> = [];
  readonly removedKeys: string[] = [];
  /** Job schedulers by id (BullMQ upsertJobScheduler). */
  readonly schedulers = new Map<string, { repeat: unknown; template: unknown }>();
  readonly removedJobs: string[] = [];
  constructor(readonly name: string) {}
  async upsertJobScheduler(id: string, repeat: unknown, template: unknown): Promise<void> {
    this.schedulers.set(id, { repeat, template });
  }
  async getJobScheduler(id: string): Promise<{ every?: number } | undefined> {
    const r = this.schedulers.get(id)?.repeat as { every?: number } | undefined;
    return r ? { every: r.every } : undefined;
  }
  async removeJobScheduler(id: string): Promise<boolean> {
    return this.schedulers.delete(id);
  }
  async remove(jobId: string): Promise<number> {
    this.removedJobs.push(jobId);
    return 1;
  }
  async add(name: string, data: unknown, opts: unknown): Promise<void> {
    this.added.push({ name, data, opts });
  }
  async getRepeatableJobs(): Promise<Array<{ name: string; key: string }>> {
    return this.repeatables;
  }
  async removeRepeatableByKey(key: string): Promise<boolean> {
    this.removedKeys.push(key);
    return true;
  }
}
