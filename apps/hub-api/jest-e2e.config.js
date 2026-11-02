/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  testTimeout: 30000,
  // e2e spins up real WS servers (agent/terminal gateways); a stray socket at teardown must never hang
  // the whole CI job for the 6h GitHub Actions ceiling. Force a clean exit once all suites finish.
  forceExit: true,
  // Run spec FILES serially (one worker). Every file shares the ONE e2e Postgres, and the hub has
  // process-global singletons that span files: the first registered user becomes the instance owner, and
  // each file's app boot runs an unscoped DeploymentReconcileService (QUEUED->CANCELLED over the whole DB).
  // Run in parallel, these cross-contaminate — whichever worker wins a boot/first-user race flips another
  // file's expectation (e.g. a transiently-QUEUED compose deploy reaped to CANCELLED, or instance-api-gating
  // seeing a non-owner first user). This is a shared-DB TEST artifact (prod is a single hub + single DB), so
  // serializing files is the correct fix; within-file concurrency is unaffected. Reproduces only under the
  // CPU contention of a CI runner (passes on a fast dev box in parallel), so it reads as a mystery flake.
  maxWorkers: 1,
  // Same fail-closed env defaults as the unit config (CI service DATABASE_URL/REDIS_URL win via ??=).
  setupFiles: ["<rootDir>/src/test-env.setup.ts"],
  // Opens registration once for the shared e2e DB so the gate doesn't block the suite's multi-user specs.
  globalSetup: "<rootDir>/test/e2e-global-setup.js",
};
