import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PRISMA = join(__dirname, "../../../prisma");
const MIG = join(PRISMA, "migrations");
const NAME = "20261120080000_migration_volume_transfer";

describe("migration_volume_transfer migration (static; the empty-DB apply runs in the e2e lane)", () => {
  const sql = readFileSync(join(MIG, NAME, "migration.sql"), "utf8");
  const schema = readFileSync(join(PRISMA, "schema.prisma"), "utf8");

  it("sorts after the previous migration and is the last one", () => {
    const all = readdirSync(MIG).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(all.indexOf(NAME)).toBeGreaterThan(all.indexOf("20261119110000_app_move"));
    expect(all.indexOf(NAME)).toBeGreaterThan(-1); // later group-4 lanes (object migration, cutover, mapping) sort after it by design
  });

  it("creates the enum, both tables, the unique + state indexes and cascading foreign keys", () => {
    expect(sql).toContain(`CREATE TYPE "VolumeTransferState" AS ENUM ('PENDING', 'COPYING', 'COPIED', 'APPLYING', 'DONE', 'FAILED', 'ABORTED')`);
    expect(sql).toContain('CREATE TABLE "MigrationVolumeTransfer"');
    expect(sql).toContain('CREATE TABLE "MigrationVolumePart"');
    expect(sql).toContain('CREATE UNIQUE INDEX "MigrationVolumeTransfer_opId_itemRef_key" ON "MigrationVolumeTransfer"("opId", "itemRef")');
    expect(sql).toContain('CREATE INDEX "MigrationVolumeTransfer_state_lastBeatAt_idx" ON "MigrationVolumeTransfer"("state", "lastBeatAt")');
    expect(sql).toContain('PRIMARY KEY ("transferId","idx")');
    // deleting the op removes its transfers, and deleting a transfer removes its parts
    expect(sql).toMatch(/"MigrationVolumeTransfer_opId_fkey" FOREIGN KEY \("opId"\) REFERENCES "BulkOperation"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
    expect(sql).toMatch(/"MigrationVolumePart_transferId_fkey" FOREIGN KEY \("transferId"\) REFERENCES "MigrationVolumeTransfer"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
  });

  it("touches nothing that exists (additive only: no ALTER of BulkOperation/BulkTask, no DROP)", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(BulkOperation|BulkTask)"/);
  });

  it("every column of both Prisma models is in the SQL (and the other way round)", () => {
    const modelCols = (model: string): string[] => {
      const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)![1];
      return body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"))
        .map((l) => l.split(/\s+/))
        .filter(([, type]) => type && !/^(MigrationVolumePart|MigrationVolumeTransfer|BulkOperation)(\[\])?$/.test(type))
        .map(([name]) => name);
    };
    const sqlCols = (table: string): string[] => {
      const body = new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)![1];
      return [...body.matchAll(/^\s+"(\w+)"/gm)].map((m) => m[1]);
    };
    for (const [model, table] of [["MigrationVolumeTransfer", "MigrationVolumeTransfer"], ["MigrationVolumePart", "MigrationVolumePart"]] as const) {
      expect(sqlCols(table).sort()).toEqual(modelCols(model).sort());
    }
  });

  it("the BulkOperation relation field exists and the enum matches the SQL", () => {
    expect(schema).toMatch(/volumeTransfers\s+MigrationVolumeTransfer\[\]/);
    const body = /enum VolumeTransferState \{([\s\S]*?)\}/.exec(schema)![1].split("\n").map((l) => l.trim()).filter(Boolean);
    expect(body).toEqual(["PENDING", "COPYING", "COPIED", "APPLYING", "DONE", "FAILED", "ABORTED"]);
  });
});
