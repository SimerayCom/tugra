import type { DefaultJobOptions } from "bullmq";

/**
 * Bound how many finished jobs each BullMQ queue keeps in Redis. Our scheduler queues run repeatable jobs
 * (a monitor checking every 30s is ~2,880 runs/day), and any job history we actually surface to users lives
 * in Postgres tables — not in the BullMQ job itself. Without a cap, completed and failed jobs pile up in
 * Redis forever, a slow memory leak that eventually pressures the hub's Redis. Keep a small recent window
 * per queue for debugging; drop the rest.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: 20,
  removeOnFail: 50,
};
