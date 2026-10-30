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
    expect(s).toContain("exit 3"); // prelude runs first
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
