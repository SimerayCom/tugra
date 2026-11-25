import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { AGENT_CAPABILITIES } from "@tugra/shared";
import { BulkCapabilitiesSchema, SetCapabilitiesSchema } from "../servers/dto/servers.schemas";
import { CoolifyCleanupModule } from "../coolify-cleanup/coolify-cleanup.module";
import { CoolifyCleanupService } from "../coolify-cleanup/coolify-cleanup.service";
import { CoolifyInPlaceModule } from "../coolify-inplace/coolify-inplace.module";
import { CoolifyInPlaceService } from "../coolify-inplace/coolify-inplace.service";
import { MigrationCampaignsModule } from "../migration-campaigns/migration-campaigns.module";
import { MigrationCampaignsService } from "../migration-campaigns/migration-campaigns.service";
import { ProjectMovesModule } from "../project-moves/project-moves.module";
import { ProjectMovesService } from "../project-moves/project-moves.service";
import { CoolifyHostGrantService } from "./coolify-host-grant.service";
import { CoolifySshInstallService } from "./coolify-ssh-install.service";
import { CoolifyTakeoverModule } from "./coolify-takeover.module";
import { HostMatchService } from "./host-match.service";
import { SealedChannelService } from "./sealed-channel.service";

const NEW = ["coolify_secrets", "coolify_ssh", "coolify_takeover", "coolify_cleanup"] as const;

describe("Coolify takeover contract: capabilities on the hub", () => {
  it("lets the generic capability schema parse the new names (a stored set must round-trip)", () => {
    for (const c of NEW) expect(SetCapabilitiesSchema.parse({ capabilities: [c] }).capabilities).toEqual([c]);
    expect(() => SetCapabilitiesSchema.parse({ capabilities: ["coolify_nope"] })).toThrow();
  });

  it("keeps them out of the bulk grant endpoint (negative: it only touches terminal, files, files_write, swarm)", () => {
    for (const c of NEW) expect(BulkCapabilitiesSchema.safeParse({ serverIds: ["s1"], grant: [c] }).success).toBe(false);
    for (const c of NEW) expect(BulkCapabilitiesSchema.safeParse({ serverIds: ["s1"], revoke: [c] }).success).toBe(false);
  });

  it("is the shared list the hub derives from", () => {
    for (const c of NEW) expect(AGENT_CAPABILITIES).toContain(c);
  });
});

describe("Coolify takeover contract: skeleton modules", () => {
  it("instantiates every still-empty takeover service on its own (no hidden dependency yet)", async () => {
    // Lanes B, C and D filled their services (they have their own specs); the rest are still empty here.
    const mod = await Test.createTestingModule({ providers: [ProjectMovesService] }).compile();
    for (const S of [ProjectMovesService]) expect(mod.get(S)).toBeInstanceOf(S);
  });

  it("registers the takeover services in the existing takeover module and exports them", () => {
    const providers = Reflect.getMetadata("providers", CoolifyTakeoverModule) as unknown[];
    const exported = Reflect.getMetadata("exports", CoolifyTakeoverModule) as unknown[];
    for (const S of [SealedChannelService, CoolifyHostGrantService, CoolifySshInstallService, HostMatchService]) {
      expect(providers).toContain(S);
      expect(exported).toContain(S);
    }
  });

  it.each([
    ["cleanup (G)", CoolifyCleanupModule, CoolifyCleanupService],
    ["in place (F)", CoolifyInPlaceModule, CoolifyInPlaceService],
    ["campaigns (E)", MigrationCampaignsModule, MigrationCampaignsService],
    ["project moves (H)", ProjectMovesModule, ProjectMovesService],
  ])("the new %s module compiles on its own and serves its empty service", async (_name, Mod, Svc) => {
    const mod = await Test.createTestingModule({ imports: [Mod as never] }).compile();
    expect(mod.get(Svc as never)).toBeInstanceOf(Svc);
  });

  it("wires the four new modules into AppModule", () => {
    const src = readFileSync(join(__dirname, "../app.module.ts"), "utf8");
    for (const name of ["CoolifyInPlaceModule", "CoolifyCleanupModule", "MigrationCampaignsModule", "ProjectMovesModule"]) {
      expect(src.match(new RegExp(`\\b${name}\\b`, "g"))?.length).toBeGreaterThanOrEqual(2); // the import and the imports[] entry
    }
  });

  it("the skeleton services are empty: no method, no field", () => {
    for (const S of [ProjectMovesService]) {
      expect(Object.getOwnPropertyNames(S.prototype)).toEqual(["constructor"]);
    }
  });
});

