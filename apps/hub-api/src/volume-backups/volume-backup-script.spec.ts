import {
  buildVolumeBackupScript,
  buildVolumeRestoreScript,
  buildVolumeImportScript,
  buildVolumeDeleteScript,
  buildVolumeExportUrlScript,
  parseShareUrl,
  volumeBackupFilename,
  BACKUP_HELPER_IMAGE,
  safeWipeExtract,
} from "./volume-backup-script";
import type { DestinationSpec } from "../backups/destination";

const LOCAL: DestinationSpec = { type: "LOCAL", encryption: { enabled: false, key: "" } };
const S3: DestinationSpec = {
  type: "S3",
  s3: { bucket: "b", region: "r", endpoint: "s3.example.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};
const ENC: DestinationSpec = { type: "LOCAL", encryption: { enabled: true, key: "pass" } };

describe("volume-backup-script — encryption, suffix-driven restore, atomic local write", () => {
  it("encrypted backup: gpg preflight is the first guard (after set -e/pipefail) and the key is shq-safe", () => {
    const s = buildVolumeBackupScript("a1", "data", "v", "t.tar.gz.gpg", { type: "LOCAL", encryption: { enabled: true, key: "k'ey" } });
    expect(s.split("\n").slice(0, 3)).toEqual(["set -e", "set -o pipefail", expect.stringContaining("TUGRA_GPG_MISSING")]);
    expect(s).toContain(`--passphrase 'k'\\''ey'`);
  });

  it("unencrypted LOCAL / S3 backup scripts stay byte-identical (no preflight, direct write)", () => {
    expect(buildVolumeBackupScript("a1", "data", "v", "t.tar.gz", LOCAL)).toBe(
      [
        "set -e",
        "set -o pipefail",
        "mkdir -p /etc/tugra/volume-backups/a1/data",
        `docker run --rm -v 'v':/data:ro ${BACKUP_HELPER_IMAGE} tar -C /data -cf - . | gzip > /etc/tugra/volume-backups/a1/data/t.tar.gz`,
        "stat -c %s /etc/tugra/volume-backups/a1/data/t.tar.gz",
      ].join("\n"),
    );
    expect(buildVolumeBackupScript("a1", "data", "v", "t.tar.gz", S3)).not.toContain("TUGRA_GPG_MISSING");
  });

  it("an encrypted LOCAL write is atomic: .part then mv, stat on the final path", () => {
    const s = buildVolumeBackupScript("a1", "data", "v", "t.tar.gz.gpg", ENC);
    const f = "/etc/tugra/volume-backups/a1/data/t.tar.gz.gpg";
    expect(s).toContain(`> ${f}.part`);
    expect(s).toContain(`mv ${f}.part ${f}`);
    expect(s.indexOf(`> ${f}.part`)).toBeLessThan(s.indexOf("mv "));
    expect(s).toContain(`stat -c %s ${f}`);
  });

  it("an encrypted LOCAL write reaps its own .part on failure and sweeps stale ones; the unencrypted script has neither", () => {
    const f = "/etc/tugra/volume-backups/a1/data/t.tar.gz.gpg";
    const s = buildVolumeBackupScript("a1", "data", "v", "t.tar.gz.gpg", ENC);
    expect(s).toContain(`trap 'rm -f ${f}.part' EXIT`);
    expect(s.indexOf("trap ")).toBeLessThan(s.indexOf(`> ${f}.part`));
    expect(s).toContain("find /etc/tugra/volume-backups/a1/data -maxdepth 1 -name '*.part' -mmin +1440 -delete");
    expect(buildVolumeBackupScript("a1", "data", "v", "t.tar.gz", LOCAL)).not.toMatch(/trap|\.part/);
  });

  it("restore decrypts by the .gpg SUFFIX, not the destination flag", () => {
    const gpgFile = buildVolumeRestoreScript("a1", "data", "v", "t.tar.gz.gpg", ENC, "r1");
    expect(gpgFile).toContain("--decrypt");
    expect(gpgFile).toContain("TUGRA_GPG_MISSING");
    // a pre-fix CLEARTEXT row on an encrypted destination still restores, with no gpg stage
    const plain = buildVolumeRestoreScript("a1", "data", "v", "t.tar.gz", ENC, "r1");
    expect(plain).not.toContain("--decrypt");
    expect(plain).not.toContain("TUGRA_GPG_MISSING");
    expect(plain).toContain("gunzip");
  });

  it("a .gpg object whose destination has no key fails loud before any script is built", () => {
    expect(() => buildVolumeRestoreScript("a1", "data", "v", "t.tar.gz.gpg", LOCAL, "r1")).toThrow(
      "backup is encrypted but the destination has no key (destination deleted?)",
    );
  });
});

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

// ── FULL-output goldens (captured from the pre-refactor builders). safeWipeExtract grew an optional input mode for
// the app-move transfer; the default (staged $TMP) path must stay byte-identical, so these pin every line. ──
describe("restore/import scripts — byte-for-byte goldens (default input mode)", () => {
  const IMG = BACKUP_HELPER_IMAGE;
  const wipeTail = (rid: string, vol: string, tarFlags: string) => [
    `docker run --rm -i ${IMG} tar -tf - < "$TMP" > "$TMP.list" 2>/dev/null || { echo "invalid archive" >&2; exit 72; }`,
    `[ -s "$TMP.list" ] || { echo "empty archive" >&2; exit 72; }`,
    `if LC_ALL=C grep -Eq '^/|(^|/)[.][.](/|$)' "$TMP.list"; then echo "unsafe archive entry" >&2; exit 72; fi`,
    `docker volume create --label tugra.restore-rb='${rid}' 'tugra_restore_rb_${rid}' >/dev/null || { echo "snapshot volume create failed" >&2; exit 72; }`,
    `docker run --rm -v '${vol}':/src:ro -v 'tugra_restore_rb_${rid}':/dst ${IMG} sh -c 'cp -a /src/. /dst/' || { docker volume rm 'tugra_restore_rb_${rid}' >/dev/null 2>&1 || true; echo "snapshot failed" >&2; exit 72; }`,
    `if docker run --rm -i -v '${vol}':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete; tar ${tarFlags}-xf -' < "$TMP"; then`,
    `  docker volume rm 'tugra_restore_rb_${rid}' >/dev/null 2>&1 || true`,
    `  echo TUGRA_RESTORE_OK`,
    `elif docker run --rm -v 'tugra_restore_rb_${rid}':/src:ro -v '${vol}':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete; cp -a /src/. /data/'; then`,
    `  docker volume rm 'tugra_restore_rb_${rid}' >/dev/null 2>&1 || true`,
    `  echo TUGRA_RESTORE_FAILED_ROLLED_BACK >&2; exit 71`,
    `else`,
    `  echo "TUGRA_RESTORE_RECOVERY_REQUIRED rollback=tugra_restore_rb_${rid}" >&2; exit 70`,
    `fi`,
  ];

  it("buildVolumeRestoreScript (LOCAL): the complete script", () => {
    expect(buildVolumeRestoreScript("app1", "data", "tugra_appv_app1_data", "20260101.tar.gz", LOCAL, "rid1")).toBe(
      [
        "set -e",
        "set -o pipefail",
        "TMP=$(mktemp)",
        `trap 'rm -f "$TMP" "$TMP.list"' EXIT`,
        `cat /etc/tugra/volume-backups/app1/data/20260101.tar.gz | gunzip > "$TMP"`,
        ...wipeTail("rid1", "tugra_appv_app1_data", ""),
      ].join("\n"),
    );
  });

  it("buildVolumeImportScript (plain gzip): the complete script (--no-same-owner)", () => {
    expect(buildVolumeImportScript("tugra_appv_app1_data", "https://x.example/d.tgz", "rid2", { encrypted: false, key: "", gzip: true })).toBe(
      [
        "set -e",
        "set -o pipefail",
        "TMP=$(mktemp)",
        `trap 'rm -f "$TMP" "$TMP.list"' EXIT`,
        `curl -fsSL 'https://x.example/d.tgz' | gunzip > "$TMP"`,
        ...wipeTail("rid2", "tugra_appv_app1_data", "--no-same-owner "),
      ].join("\n"),
    );
  });

  it("buildVolumeImportScript (encrypted, decoded-size cap): the complete script", () => {
    expect(buildVolumeImportScript("tugra_appv_app1_data", "https://x.example/d.tgz", "rid3", { encrypted: true, key: "k3y", gzip: false, maxDecodedBytes: 1000 })).toBe(
      [
        "set -e",
        "set -o pipefail",
        "TMP=$(mktemp)",
        `trap 'rm -f "$TMP" "$TMP.list"' EXIT`,
        `curl -fsSL 'https://x.example/d.tgz' | gpg --batch --yes --passphrase 'k3y' --decrypt | head -c 1001 > "$TMP"`,
        `if [ "$(wc -c < "$TMP")" -gt 1000 ]; then echo "decoded volume exceeds the 1000-byte cap" >&2; exit 1; fi`,
        ...wipeTail("rid3", "tugra_appv_app1_data", "--no-same-owner "),
      ].join("\n"),
    );
  });
});

describe("safeWipeExtract — stream input (app move)", () => {
  const IMG = BACKUP_HELPER_IMAGE;
  const vol = "tugra_appv_app1_data";

  it("the default input is byte-identical to an explicit {kind:'tmp'}", () => {
    expect(safeWipeExtract(vol, "r1", "")).toEqual(safeWipeExtract(vol, "r1", "", { kind: "tmp" }));
    expect(safeWipeExtract(vol, "r1", "--no-same-owner ")).toEqual(safeWipeExtract(vol, "r1", "--no-same-owner ", { kind: "tmp" }));
  });

  it("stream mode swaps ONLY the two input lines (double-stream: validate, then extract); everything else is identical", () => {
    const tmp = safeWipeExtract(vol, "r1", "");
    const stream = safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "vx_stream" });
    expect(stream).toHaveLength(tmp.length);
    const diff = stream.map((l, i) => [l, tmp[i]]).filter(([a, b]) => a !== b);
    expect(diff).toHaveLength(2);
    expect(stream[0]).toBe(`vx_stream | docker run --rm -i ${IMG} tar -tf - > "$TMP.list" 2>/dev/null || { echo "invalid archive" >&2; exit 72; }`);
    expect(stream.find((l) => l.startsWith("if vx_stream"))).toBe(`if vx_stream | docker run --rm -i -v '${vol}':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete; tar -xf -'; then`);
    expect(stream.join("\n")).not.toContain('< "$TMP"'); // the decoded tar is never read from a staged file
    expect(stream.join("\n")).not.toContain('"$TMP"'); // ...nor written (only $TMP.list is)
  });

  it("stream mode keeps the exit contract (72 before the wipe, 71 rolled back, 70 recovery) and the rollback snapshot", () => {
    const s = safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "vx_stream" }).join("\n");
    for (const c of ["exit 72", "exit 71", "exit 70", "TUGRA_RESTORE_OK", "tugra_restore_rb_r1", "docker volume create --label tugra.restore-rb='r1'"]) expect(s).toContain(c);
  });

  it("keeps the caller's tar flags (a move preserves ownership: tarFlags empty)", () => {
    expect(safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "f" }).join("\n")).toContain("tar -xf -");
    expect(safeWipeExtract(vol, "r1", "--no-same-owner ", { kind: "stream", fn: "f" }).join("\n")).toContain("tar --no-same-owner -xf -");
  });

  it("the stream function name is a constant identifier: anything else throws", () => {
    for (const bad of ["a b", "a;b", "$(x)", "", "1abc", "a|b", "f\nx"]) expect(() => safeWipeExtract(vol, "r1", "", { kind: "stream", fn: bad })).toThrow(/stream function/);
  });
});

