import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_VERSION } from "./version";

describe("CLI_VERSION", () => {
  it("is the version in the package's own package.json", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
