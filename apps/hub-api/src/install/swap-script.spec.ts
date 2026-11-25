import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives the REAL scripts/lib/swap.sh (the installer's small-host swap safety net) in a sandbox: a fake /proc and /etc
 * under TUGRA_FS_ROOT and stub system commands first on PATH (fallocate, mkswap, swapon, ... only write into the sandbox
 * and log their argv). Nothing here touches the host's swap.
 */
const LIB = join(__dirname, "..", "..", "..", "..", "scripts", "lib", "swap.sh");
const INSTALL = join(__dirname, "..", "..", "..", "..", "scripts", "install.sh");
const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Opts {
  ramKb?: number;
  swaps?: string[]; // extra /proc/swaps lines (an active swap area)
  uid?: string;
  freeMb?: number;
  fallocateFails?: boolean;
  swaponFails?: boolean;
  preexistingFile?: boolean;
  fstab?: string;
  env?: Record<string, string>;
  noSwap?: boolean;
  call?: string; // function to run (default swap_ensure)
}

function run(o: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "tugra-swap-"));
  dirs.push(root);
  const fsRoot = join(root, "fs");
  const bin = join(root, "bin");
  for (const d of ["proc", "etc", "bin"]) mkdirSync(d === "bin" ? bin : join(fsRoot, d), { recursive: true });
  writeFileSync(join(fsRoot, "proc", "meminfo"), `MemTotal:       ${o.ramKb ?? 3_900_000} kB\nMemFree: 1 kB\n`);
  writeFileSync(join(fsRoot, "proc", "swaps"), ["Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority", ...(o.swaps ?? [])].join("\n") + "\n");
  writeFileSync(join(fsRoot, "etc", "fstab"), o.fstab ?? "UUID=abc / ext4 defaults 0 1\n");
  if (o.preexistingFile) writeFileSync(join(fsRoot, "swapfile"), "x");
  const log = join(root, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("id", `echo ${o.uid ?? "0"}`);
  stub("df", `printf 'Filesystem 1M-blocks Used Available Capacity Mounted\\nx 100000 1 ${o.freeMb ?? 50_000} 1%% /\\n'`);
  stub("fallocate", o.fallocateFails ? "exit 1" : `for a in "$@"; do last="$a"; done; : > "$last"`);
  stub("dd", `for a in "$@"; do case "$a" in of=*) f="\${a#of=}";; esac; done; : > "$f"`);
  stub("mkswap", "exit 0");
  stub("swapoff", "exit 0");
  stub("swapon", o.swaponFails ? "exit 1" : `printf '%s\\tfile\\t2097148\\t0\\t-2\\n' "$1" >> "${join(fsRoot, "proc", "swaps")}"`);
  stub("sysctl", "exit 0");
  const script = `
    ok() { echo "OK: $*"; }; note() { echo "NOTE: $*"; }; warn() { echo "WARN: $*"; }; log() { echo "LOG: $*"; }
    . "${LIB}"
    ${o.noSwap ? "NO_SWAP=1" : ""}
    ${o.call ?? "swap_ensure"}
  `;
  const r = spawnSync(BASH, ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, TUGRA_FS_ROOT: fsRoot, ...o.env },
  });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    out: r.stdout + r.stderr,
    status: r.status,
    calls: read(log),
    fstab: read(join(fsRoot, "etc", "fstab")),
    sysctl: read(join(fsRoot, "etc", "sysctl.d", "99-tugra-swap.conf")),
    swaps: read(join(fsRoot, "proc", "swaps")),
    fileExists: existsSync(join(fsRoot, "swapfile")),
    fsRoot,
  };
}