describe("safeWipeExtract — drain (opt-in, stream input only)", () => {
  const IMG = BACKUP_HELPER_IMAGE;
  const vol = "tugra_appv_app1_data";

  it("without drain (absent or false) the output is byte-identical to the existing stream mode", () => {
    const base = safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "vx_stream" });
    expect(safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "vx_stream", drain: false })).toEqual(base);
    expect(safeWipeExtract(vol, "r1", "--no-same-owner ", { kind: "stream", fn: "f", drain: false })).toEqual(safeWipeExtract(vol, "r1", "--no-same-owner ", { kind: "stream", fn: "f" }));
  });

  it("drain swaps ONLY the two consumer lines: tar's exit code is kept and the rest of stdin is drained", () => {
    const base = safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "vx_stream" });
    const d = safeWipeExtract(vol, "r1", "", { kind: "stream", fn: "vx_stream", drain: true });
    expect(d).toHaveLength(base.length);
    expect(d.map((l, i) => [l, base[i]]).filter(([a, b]) => a !== b)).toHaveLength(2);
    expect(d[0]).toBe(`vx_stream | docker run --rm -i ${IMG} sh -c 'tar -tf -; r=$?; cat >/dev/null; exit $r' > "$TMP.list" 2>/dev/null || { echo "invalid archive" >&2; exit 72; }`);
    expect(d.find((l) => l.startsWith("if vx_stream"))).toBe(
      `if vx_stream | docker run --rm -i -v '${vol}':/data ${IMG} sh -c 'cd /data && find . -mindepth 1 -delete; tar -xf -; r=$?; cat >/dev/null; exit $r'; then`,
    );
  });

  it("drain keeps the caller's tar flags and the exit contract", () => {
    const s = safeWipeExtract(vol, "r1", "--no-same-owner ", { kind: "stream", fn: "f", drain: true }).join("\n");
    expect(s).toContain("tar --no-same-owner -xf -; r=$?; cat >/dev/null; exit $r");
    for (const c of ["exit 72", "exit 71", "exit 70", "TUGRA_RESTORE_OK"]) expect(s).toContain(c);
  });

  it("drain has no effect in tmp mode", () => {
    // @ts-expect-error drain only exists on the stream variant
    expect(safeWipeExtract(vol, "r1", "", { kind: "tmp", drain: true })).toEqual(safeWipeExtract(vol, "r1", ""));
  });
});
