import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapService, type CoolifyService } from "../sources/coolify-map";
import type { ForeignService } from "../foreign-fleet";

/**
 * Loader for the 19 scrubbed real Coolify service shapes (`__fixtures__/coolify-services/*.json`). UNVERIFIED against live
 * Coolify (probe C0 not approved): see the `_fixture` header in every file.
 */
export interface ServiceFixture {
  file: string;
  raw: CoolifyService & { docker_compose?: string };
  svc: ForeignService;
}

const DIR = join(__dirname, "..", "__fixtures__", "coolify-services");

export function loadServiceFixtures(): ServiceFixture[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(DIR, file), "utf8")) as CoolifyService & { docker_compose?: string };
      return { file, raw, svc: mapService(raw, { serverRef: raw.server?.uuid ?? undefined }) };
    });
}

export const fixtureByName = (name: string): ServiceFixture => {
  const f = loadServiceFixtures().find((x) => x.raw.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

/** The config files signoz keeps next to its compose (synthetic content). */
export const SIGNOZ_FILES = [
  "clickhouse/custom-function.xml",
  "clickhouse/cluster.xml",
  "clickhouse/users.xml",
  "clickhouse/config.xml",
  "prometheus.yml",
  "otel-collector-config.yaml",
  "otel-collector-opamp-config.yaml",
].map((path) => ({ path, content: `<!-- synthetic ${path} -->\n` }));