describe("scripts/lib/swap.sh", () => {
  it("is valid bash and ships next to install.sh (the host-file signer globs lib/*.sh)", () => {
    expect(() => execFileSync("bash", ["-n", LIB], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync("bash", ["-n", INSTALL], { stdio: "pipe" })).not.toThrow();
  });

  it("a <= 4GB host without swap gets a 2GB swapfile: fallocate, 0600, mkswap, swapon, fstab, swappiness=10", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/fallocate -l 2048M .*\/swapfile/);
    expect(r.calls).toMatch(/mkswap .*\/swapfile/);
    expect(r.calls).toMatch(/swapon .*\/swapfile/);
    expect(r.fstab).toContain("/swapfile none swap sw 0 0");
    expect(r.fstab).toContain("UUID=abc / ext4 defaults 0 1"); // existing entries intact
    expect(r.sysctl).toContain("vm.swappiness=10");
    expect(r.out).toMatch(/OK: Swap: 2048MB swapfile/);
    expect(r.fileExists).toBe(true);
    expect(statSync(join(r.fsRoot, "swapfile")).mode & 0o777).toBe(0o600); // never world-readable
  });

  it("is idempotent: a second run (swap now active) changes nothing, and fstab is not duplicated", () => {
    const first = run();
    const second = run({ swaps: [`${first.fsRoot}/swapfile\tfile\t2097148\t0\t-2`], fstab: first.fstab });
    expect(second.calls).not.toMatch(/fallocate|mkswap|swapon/);
    expect(second.fstab.match(/\/swapfile none swap/g)?.length).toBe(1);
    expect(second.out).toBe(""); // quiet when there is nothing to do
  });

  it("does not add a second fstab line when one exists but swap is off (a reboot-less repair just swapons)", () => {
    const r = run({ preexistingFile: true, fstab: "/swapfile none swap sw 0 0\n" });
    expect(r.calls).toMatch(/swapon/);
    expect(r.calls).not.toMatch(/fallocate|mkswap/); // the existing file is never recreated or resized
    expect(r.fstab.match(/\/swapfile none swap/g)?.length).toBe(1);
  });

  it("leaves a host that already has swap (partition, zram, ...) alone", () => {
    const r = run({ swaps: ["/dev/zram0\tpartition\t1048572\t0\t100"] });
    expect(r.calls).not.toMatch(/fallocate|swapon|mkswap/);
    expect(r.fstab).not.toContain("swapfile");
  });

  it("leaves a host with more than 4GB RAM alone", () => {
    const r = run({ ramKb: 8_000_000 });
    expect(r.calls).not.toMatch(/fallocate|swapon/);
  });

  it("treats a 4GB VM (MemTotal just under 4 GiB) as small, and 4.1 GiB as not", () => {
    expect(run({ ramKb: 4_194_300 }).calls).toMatch(/fallocate/);
    expect(run({ ramKb: 4_300_000 }).calls).not.toMatch(/fallocate/);
  });

  it("--no-swap (NO_SWAP=1) skips it and says so", () => {
    const r = run({ noSwap: true });
    expect(r.calls).not.toMatch(/fallocate|swapon/);
    expect(r.out).toMatch(/skipped \(--no-swap\)/);
  });

  it("not root: advises instead of failing", () => {
    const r = run({ uid: "1000" });
    expect(r.status).toBe(0);
    expect(r.calls).not.toMatch(/fallocate|swapon/);
    expect(r.out).toMatch(/re-run as root/);
  });

  it("too little free disk: skipped with the numbers, nothing created", () => {
    const r = run({ freeMb: 3000 });
    expect(r.calls).not.toMatch(/fallocate/);
    expect(r.out).toMatch(/not enough free disk .*3000MB free/);
    expect(r.fileExists).toBe(false);
  });

  it("falls back to dd when fallocate cannot make a usable file", () => {
    const r = run({ fallocateFails: true });
    expect(r.calls).toMatch(/dd if=\/dev\/zero of=.*\/swapfile bs=1M count=2048/);
    expect(r.out).toMatch(/OK: Swap: 2048MB swapfile/);
  });

  it("never fatal: when swapon cannot work (a container) the partial file is removed and the install goes on", () => {
    const r = run({ swaponFails: true });
    expect(r.status).toBe(0);
    expect(r.fileExists).toBe(false);
    expect(r.fstab).not.toContain("swapfile");
    expect(r.out).toMatch(/could not enable a swapfile here/);
  });

  describe("swap_doctor (read-only)", () => {
    it("reports active swap", () => {
      expect(run({ call: "swap_doctor", swaps: ["/swapfile\tfile\t2097148\t0\t-2"] }).out).toMatch(/OK: Swap: 2048MB active/);
    });
    it("flags a small swapless host with the fix, and changes nothing", () => {
      const r = run({ call: "swap_doctor" });
      expect(r.out).toMatch(/NOTE: Swap: none, with only ~4GB RAM/);
      expect(r.out).toContain("--no-swap");
      expect(r.calls).not.toMatch(/fallocate|swapon|mkswap/);
      expect(r.fstab).not.toContain("swapfile");
    });
    it("is fine on a big host without swap", () => {
      expect(run({ call: "swap_doctor", ramKb: 16_000_000 }).out).toMatch(/OK: Swap: none \(fine with ~15GB RAM\)/);
    });
  });
});
