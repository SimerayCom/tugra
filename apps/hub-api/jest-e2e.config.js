/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  testTimeout: 30000,
};
