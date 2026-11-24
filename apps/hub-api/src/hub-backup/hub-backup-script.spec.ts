import { createHmac } from "node:crypto";
import {
  parseHubDbTarget,
  hubDumpCommand,
  hubPgPrelude,
  hubBackupPassphrase,
  hubDest,
  hubBackupFilename,
  buildHubBackupScript,
} from "./hub-backup-script";
import { LOCAL_DEST, type DestinationSpec } from "../backups/destination";

const S3: DestinationSpec = {
  type: "S3",
  s3: { bucket: "bk", region: "us-east-1", endpoint: "https://s3.example.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};

describe("parseHubDbTarget", () => {
  it("takes the user + db from DATABASE_URL and ignores the password", () => {
    expect(parseHubDbTarget("postgresql://tugra:s3cr3t@postgres:5432/tugra?schema=public")).toEqual({ user: "tugra", db: "tugra" });
    expect(parseHubDbTarget("postgres://u%40x:p@host/mydb")).toEqual({ user: "u@x", db: "mydb" }); // url-decoded
  });
});

describe("hubDumpCommand", () => {
  const cmd = hubDumpCommand({ user: "tugra", db: "tugra", project: "tugra" });
  it("pg_dump via docker exec resolved by compose labels, exact flags, NO password on argv", () => {
    expect(cmd).toContain("pg_dump -Fc -Z0 --no-owner --no-acl -U 'tugra' 'tugra'");
    expect(cmd).toContain("label=com.docker.compose.project=tugra");
    expect(cmd).toContain("label=com.docker.compose.service=postgres");
    expect(cmd).not.toMatch(/PGPASSWORD|password/i);
  });
  it("rejects a project name with shell metacharacters (injection guard)", () => {
    expect(() => hubDumpCommand({ user: "u", db: "d", project: "a; rm -rf /" })).toThrow();
    expect(() => hubDumpCommand({ user: "u", db: "d", project: "a`b`" })).toThrow();
  });
});

describe("hubPgPrelude", () => {
  it("exits 3 with a readable message when no hub postgres container is found", () => {
    const p = hubPgPrelude("tugra");
    expect(p).toContain("exit 3");
    expect(p).toContain("hub postgres container not found");
  });
});

describe("hubBackupPassphrase / hubDest", () => {
  it("is HMAC-SHA256(secretsKey, 'tugra-hub-backup-v1') — matches the documented restore derivation", () => {
    const expected = createHmac("sha256", "KEY123").update("tugra-hub-backup-v1").digest("hex");
    expect(hubBackupPassphrase("KEY123")).toBe(expected);
  });
  it("forces encryption on regardless of the destination's own toggle", () => {
    const d = hubDest(LOCAL_DEST, "pp");
    expect(d.encryption).toEqual({ enabled: true, key: "pp" });
  });
});

describe("buildHubBackupScript", () => {
  const target = { user: "tugra", db: "tugra", project: "tugra" };
  const filename = hubBackupFilename("2026-10-30T00-00-00-000Z");

  it("names the object tugra-hub-<ts>.dump.gz.gpg", () => {
    expect(filename).toBe("tugra-hub-2026-10-30T00-00-00-000Z.dump.gz.gpg");
  });

  it("LOCAL: pipefail, existence prelude, pg_dump | gzip | gpg AES256 → /etc/tugra/backups/hub, size via stat", () => {
    const s = buildHubBackupScript(target, filename, hubDest(LOCAL_DEST, "pp"));
    expect(s).toContain("set -o pipefail");
    expect(s).toContain("TUGRA_GPG_MISSING"); // the hub backup is always encrypted -> gpg preflight is the first guard
    expect(s.indexOf("TUGRA_GPG_MISSING")).toBeLessThan(s.indexOf("exit 3"));
    expect(s).toContain("exit 3"); // prelude runs next
    expect(s).toContain("gzip | gpg --batch --yes --passphrase 'pp' --symmetric --cipher-algo AES256");
    expect(s).toContain(`/etc/tugra/backups/hub/${filename}`);
    expect(s).toContain(`stat -c %s /etc/tugra/backups/hub/${filename}`);
  });

  it("S3: mc install + bash -o pipefail pipeline into mc pipe, then mc stat --json", () => {
    const s = buildHubBackupScript(target, filename, hubDest(S3, "pp"));
    expect(s).toContain("bash -o pipefail -c");
    expect(s).toContain("| mc pipe tdest/bk/tugra/hub/" + filename);
    expect(s).toContain("mc stat --json tdest/bk/tugra/hub/" + filename);
    expect(s).toContain("--symmetric --cipher-algo AES256"); // always encrypted
  });
});

import { buildHubDrillScript, parseDrillOutput, DRILL_TABLES } from "./hub-backup-script";

describe("buildHubDrillScript", () => {
  const dest = hubDest(S3, "pass-phrase");
  const script = buildHubDrillScript({ project: "tugra" }, "tugra-hub-x.dump.gz.gpg", dest);
  it("restores into a throwaway container with no network, removed on every exit", () => {
    expect(script).toContain("--network none");
    expect(script).toContain("trap 'docker rm -f \"$NAME\"");
    expect(script).toContain("pg_restore --no-owner --no-acl -U postgres -d drill");
  });
  it("reads the stored object through the gpg decode chain (S3 and local)", () => {
    expect(script).toContain("mc cat");
    expect(script).toContain("--decrypt");
    expect(script).toContain("gunzip");
    const local = buildHubDrillScript({ project: "tugra" }, "f.dump.gz.gpg", hubDest(LOCAL_DEST, "p"));
    expect(local).toContain("cat /etc/tugra/backups/hub/f.dump.gz.gpg");
  });
  it("counts only the fixed table list", () => {
    for (const t of DRILL_TABLES) expect(script).toContain(`FROM "${t}"`);
  });
  it("rejects a project name with shell metacharacters", () => {
    expect(() => buildHubDrillScript({ project: "a; rm -rf /" }, "f", dest)).toThrow();
  });
});

describe("parseDrillOutput", () => {
  const good = "TUGRA_DRILL rc=0 tables=42\nTUGRA_DRILL_COUNT User 3\nTUGRA_DRILL_COUNT Team 2\nTUGRA_DRILL_COUNT Server 1\n";
  it("passes when tables exist and the account tables hold rows", () => {
    expect(parseDrillOutput(good, 0)).toMatchObject({ ok: true, tables: 42, checks: { User: 3, Team: 2, Server: 1 }, rc: 0 });
  });
  it("tolerates a pg_restore warning exit when the checks pass", () => {
    expect(parseDrillOutput(good.replace("rc=0", "rc=1"), 0).ok).toBe(true);
  });
  it("fails on a script failure, a cut output, no tables and empty accounts", () => {
    expect(parseDrillOutput(good, 3)).toMatchObject({ ok: false, reason: "script-failed" });
    expect(parseDrillOutput("nothing", 0)).toMatchObject({ ok: false, reason: "no-marker" });
    expect(parseDrillOutput("TUGRA_DRILL rc=1 tables=0\n", 0)).toMatchObject({ ok: false, reason: "no-tables" });
    expect(parseDrillOutput("TUGRA_DRILL rc=0 tables=5\nTUGRA_DRILL_COUNT User 0\nTUGRA_DRILL_COUNT Team 0\n", 0)).toMatchObject({ ok: false, reason: "empty-accounts" });
  });
  it("ignores count lines for tables that are not on the list", () => {
    const r = parseDrillOutput(good + "TUGRA_DRILL_COUNT Secrets 9\n", 0);
    expect(r.checks).not.toHaveProperty("Secrets");
  });
});