describe("Coolify takeover contract: Prisma state and migrations", () => {
  const dir = join(__dirname, "../../prisma/migrations");
  const names = readdirSync(dir).filter((n) => /^\d{14}_/.test(n)).sort();
  const mine = names.filter((n) => n >= "20261207010000");
  const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");

  it("adds seven migrations after the previous newest, strictly increasing, one per lane, with no duplicate timestamp", () => {
    // The contract's seven, then each lane's own later migrations in its band 202612080X0000 (X = 1 A, 2 B, 3 C, 4 D, 5 E, 6 F, 7 G, 8 H).
    expect(mine.filter((n) => n < "20261208").map((n) => n.slice(0, 14))).toEqual(["20261207010000", "20261207020000", "20261207030000", "20261207040000", "20261207050000", "20261207060000", "20261207070000"]);
    for (const n of mine.filter((n) => n >= "20261208")) expect(n).toMatch(/^202612080[1-8]0000_/);
    expect(new Set(names.map((n) => n.slice(0, 14))).size).toBe(names.length);
    const before = names.filter((n) => n < "20261207010000");
    expect(before[before.length - 1].slice(0, 14) < "20261207010000").toBe(true);
  });

  it("is additive: no drop, truncate, delete or column rewrite of an existing table", () => {
    for (const n of mine) {
      const sql = readFileSync(join(dir, n, "migration.sql"), "utf8");
      expect(sql).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b|\bDELETE FROM\b/i);
      expect(sql).not.toMatch(/ALTER COLUMN/i);
      expect(sql).not.toMatch(/SET NOT NULL/i);
    }
    // the one change to an existing table gives the new columns a default or leaves them null (existing rows stay valid)
    const alter = readFileSync(join(dir, "20261207010000_import_session_agent_transport/migration.sql"), "utf8");
    expect(alter).toContain(`ADD COLUMN     "transport" TEXT NOT NULL DEFAULT 'api'`);
    expect(alter).toMatch(/"snapshotEnc" TEXT,/);
  });

  it("declares every new model and the new ImportSession columns in the schema", () => {
    for (const m of ["CoolifyHostGrant", "CoolifySshTarget", "MigrationCampaign", "CoolifyTakeover", "CoolifyCleanup", "ProjectMove"]) expect(schema).toMatch(new RegExp(`^model ${m} \\{`, "m"));
    const session = /model ImportSession \{[\s\S]*?\n\}/.exec(schema)![0];
    for (const col of ["transport", "agentServerId", "snapshotEnc", "sessionKeyEnc"]) expect(session).toContain(col);
    expect(session).toMatch(/transport\s+String\s+@default\("api"\)/);
  });

  it("names every ciphertext column so the secrets rotation sees it (…Enc)", () => {
    expect(schema).toMatch(/recipientKeyEnc\s+String\?/);
    expect(schema).not.toMatch(/recipientPrivateKey|appKey|plainValue|secretValue/i);
  });

  it("cascades the consent and install rows with their server and team (a deleted server leaves no wrapped key behind)", () => {
    const grant = /model CoolifyHostGrant \{[\s\S]*?\n\}/.exec(schema)![0];
    expect(grant.match(/onDelete: Cascade/g)).toHaveLength(2);
    const target = /model CoolifySshTarget \{[\s\S]*?\n\}/.exec(schema)![0];
    expect(target.match(/onDelete: Cascade/g)).toHaveLength(2);
  });

  it("lane C's later migration only adds two nullable columns to its own table", () => {
    const sql = readFileSync(join(dir, "20261208030000_coolify_ssh_target_container/migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE "CoolifySshTarget" ADD COLUMN\s+"containerId" TEXT,\s*ADD COLUMN\s+"cancelledAt" TIMESTAMP\(3\);/);
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("each migration creates only its own lane's tables", () => {
    const expected: Record<string, string> = {
      "20261207020000_coolify_host_grant": "CoolifyHostGrant",
      "20261207030000_coolify_ssh_target": "CoolifySshTarget",
      "20261207040000_migration_campaign": "MigrationCampaign",
      "20261207050000_coolify_takeover": "CoolifyTakeover",
      "20261207060000_coolify_cleanup": "CoolifyCleanup",
      "20261207070000_project_move": "ProjectMove",
    };
    for (const [n, table] of Object.entries(expected)) {
      const sql = readFileSync(join(dir, n, "migration.sql"), "utf8");
      expect([...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual([table]);
    }
  });
});
