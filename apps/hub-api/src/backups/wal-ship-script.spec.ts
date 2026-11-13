import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  walNs,
  walObjectName,
  isShippableWalName,
  buildWalListScript,
  buildWalShipScript,
  parseWalList,
  parseWalShipped,
} from "./wal-ship-script";
import { LOCAL_DEST, type DestinationSpec } from "./destination";

const SEG = "000000010000000000000003";
const HISTORY = "00000002.history";
const LABEL = "000000010000000000000003.00000028.backup";

const s3Dest: DestinationSpec = {
  type: "S3",
  s3: { bucket: "bk", region: "us-east-1", endpoint: "s3.amazonaws.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" },
  encryption: { enabled: false, key: "" },
};
const s3Encrypted: DestinationSpec = { ...s3Dest, encryption: { enabled: true, key: "secretpass" } };

describe("wal-ship-script", () => {
  describe("walNs / walObjectName", () => {
    it("namespaces WAL under <id>/wal, a sibling of <id>/base", () => {
      expect(walNs("db1")).toBe("db1/wal");
    });
    it("uses the segment name as the stem, .gz always and .gpg only when encrypted (deterministic, no timestamp)", () => {
      expect(walObjectName(SEG, LOCAL_DEST)).toBe(`${SEG}.gz`);
      expect(walObjectName(SEG, s3Dest)).toBe(`${SEG}.gz`);
      expect(walObjectName(SEG, s3Encrypted)).toBe(`${SEG}.gz.gpg`);
    });
  });

  describe("isShippableWalName", () => {
    it("accepts the three real WAL file shapes", () => {
      expect(isShippableWalName(SEG)).toBe(true);
      expect(isShippableWalName(HISTORY)).toBe(true);
      expect(isShippableWalName(LABEL)).toBe(true);
    });
    it("rejects partials, dotfiles, traversal and shell metacharacters", () => {
      expect(isShippableWalName(`${SEG}.part`)).toBe(false);
      expect(isShippableWalName(".hidden")).toBe(false);
      expect(isShippableWalName("../etc/passwd")).toBe(false);
      expect(isShippableWalName("000000010000000000000003; rm -rf /")).toBe(false);
      expect(isShippableWalName("$(whoami)")).toBe(false);
      expect(isShippableWalName("0000000A000000000000000B".toLowerCase())).toBe(false); // WAL names are upper-hex
      expect(isShippableWalName("")).toBe(false);
    });
  });

  describe("buildWalListScript", () => {
    const s = buildWalListScript("db1");
    it("enumerates with a glob (never $(ls)), skips *.part, and rejects symlinks + shell metacharacters", () => {
      expect(s).toContain("dir='/etc/tugra/wal/db1'");
      expect(s).toContain("for f in *; do");
      expect(s).not.toContain("$(ls"); // unquoted command substitution would word-split / re-glob a planted name
      expect(s).toContain('[ -f "$f" ] && [ ! -L "$f" ]'); // reject symlinks (host-file exfil vector)
      expect(s).toContain('case "$f" in *.part) continue;; esac');
      expect(s).toContain("*[!0-9A-Za-z.]*"); // coarse char allow-list (no metacharacters / path separators)
      expect(s).toContain("TUGRA_WAL_LIST total=");
    });
    it("is a no-op (total=0) when the spool dir does not exist", () => {
      expect(s).toContain('[ -d "$dir" ] || { echo "TUGRA_WAL_LIST total=0"; exit 0; }');
    });
  });

  describe("buildWalShipScript — LOCAL", () => {
    const s = buildWalShipScript("db1", [SEG, HISTORY], LOCAL_DEST);
    it("ships each segment via the shared sink with an atomic LOCAL write (.part then mv)", () => {
      expect(s).toContain("cat '/etc/tugra/wal/db1/000000010000000000000003'");
      expect(s).toContain("> /etc/tugra/backups/db1/wal/000000010000000000000003.gz.part");
      expect(s).toContain("mv /etc/tugra/backups/db1/wal/000000010000000000000003.gz.part /etc/tugra/backups/db1/wal/000000010000000000000003.gz");
    });
    it("runs the upload as a STANDALONE subshell (errexit honored), never as an if-condition", () => {
      // The upload MUST NOT be the condition of an `if` — errexit/pipefail are ignored there, which would let a
      // failed upload exit 0 on the trailing stat and delete an un-shipped segment. Assert the standalone form.
      expect(s).toContain(") >/dev/null\nrc=$?");
      expect(s).toContain('if [ "$rc" -eq 0 ]; then');
      expect(s).not.toContain("if ("); // the broken if-condition-subshell form must never come back
    });
    it("re-checks the entry is not a symlink at ship time (TOCTOU), then deletes ONLY on success", () => {
      expect(s).toContain("[ -L '/etc/tugra/wal/db1/000000010000000000000003' ]"); // ship-time symlink re-check
      // rm appears after the OK marker; FAIL marker is followed by exit 1 (contiguous-prefix guarantee).
      expect(s).toMatch(/echo "TUGRA_WAL_OK 000000010000000000000003"\n {2}rm -f '\/etc\/tugra\/wal\/db1\/000000010000000000000003'/);
      expect(s).toMatch(/TUGRA_WAL_FAIL 000000010000000000000003"\n {2}exit 1/);
      expect(s).not.toContain("mc pipe"); // LOCAL
    });
    it("ships the .history file too (needed to replay across a timeline switch)", () => {
      expect(s).toContain('echo "TUGRA_WAL_OK 00000002.history"');
      expect(s).toContain("> /etc/tugra/backups/db1/wal/00000002.history.gz.part");
    });
  });

  describe("buildWalShipScript — S3 + encryption", () => {
    it("pipes through mc to <bucket>/<prefix>/<db>/wal/<seg>.gz and gpg-encrypts when the destination does", () => {
      const s = buildWalShipScript("db1", [SEG], s3Encrypted);
      expect(s).toContain("mc pipe tdest/bk/tugra/db1/wal/000000010000000000000003.gz.gpg");
      // gpg rides inside the shq'd `bash -o pipefail -c '…'` so its single-quoted passphrase is escaped; assert
      // the unquoted flags and that the passphrase value is present (quote-escaped) rather than a literal form.
      expect(s).toContain("gpg --batch --yes --passphrase");
      expect(s).toContain("--symmetric --cipher-algo AES256");
      expect(s).toContain("secretpass");
      expect(s).toContain("MC_HOST_tdest=");
      expect(s).toContain("rm -f '/etc/tugra/wal/db1/000000010000000000000003'"); // delete after a clean upload
    });
  });

  describe("parseWalList", () => {
    it("reads enumerated entries and the backlog total", () => {
      const out = `WAL ${SEG} 16777216\nWAL ${HISTORY} 42\nTUGRA_WAL_LIST total=2`;
      const { entries, total } = parseWalList(out);
      expect(total).toBe(2);
      expect(entries).toEqual([
        { name: SEG, size: 16777216n },
        { name: HISTORY, size: 42n },
      ]);
    });
    it("reports total=null (UNKNOWN, never 'empty') when the summary marker is missing — truncated/dead list", () => {
      expect(parseWalList(`WAL ${SEG} 1`).total).toBeNull();
      expect(parseWalList("").total).toBeNull();
      expect(parseWalList("TUGRA_WAL_LIST total=0").total).toBe(0); // a real empty spool is explicit
    });
  });

  describe("parseWalShipped", () => {
    it("separates shipped markers from the (at most one) failure", () => {
      const out = `TUGRA_WAL_OK ${SEG}\nTUGRA_WAL_OK ${HISTORY}\nTUGRA_WAL_FAIL ${LABEL}`;
      const { shipped, failed } = parseWalShipped(out);
      expect(shipped).toEqual([SEG, HISTORY]);
      expect(failed).toEqual([LABEL]);
    });
  });

  // Behavioural tests: string assertions alone can't catch shell-semantics bugs (a failed upload was once
  // reported OK because `set -e` is ignored inside an `if`-condition subshell). These actually RUN the
  // generated LOCAL script under bash, relocating the two absolute roots into a temp sandbox.
  describe("buildWalShipScript — behavioural (real bash, LOCAL)", () => {
    function run(seg: string, prep: (spoolDir: string, spoolFile: string) => void) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walship-"));
      const script = buildWalShipScript("db1", [seg], LOCAL_DEST)
        .split("/etc/tugra/backups")
        .join(path.join(tmp, "backups"))
        .split("/etc/tugra/wal")
        .join(path.join(tmp, "wal"));
      const spoolDir = path.join(tmp, "wal", "db1");
      fs.mkdirSync(spoolDir, { recursive: true });
      const spoolFile = path.join(spoolDir, seg);
      prep(spoolDir, spoolFile);
      const scriptFile = path.join(tmp, "ship.sh");
      fs.writeFileSync(scriptFile, script);
      let out = "";
      let code = 0;
      try {
        out = execSync(`bash ${scriptFile}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        code = err.status ?? 1;
      }
      return {
        out,
        code,
        spoolExists: fs.existsSync(spoolFile),
        finalExists: fs.existsSync(path.join(tmp, "backups", "db1", "wal", `${seg}.gz`)),
      };
    }

    // The happy-path script ends in `stat -c %s` (GNU coreutils, as on the Linux agent/CI); gate it so a BSD
    // `stat` (local macOS) skips rather than falsely fails. The failure-path tests below never reach stat.
    const hasGnuStat = (() => {
      try {
        execSync(`stat -c %s ${__filename}`, { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    (hasGnuStat ? it : it.skip)("ships a present segment: OK printed, final object written atomically, spool deleted", () => {
      const r = run(SEG, (_d, f) => fs.writeFileSync(f, `hello-wal-${SEG}`));
      expect(r.out).toContain(`TUGRA_WAL_OK ${SEG}`);
      expect(r.finalExists).toBe(true);
      expect(r.spoolExists).toBe(false);
      expect(r.code).toBe(0);
    });

    // A failed upload must keep the spool copy and write NO final object. Injected by an unreadable spool file so
    // `cat` fails while gzip would still produce an (empty) object — the exact early-fail/late-succeed shape that
    // the `set -e`-ignored-in-if-condition bug turned into a false success. Skipped only as root (perms bypassed).
    const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
    (asRoot ? it.skip : it)("a FAILED upload keeps the spool and writes no final object (errexit not swallowed)", () => {
      const r = run(SEG, (_d, f) => {
        fs.writeFileSync(f, "secret");
        fs.chmodSync(f, 0o000); // unreadable → `cat` fails; without the fix, gzip+mv+stat still exit 0
      });
      expect(r.out).toContain(`TUGRA_WAL_FAIL ${SEG}`);
      expect(r.out).not.toContain("TUGRA_WAL_OK");
      expect(r.finalExists).toBe(false);
      expect(r.spoolExists).toBe(true);
      expect(r.code).not.toBe(0);
    });

    it("refuses a symlinked spool entry at ship time (no cat/upload through a symlink)", () => {
      const r = run(SEG, (dir, f) => {
        const secret = path.join(dir, "..", "secret-host-file");
        fs.writeFileSync(secret, "host secret");
        fs.symlinkSync(secret, f); // tenant plants a symlink named like a WAL segment
      });
      expect(r.out).toContain(`TUGRA_WAL_FAIL ${SEG}`);
      expect(r.finalExists).toBe(false);
    });
  });
});
