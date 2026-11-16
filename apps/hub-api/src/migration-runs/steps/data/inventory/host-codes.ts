/**
 * The codes the `coolify-host-loop` runner adds to the data steps (the web renders `migrationRun.codes.<code>`, dots as
 * underscores; `run-codes-locale.spec.ts` fails when one has no sentence). The inventory cross-check has its own set in
 * `cross-check.ts` (`INVENTORY_CODES`).
 */
export const HOST_LOOP_CODES = {
  // DATA_SEED
  seedRun: "data-seed.host-loop-run",
  seedHostFailed: "data-seed.host-loop-host-failed",
  inventoryRun: "data-seed.host-inventory-run",
  dryPlan: "data-seed.dry.host-loop",
  sourceRunning: "data-seed.source-running",
  stopMigrators: "data-seed.host-loop-stop-migrators",
  noHosts: "data.host-loop-no-hosts",
  // per-host gate checks
  hostOk: "host-loop.host-ok",
  hostFailed: "host-loop.host-failed",
  hostPending: "host-loop.host-pending",
  // FREEZE
  freezeRun: "freeze.host-loop-run",
  freezeHostFailed: "freeze.host-loop-host-failed",
  freezeNoHost: "freeze.host-loop-no-host",
  freezeUnfreeze: "freeze.host-loop-unfreeze",
  freezeDryPlan: "freeze.dry.host-loop",
} as const;
