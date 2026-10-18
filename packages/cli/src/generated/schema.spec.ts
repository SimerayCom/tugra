import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The generated types are a pure, deterministic function of the committed OpenAPI contract. This guard
// regenerates them from the current openapi.json and asserts the committed file is byte-identical — so it
// fails whenever the API surface changed but nobody ran `pnpm --filter @tugra/cli generate:api`. The
// openapi-typescript version is lockfile-pinned, so the output is reproducible in CI.
const SPEC = path.resolve(__dirname, "../../../../apps/hub-api/openapi.json");
const SCHEMA = path.resolve(__dirname, "schema.ts");

function openapiTsBin(): string {
  const pkgJson = require.resolve("openapi-typescript/package.json");
  const bin = (JSON.parse(fs.readFileSync(pkgJson, "utf8")).bin as { "openapi-typescript": string })[
    "openapi-typescript"
  ];
  return path.resolve(path.dirname(pkgJson), bin);
}

describe("generated API schema (openapi-typescript)", () => {
  it("is byte-identical to a fresh regeneration from openapi.json", () => {
    const tmp = path.join(os.tmpdir(), `tugra-schema-${process.pid}.ts`);
    try {
      // Run the ESM bin as a subprocess (no jest ESM-import issues), same invocation as `generate:api`.
      execFileSync(process.execPath, [openapiTsBin(), SPEC, "-o", tmp], { stdio: "pipe", timeout: 60_000 });
      expect(fs.readFileSync(SCHEMA, "utf8")).toBe(fs.readFileSync(tmp, "utf8"));
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});
