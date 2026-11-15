import "reflect-metadata";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { MigrationIngestController } from "../importer/migration-ingest.controller";
import { MigrationTokenGuard } from "../importer/migration-token.guard";
import { CutoverController } from "./cutover.controller";
import {
  CutoverCertPrepSchema, CutoverCheckSchema, CutoverExcludeSchema, CutoverFixCounterpartSchema, CutoverFlipPlanQuerySchema, CutoverFlipSchema, CutoverRevertSchema, CutoverSeedCertsSchema, CutoverTtlSchema,
  CutoverViewSchema,
} from "./cutover.dto";

const scopes = (fn: (...a: never[]) => unknown) => Reflect.getMetadata(REQUIRE_SCOPES, fn);
const P = CutoverController.prototype;
const HASH = "a".repeat(64);

describe("CutoverController scopes (the remap precedent)", () => {
  it("mutations are deploy-tier; the read-only view needs no write scope", () => {
    for (const f of [P.init, P.certPrepare, P.check, P.ttl, P.flip, P.cancel, P.revert, P.finalize, P.fixCounterpart, P.exclude]) expect(scopes(f as never)).toEqual(["deploy"]);
    expect(scopes(P.view as never)).toBeUndefined();
  });
  it("flip-plan decrypts the Cloudflare token, seed-certs moves key material: both need read:secrets", () => {
    expect(scopes(P.flipPlan as never)).toEqual(["read:secrets"]);
    expect(scopes(P.seedCerts as never)).toEqual(["deploy", "read:secrets"]);
  });
  it("is mounted under the op, behind the importer's ownership loader", () => {
    expect(Reflect.getMetadata("path", CutoverController)).toBe("import/operations/:opId/cutover");
  });
});

describe("request validation (zod)", () => {
  it("flip needs a 64-hex confirmToken and bounded pacing", () => {
    expect(CutoverFlipSchema.safeParse({}).success).toBe(false);
    expect(CutoverFlipSchema.safeParse({ confirmToken: "short" }).success).toBe(false);
    expect(CutoverFlipSchema.safeParse({ confirmToken: HASH }).success).toBe(true);
    for (const bad of [{ batchSize: 0 }, { batchSize: 26 }, { intervalSec: 4 }, { targetTtl: 30 }, { targetTtl: 4000 }]) expect(CutoverFlipSchema.safeParse({ confirmToken: HASH, ...bad }).success).toBe(false);
    expect(CutoverFlipSchema.safeParse({ confirmToken: HASH, batchSize: 5, intervalSec: 30, targetTtl: 60 }).success).toBe(true);
  });
  it("hostnames are lowercased and must be real hostnames (no wildcard, no scheme, no injection)", () => {
    expect(CutoverCertPrepSchema.parse({ challenge: "dns01", hostnames: ["A.Example.com"] }).hostnames).toEqual(["a.example.com"]);
    for (const h of ["*.example.com", "https://a.com", "a.com/x", "a b.com", "a.com; rm", "localhost"]) expect(CutoverCertPrepSchema.safeParse({ challenge: "http01", hostnames: [h] }).success).toBe(false);
    expect(CutoverExcludeSchema.safeParse({ hostnames: [], excluded: true }).success).toBe(false);
    expect(CutoverFlipPlanQuerySchema.safeParse({ targetTtl: "60", keepProxied: "false" }).success).toBe(true);
  });
  it("probe path, ttl bounds, counterpart direction, seed acknowledgement", () => {
    expect(CutoverCheckSchema.safeParse({ healthPath: "/health" }).success).toBe(true);
    expect(CutoverCheckSchema.safeParse({ healthPath: "health" }).success).toBe(false);
    expect(CutoverCheckSchema.safeParse({ healthPath: "/a b" }).success).toBe(false);
    expect(CutoverTtlSchema.safeParse({ ttl: 59 }).success).toBe(false);
    expect(CutoverFixCounterpartSchema.safeParse({ applicationId: "a1", direction: "sideways" }).success).toBe(false);
    expect(CutoverSeedCertsSchema.safeParse({}).success).toBe(false);
    expect(CutoverRevertSchema.safeParse({ hostnames: ["a.example.com"], acknowledgeDataLoss: true }).success).toBe(true);
  });
});

describe("secret-free view", () => {
  it("carries no field that could hold a token, key, PEM or ledger", () => {
    const names = JSON.stringify(Object.keys((CutoverViewSchema.shape.entries.element as unknown as { shape: Record<string, unknown> }).shape)) + JSON.stringify(Object.keys(CutoverViewSchema.shape));
    expect(names).not.toMatch(/token|key|pem|ledger|secret|password|apiToken|keyEnc|dnsCreds/i);
  });
});

describe("migrator ingest cert routes", () => {
  it("sit behind the migration-token guard (controller-level) and are not in the public API docs", () => {
    expect(Reflect.getMetadata("__guards__", MigrationIngestController)).toEqual([MigrationTokenGuard]);
    expect(Reflect.getMetadata("swagger/apiExcludeController", MigrationIngestController)).toBeTruthy();
    const proto = MigrationIngestController.prototype;
    expect(Reflect.getMetadata("path", proto.certsWanted)).toBe("certs/wanted");
    expect(Reflect.getMetadata("path", proto.putCerts)).toBe("certs");
  });
});
