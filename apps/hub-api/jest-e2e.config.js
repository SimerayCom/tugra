/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  testTimeout: 30000,
  // Same fail-closed env defaults as the unit config (CI service DATABASE_URL/REDIS_URL win via ??=).
  setupFiles: ["<rootDir>/src/test-env.setup.ts"],
  // Opens registration once for the shared e2e DB so the gate doesn't block the suite's multi-user specs.
  globalSetup: "<rootDir>/test/e2e-global-setup.js",
};
