// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webRoot = resolve(__dirname, "../..");
const repoRoot = resolve(webRoot, "../..");

describe("production env default for the custom web server", () => {
  const original = process.env.NODE_ENV;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = original;
  });

  it("defaults NODE_ENV to production when unset (the stock `next start` did this; server.mjs must too)", async () => {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    // @ts-expect-error plain .mjs module without types
    await import("../../server/production-env.mjs");
    expect(process.env.NODE_ENV).toBe("production");
  });

  it("keeps an explicit NODE_ENV", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    // @ts-expect-error plain .mjs module without types
    await import("../../server/production-env.mjs");
    expect(process.env.NODE_ENV).toBe("development");
  });

  it("server.mjs loads the default before next (static imports evaluate in order)", () => {
    const src = readFileSync(resolve(webRoot, "server.mjs"), "utf8");
    const envIdx = src.indexOf('import "./server/production-env.mjs"');
    const nextIdx = src.indexOf('from "next"');
    expect(envIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(envIdx);
  });

  it("the web image and compose service pin NODE_ENV=production", () => {
    expect(readFileSync(resolve(repoRoot, "deploy/Dockerfile.web"), "utf8")).toMatch(/^ENV NODE_ENV=production$/m);
    const compose = readFileSync(resolve(repoRoot, "deploy/docker-compose.yml"), "utf8");
    const start = compose.indexOf("\n  web:");
    const end = compose.indexOf("\n    depends_on:", start);
    expect(compose.slice(start, end)).toMatch(/NODE_ENV: "production"/);
  });
});
