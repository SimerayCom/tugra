// @vitest-environment node
import { describe, expect, it } from "vitest";
import { standaloneConfigEnv } from "../../server/standalone-config.mjs";

const noEnv = {} as NodeJS.ProcessEnv;
const manifest = (config: unknown) => () => JSON.stringify({ version: 1, config });

describe("standaloneConfigEnv", () => {
  it("serializes the build config of a standalone output", () => {
    const config = { output: "standalone", distDir: "./.next", poweredByHeader: false };
    expect(standaloneConfigEnv("/app/apps/web", noEnv, manifest(config) as never)).toBe(JSON.stringify(config));
  });

  it("reads the manifest from the .next directory of the app", () => {
    let seen = "";
    standaloneConfigEnv("/app/apps/web", noEnv, ((p: string) => {
      seen = p;
      return JSON.stringify({ config: { output: "standalone" } });
    }) as never);
    expect(seen).toBe("/app/apps/web/.next/required-server-files.json");
  });

  it("does nothing for a regular (non-standalone) build", () => {
    expect(standaloneConfigEnv("/app/apps/web", noEnv, manifest({ distDir: ".next" }) as never)).toBeUndefined();
  });

  it("does nothing when the manifest is missing or unreadable", () => {
    const throws = () => {
      throw new Error("ENOENT");
    };
    expect(standaloneConfigEnv("/app/apps/web", noEnv, throws as never)).toBeUndefined();
    expect(standaloneConfigEnv("/app/apps/web", noEnv, (() => "not json") as never)).toBeUndefined();
  });

  it("never overrides a value that is already set", () => {
    const read = () => {
      throw new Error("should not be read");
    };
    expect(standaloneConfigEnv("/app/apps/web", { __NEXT_PRIVATE_STANDALONE_CONFIG: "{}" } as never, read as never)).toBeUndefined();
  });
});
