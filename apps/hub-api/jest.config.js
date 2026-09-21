/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  // Set fail-closed env defaults BEFORE any module (incl. AppModule → validateEnv) loads, so specs pass
  // in a clean CI runner, not just a dev shell that happens to export them.
  setupFiles: ["<rootDir>/test-env.setup.ts"],
};
