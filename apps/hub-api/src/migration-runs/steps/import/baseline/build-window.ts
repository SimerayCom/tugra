/**
 * What the builds cost inside the downtime window (R27/C5), pure. The freeze window of the original design held only data
 * (size / speed / extract): with dozens of Dockerfile builds on 2 CPU / 4 GB hosts the builds alone dwarf it. These numbers are
 * ASSUMPTIONS (nothing measures a build before the run does), and every place that shows them says "estimate".
 */
/** `deployConcurrency` is 1..8 (the run options' schema); the arithmetic clamps to the same range. */
const DEPLOY_CONCURRENCY_MAX = 8;
/** One image build of a git app, wall time on a small host. */
export const BUILD_SEC_ASSUMED = 240;
/** Starting an already built app (pull nothing, health gate, route). */
export const START_SEC_ASSUMED = 25;

export interface DeployWindow {
  buildSec: number;
  startSec: number;
  totalSec: number;
}

/**
 * The seconds DEPLOY_DARK adds to the downtime window. `builds` happen at `concurrency` per target server; an image already
 * built early (`earlyBuild`) costs only its start, so `builds` is then the count that REMAINS.
 */
export function deployWindow(input: { builds: number; starts: number; concurrency: number; targets: number }): DeployWindow {
  const slots = Math.max(1, Math.min(DEPLOY_CONCURRENCY_MAX, Math.floor(input.concurrency))) * Math.max(1, input.targets);
  const buildSec = Math.ceil(Math.max(0, input.builds) / slots) * BUILD_SEC_ASSUMED;
  const startSec = Math.ceil(Math.max(0, input.starts) / slots) * START_SEC_ASSUMED;
  return { buildSec, startSec, totalSec: buildSec + startSec };
}
