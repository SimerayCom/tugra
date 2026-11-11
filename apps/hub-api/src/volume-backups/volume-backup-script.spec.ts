import {
  buildVolumeBackupScript,
  buildVolumeRestoreScript,
  buildVolumeImportScript,
  buildVolumeDeleteScript,
  buildVolumeExportUrlScript,
  parseShareUrl,
  volumeBackupFilename,
  BACKUP_HELPER_IMAGE,
} from "./volume-backup-script";
import type { DestinationSpec } from "../backups/destination";

const LOCAL: DestinationSpec = { type: "LOCAL", encryption: { enabled: false, key: "" } };
const S3: DestinationSpec = {
  type: "S3",
  s3: { bucket: "b", region: "r", endpoint: "s3.example.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};
const ENC: DestinationSpec = { type: "LOCAL", encryption: { enabled: true, key: "pass" } };

describe("volume-backup-script", () => {
  it("LOCAL: tars the docker volume → gzip → file, prints size", () => {
    const s = buildVolumeBackupScript("a1", "data", "tugra_appv_a1_data", "20260101.tar.gz", LOCAL);
    expect(s).toContain(`docker run --rm -v 'tugra_appv_a1_data':/data:ro ${BACKUP_HELPER_IMAGE} tar -C /data -cf - .`);
    expect(s).toContain("| gzip");
    expect(s).toContain("> /etc/tugra/volume-backups/a1/data/20260101.tar.gz");
    expect(s).toContain("stat -c %s /etc/tugra/volume-backups/a1/data/20260101.tar.gz");
    expect(s).not.toContain("gpg");
  });

  it("S3: pipes to mc under <prefix>/<appId>/<vol>/<file> and reports size", () => {
    const fn = volumeBackupFilename("20260101", S3);
    const s = buildVolumeBackupScript("a1", "data", "tugra_appv_a1_data", fn, S3);
    expect(s).toContain("MC_HOST_tdest=");
    expect(s).toContain("mc pipe tdest/b/tugra/a1/data/20260101.tar.gz");
    expect(s).toContain("mc stat --json tdest/b/tugra/a1/data/20260101.tar.gz");
  });

  it("encryption adds a gpg stage and a .gpg suffix", () => {
    const fn = volumeBackupFilename("20260101", ENC);
    expect(fn).toBe("20260101.tar.gz.gpg");
    const s = buildVolumeBackupScript("a1", "data", "v", fn, ENC);
    expect(s).toContain("gpg --batch --yes --passphrase 'pass' --symmetric --cipher-algo AES256");
  });

  it("restore validates the tar + snapshots for rollback BEFORE wiping, and marks success (corrupt archive never destroys data)", () => {
    const s = buildVolumeRestoreScript("a1", "data", "tugra_appv_a1_data", "20260101.tar.gz", LOCAL, "r1");
    expect(s).toContain("gunzip");
    expect(s).toContain("TMP=$(mktemp)");
    expect(s).toContain('> "$TMP"'); // decode staged to temp BEFORE the volume is touched
    expect(s).toContain("set -o pipefail");
    // validate the tar LAYER before any destructive step (a valid gzip wrapping a corrupt tar aborts here)
    expect(s).toContain('tar -tf - < "$TMP"');
    expect(s).toContain('[ -s "$TMP.list" ]'); // empty/all-zero archive guard (would otherwise wipe to empty)
    expect(s).toContain("unsafe archive entry"); // absolute / .. traversal reject
    expect(s).toContain("LC_ALL=C grep"); // locale-independent traversal match
    // snapshot the live volume (labelled for discovery/cleanup) so a failed/interrupted extract rolls back
    expect(s).toContain("docker volume create --label tugra.restore-rb='r1' 'tugra_restore_rb_r1'");
    expect(s).toContain("find . -mindepth 1 -delete");
    expect(s).toContain("tar -xf -");
    expect(s).toContain('< "$TMP"'); // extract reads the staged temp, not a live pipe
    expect(s).toContain("echo TUGRA_RESTORE_OK"); // success marker the hub requires
    expect(s).toContain("TUGRA_RESTORE_RECOVERY_REQUIRED"); // rollback-also-failed signal
    // validation + snapshot MUST come before the destructive wipe — the whole point of the fix
    expect(s.indexOf('tar -tf - < "$TMP"')).toBeLessThan(s.indexOf("find . -mindepth 1 -delete"));
    expect(s.indexOf("docker volume create")).toBeLessThan(s.indexOf("find . -mindepth 1 -delete"));
  });

  it("delete removes the local file or the S3 object", () => {
    expect(buildVolumeDeleteScript("a1", "data", "x.tar.gz", LOCAL)).toContain("rm -f /etc/tugra/volume-backups/a1/data/x.tar.gz");
    expect(buildVolumeDeleteScript("a1", "data", "x.tar.gz", S3)).toContain("mc rm tdest/b/tugra/a1/data/x.tar.gz");
  });

  describe("buildVolumeImportScript", () => {
    it("stages the fetch, validates + snapshots before wipe, keeps --no-same-owner (a bad fetch never touches the volume)", () => {
      const s = buildVolumeImportScript("tugra_appv_a1_data", "https://x.example/dump.tar.gz", "r2", {
        encrypted: false,
        key: "",
        gzip: true,
      });
      expect(s).toContain("TMP=$(mktemp)");
      expect(s).toContain("curl -fsSL 'https://x.example/dump.tar.gz'");
      expect(s).toContain("| gunzip");
      expect(s).toContain('> "$TMP"'); // decode staged to temp BEFORE the volume is touched
      expect(s).toContain("set -o pipefail"); // a failed url/key/gzip aborts (set -e) before the wipe
      expect(s).toContain('tar -tf - < "$TMP"'); // validate the tar layer before any destructive step
      expect(s).toContain("docker volume create --label tugra.restore-rb='r2' 'tugra_restore_rb_r2'"); // labelled rollback snapshot
      expect(s).toContain("find . -mindepth 1 -delete");
      expect(s).toContain("tar --no-same-owner -xf -"); // untrusted tar → no arbitrary ownership
      expect(s).toContain('< "$TMP"'); // extract reads the staged temp, not a live pipe
      expect(s).toContain("echo TUGRA_RESTORE_OK");
      // validation MUST come before the destructive wipe
      expect(s.indexOf('tar -tf - < "$TMP"')).toBeLessThan(s.indexOf("find . -mindepth 1 -delete"));
      expect(s).not.toContain("gpg");
    });

    it("shell-quotes a URL with metacharacters (no command injection)", () => {
      const s = buildVolumeImportScript("v", "https://x/$(touch pwned).tar", "r", { encrypted: false, key: "", gzip: true });
      expect(s).toContain("'https://x/$(touch pwned).tar'"); // inside single quotes → inert
    });

    it("omits gunzip when gzip:false", () => {
      const s = buildVolumeImportScript("v", "https://x/dump.tar", "r", { encrypted: false, key: "", gzip: false });
      expect(s).not.toContain("gunzip");
    });

    it("adds a gpg -d stage (passphrase quoted) when encrypted", () => {
      const s = buildVolumeImportScript("v", "https://x/d.tar.gz.gpg", "r", { encrypted: true, key: "pass", gzip: true });
      expect(s).toContain("gpg --batch --yes --passphrase 'pass' --decrypt");
      // decode order: fetch → decrypt → gunzip
      expect(s.indexOf("curl")).toBeLessThan(s.indexOf("gpg"));
      expect(s.indexOf("gpg")).toBeLessThan(s.indexOf("gunzip"));
    });

    it("leaves the decode UNBOUNDED for the trusted user path (no maxDecodedBytes)", () => {
      const s = buildVolumeImportScript("v", "https://x/d.tar.gz", "r", { encrypted: false, key: "", gzip: true });
      expect(s).not.toContain("head -c"); // the user-driven import-from-url path is unchanged
      expect(s).not.toMatch(/exceeds the \d+-byte cap/);
    });

    it("bounds the DECODED size with head -c + a size check when a cap is given (gzip-bomb guard)", () => {
      const s = buildVolumeImportScript("v", "https://x/d.tar.gz", "r", { encrypted: false, key: "", gzip: true, maxDecodedBytes: 1000 });
      expect(s).toContain("| head -c 1001"); // cap + 1 so the exact-boundary case is detectable
      expect(s).toContain('if [ "$(wc -c < "$TMP")" -gt 1000 ]'); // explicit boundary check
      expect(s).toMatch(/exceeds the 1000-byte cap/);
      // the bound is applied to the decoded stream BEFORE the wipe
      expect(s.indexOf("head -c")).toBeLessThan(s.indexOf("find . -mindepth 1 -delete"));
      expect(s.indexOf("wc -c")).toBeLessThan(s.indexOf("find . -mindepth 1 -delete"));
    });
  });
});

describe("volume export url (migration)", () => {
  it("builds an mc share download presigned-URL command against the backup's object", () => {
    const s = buildVolumeExportUrlScript("a1", "data", "20260101.tar.gz", S3, "24h");
    expect(s).toContain("command -v mc"); // MC_INSTALL bootstrap
    expect(s).toContain("mc share download --expire '24h' --json 'tdest/b/tugra/a1/data/20260101.tar.gz'");
    expect(s).toContain("MC_HOST_tdest="); // creds via env, not written to disk
  });

  it("refuses a LOCAL destination (no presignable object)", () => {
    expect(() => buildVolumeExportUrlScript("a1", "data", "f.tar.gz", LOCAL, "24h")).toThrow(/S3/);
  });

  it("parseShareUrl extracts the presigned url, tolerates noise + absence", () => {
    expect(parseShareUrl('installing mc\n{"status":"success","url":"tdest/b/k","share":"https://s3.example.com/b/k?X-Amz=sig","expiry":86400}')).toBe(
      "https://s3.example.com/b/k?X-Amz=sig",
    );
    expect(parseShareUrl("no json here")).toBeNull();
    expect(parseShareUrl('{"status":"error","error":{"message":"nope"}}')).toBeNull(); // no share field
  });
});

describe("backup helper image", () => {
  it("pins the tar/restore helper to a tag + sha256 digest (was a bare alpine :latest)", () => {
    expect(BACKUP_HELPER_IMAGE).toMatch(/^alpine:[\w.]+@sha256:[a-f0-9]{64}$/);
  });
});
