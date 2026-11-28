import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppReadyScript,
  parseAppReady,
  FALLBACK_CERT_DIR,
  buildAdoptImageScript,
  buildContainerDetailScript,
  buildFallbackInstallScript,
  buildFallbackRemoveScript,
  buildInPlaceProbeScript,
  buildNewCertCheckScript,
  buildRestartPolicyScript,
  buildVolumeAliasScript,
  isNewLetsEncryptCert,
  parseAdopt,
  parseAlias,
  parseContainerDetail,
  parseFallbackInstall,
  parseInPlaceProbe,
  parseNewCertCheck,
  parsePolicy,
  buildDbFingerprintScript,
  checkLevelOf,
  parseDbFingerprint,
  sameDatabase,
  type DbFingerprint,
} from "./inplace-scripts";
import { PROXY_DYNAMIC_DIR } from "../deploy/panel-router";

const ID = "a".repeat(64);
const ID2 = "b".repeat(64);
const ctr = { id: ID, name: "abc-20261125T101010", image: "abc:1234" };
const HAS_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

const ALL = (): string[] => [
  buildContainerDetailScript([ctr]),
  buildAdoptImageScript({ image: "abc:1234", tag: "tugra_app1:dep1" }),
  buildVolumeAliasScript([{ from: "abc-data", to: "tugra_appv_app1_data" }]),
  buildRestartPolicyScript([{ ...ctr, policy: "unless-stopped" }]),
  buildInPlaceProbeScript({ via: "tugra-dark", hosts: ["a.example.com"], path: "/", twice: true }),
  buildInPlaceProbeScript({ via: "coolify", hosts: ["a.example.com"], path: "/" }),
  buildFallbackInstallScript({ hosts: ["a.example.com"] }),
  buildFallbackRemoveScript(["a.example.com"]),
  buildNewCertCheckScript("a.example.com"),
];

describe("source safety of every script", () => {
  it("never removes, kills, prunes or deletes anything of Coolify's, and never asks for an environment", () => {
    for (const s of ALL()) {
      expect(s).not.toMatch(/docker\s+(rm|kill|prune|rmi|system|container\s+rm)\b/);
      expect(s).not.toMatch(/docker\s+volume\s+(rm|prune)/);
      expect(s).not.toMatch(/docker\s+image\s+(rm|prune)/);
      expect(s).not.toMatch(/\.Config\.Env|\.Env\b|docker\s+exec|--env|printenv/);
      expect(s).not.toMatch(/rm\s+-[a-z]*r/); // no recursive delete
    }
  });
  it("the removal script only names the files this lane wrote", () => {
    const s = buildFallbackRemoveScript(["a.example.com"]);
    expect(s).toContain(`${PROXY_DYNAMIC_DIR}/tls-fb-a-example-com.yml`);
    expect(s).toContain(`${FALLBACK_CERT_DIR}/fb-a-example-com.crt`);
    expect(s).not.toMatch(/\*/);
  });
});

describe("validation: nothing hostile reaches a shell", () => {
  it("refuses a bad recorded container, image, tag, volume, host, path and acme path", () => {
    expect(() => buildContainerDetailScript([{ ...ctr, id: "short" }])).toThrow();
    expect(() => buildContainerDetailScript([{ ...ctr, name: "x; rm -rf /" }])).toThrow();
    expect(() => buildAdoptImageScript({ image: "a b", tag: "tugra_x:y" })).toThrow();
    expect(() => buildAdoptImageScript({ image: "abc:1", tag: "Evil:$(id)" })).toThrow();
    expect(() => buildVolumeAliasScript([{ from: "a;b", to: "ok" }])).toThrow();
    expect(() => buildVolumeAliasScript([{ from: "ok", to: "$(id)" }])).toThrow();
    expect(() => buildInPlaceProbeScript({ via: "local", hosts: ["a.example.com; id"], path: "/" })).toThrow();
    expect(() => buildInPlaceProbeScript({ via: "local", hosts: [], path: "/" })).toThrow();
    expect(() => buildInPlaceProbeScript({ via: "local", hosts: ["a.example.com"], path: "no-slash" })).toThrow();
    expect(() => buildFallbackInstallScript({ hosts: ["a.example.com"], acmePath: "/data/../etc/shadow" })).toThrow();
    expect(() => buildFallbackInstallScript({ hosts: ["a.example.com"], acmePath: "relative" })).toThrow();
    expect(() => buildFallbackRemoveScript(["bad host"])).toThrow();
    expect(() => buildNewCertCheckScript("x$(id)")).toThrow();
    expect(() => buildRestartPolicyScript([{ ...ctr, policy: "bogus" as never }])).toThrow();
  });
});

describe("parsers fail closed", () => {
  it("the detail parser needs its END marker and ignores ids it did not ask for", () => {
    expect(parseContainerDetail(`TUGRA_IP_RESTART|${ID}|always\n`, [ID])).toBeNull();
    const out = [
      `TUGRA_IP_RESTART|${ID}|unless-stopped`,
      `TUGRA_IP_IMAGE|${ID}|sha256:${"c".repeat(64)}`,
      `TUGRA_IP_MOUNT|${ID}|volume|abc-data|/var/lib/docker/volumes/abc-data/_data|/data|true`,
      `TUGRA_IP_MOUNT|${ID}|bind||/srv/media|/media|false`,
      `TUGRA_IP_MOUNT|${ID2}|volume|other|/x|/y|true`,
      `TUGRA_IP_RESTART|${ID2}|always`,
      "TUGRA_IP_DETAIL_END",
    ].join("\n");
    const m = parseContainerDetail(out, [ID])!;
    expect(m.size).toBe(1);
    expect(m.get(ID)).toEqual({
      id: ID,
      restart: "unless-stopped",
      imageId: `sha256:${"c".repeat(64)}`,
      mounts: [
        { type: "volume", source: "abc-data", destination: "/data", rw: true },
        { type: "bind", source: "/srv/media", destination: "/media", rw: false },
      ],
    });
  });
  it("an empty restart policy is `no`; a container with no image line is absent", () => {
    const out = [`TUGRA_IP_RESTART|${ID}|`, `TUGRA_IP_IMAGE|${ID}|sha256:${"c".repeat(64)}`, `TUGRA_IP_RESTART|${ID2}|always`, "TUGRA_IP_DETAIL_END"].join("\n");
    const m = parseContainerDetail(out, [ID, ID2])!;
    expect(m.get(ID)!.restart).toBe("no");
    expect(m.has(ID2)).toBe(false);
  });
  it("a truncated output is null everywhere", () => {
    const cut = "…(truncated)";
    expect(parseContainerDetail(`TUGRA_IP_DETAIL_END${cut}`, [ID])).toBeNull();
    expect(parseAdopt(`TUGRA_IP_ADOPT|ok${cut}`)).toBeNull();
    expect(parseAlias(`${cut}`, ["x"])).toBeNull();
    expect(parseInPlaceProbe(`TUGRA_IP_PROBE_END${cut}`, ["a.example.com"])).toBeNull();
    expect(parseFallbackInstall(cut, ["a.example.com"])).toBeNull();
    expect(parseNewCertCheck(cut, "a.example.com")).toBeNull();
  });
  it("adopt, alias, policy", () => {
    expect(parseAdopt("TUGRA_IP_ADOPT|ok")).toBe("ok");
    expect(parseAdopt("TUGRA_IP_ADOPT|missing")).toBe("missing");
    expect(parseAdopt("nothing")).toBeNull();
    expect(parseAlias("TUGRA_IP_ALIAS|v|created", ["v"])!.get("v")).toBe("created");
    expect(parseAlias("TUGRA_IP_ALIAS|v|created", ["v", "w"])).toBeNull(); // a missing answer is not a pass
    expect(parseAlias("TUGRA_IP_ALIAS|other|created", ["v"])).toBeNull();
    expect(parsePolicy(`TUGRA_IP_POLICY|${ID}|ok\nTUGRA_IP_POLICY|${ID2}|mismatch\nTUGRA_IP_POLICY|${"c".repeat(64)}|ok`, [ID, ID2]).size).toBe(2);
  });
  it("the probe parser: markers, status 000, a bad hash, a host nobody asked for", () => {
    const h = "d".repeat(64);
    const r = parseInPlaceProbe(["TUGRA_IP_PROBE|a.example.com|200|" + h + "|" + h, "TUGRA_IP_PROBE|b.example.com|000|none|none", "TUGRA_IP_PROBE|evil.example.com|200|" + h + "|" + h, "TUGRA_IP_PROBE_END"].join("\n"), ["a.example.com", "b.example.com"]);
    expect(r).toEqual({ kind: "ok", hosts: { "a.example.com": { status: 200, hash: h, hash2: h, size: null, location: null }, "b.example.com": { status: null, hash: null, hash2: null, size: null, location: null } } });
    expect(parseInPlaceProbe("TUGRA_IP_PROBE|NOPROXY\nTUGRA_IP_PROBE_END", ["a.example.com"])).toEqual({ kind: "noproxy" });
    expect(parseInPlaceProbe("TUGRA_IP_PROBE|NOCURL\nTUGRA_IP_PROBE_END", ["a.example.com"])).toEqual({ kind: "nocurl" });
    expect(parseInPlaceProbe("TUGRA_IP_PROBE|a.example.com|200|" + h + "|" + h, ["a.example.com"])).toBeNull(); // no END
  });
  it("a body can never forge a marker: only the shell prints them and the parser ignores non-marker lines", () => {
    expect(parseInPlaceProbe("hello\nTUGRA_IP_PROBE|a.example.com|200|zz|zz\nTUGRA_IP_PROBE_END", ["a.example.com"])).toEqual({ kind: "ok", hosts: { "a.example.com": { status: 200, hash: null, hash2: null, size: null, location: null } } });
  });
  it("the served-certificate parser and the new-certificate rule", () => {
    const served = parseNewCertCheck("TUGRA_IP_CERT|a.example.com|served|0ABC|C=US, O=Let's Encrypt, CN=R11", "a.example.com")!;
    expect(served).toEqual({ state: "served", serial: "0ABC", issuer: "C=US, O=Let's Encrypt, CN=R11" });
    expect(isNewLetsEncryptCert(served, "0DEF")).toBe(true);
    expect(isNewLetsEncryptCert(served, "0abc")).toBe(false); // the fallback itself
    expect(isNewLetsEncryptCert({ ...served, issuer: "CN=TRAEFIK DEFAULT CERT" } as never, "0DEF")).toBe(false);
    expect(isNewLetsEncryptCert({ state: "none" }, null)).toBe(false);
    expect(parseNewCertCheck("TUGRA_IP_CERT|a.example.com|noopenssl|-|-", "a.example.com")).toEqual({ state: "noopenssl" });
    expect(parseNewCertCheck("TUGRA_IP_CERT|other.example.com|served|01|x", "a.example.com")).toBeNull();
  });
});

// ───────────────────────────── real execution on fixtures ─────────────────────────────

let dir: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplace-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeBin = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const run = (script: string, env: Record<string, string> = {}) => spawnSync("/bin/sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...env }, encoding: "utf8" });

describe("the exact image of a container (digests and version label), executed against a fake docker", () => {
  const DG = `sha256:${"d".repeat(64)}`;
  const fakeDocker = `
case "$1" in
  inspect)
    case "$3" in
      *RestartPolicy*) echo "always";;
      *.Name*) echo "/${ctr.name}|${ctr.image}";;
      *Image*) echo "sha256:${"c".repeat(64)}";;
      *) ;;
    esac;;
  image)
    case "$4" in
      *RepoDigests*) [ -n "\${DIGESTS:-}" ] && printf '%s\\n' $DIGESTS;;
      *Labels*) printf '%s\\n' "\${VERSION:-}";;
    esac;;
esac
exit 0
`;
  it("reads the registry digests and the version label of the image the container runs, and parses them", () => {
    writeBin("docker", fakeDocker);
    const r = run(buildContainerDetailScript([ctr]), { DIGESTS: `abc@${DG} mirror/abc@${DG}`, VERSION: "1.11.3" });
    expect(r.stdout).toContain(`TUGRA_IP_RDIG|${ID}|abc@${DG}`);
    expect(r.stdout).toContain(`TUGRA_IP_IMGVER|${ID}|1.11.3`);
    const d = parseContainerDetail(r.stdout, [ID])!.get(ID)!;
    expect(d.repoDigests).toEqual([`abc@${DG}`, `mirror/abc@${DG}`]);
    expect(d.imageVersion).toBe("1.11.3");
  });
  it("a host that reports no digest and no label gives a detail with neither (unknown, never a failure)", () => {
    writeBin("docker", fakeDocker);
    const d = parseContainerDetail(run(buildContainerDetailScript([ctr])).stdout, [ID])!.get(ID)!;
    expect(d.restart).toBe("always");
    expect(d.repoDigests).toBeUndefined();
    expect(d.imageVersion).toBeUndefined();
  });
  it("a version label that is not a plain token is never printed; a digest line of another shape is dropped", () => {
    writeBin("docker", fakeDocker);
    const r = run(buildContainerDetailScript([ctr]), { VERSION: "1.0 (beta)" });
    expect(r.stdout).not.toContain("IMGVER");
    const out = [`TUGRA_IP_RESTART|${ID}|always`, `TUGRA_IP_IMAGE|${ID}|sha256:${"c".repeat(64)}`, `TUGRA_IP_RDIG|${ID}|abc@sha256:short`, `TUGRA_IP_RDIG|${ID2}|abc@${DG}`, `TUGRA_IP_IMGVER|${ID}|bad value`, "TUGRA_IP_DETAIL_END"].join("\n");
    const d = parseContainerDetail(out, [ID])!.get(ID)!;
    expect(d.repoDigests).toBeUndefined();
    expect(d.imageVersion).toBeUndefined();
  });
});

describe("probe, executed against a fake curl", () => {
  const fakeCurl = `
out=""; res=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2;; --resolve) res="$2"; shift 2;; -w|-m) shift 2;; -*) shift;; *) url="$1"; shift;; esac
done
echo "$res $url" >> "$FAKE_LOG"
n=$(cat "$FAKE_DIR/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE_DIR/count"
if [ -n "\${DYN:-}" ]; then echo "page $n" > "$out"; else echo "same page" > "$out"; fi
printf '%s %s %s' "\${CODE:-200}" "\${SIZE:-10}" "\${LOC:-}"
`;
  it("prints status and the sha256 of the body, never the body, and goes to the chosen address", () => {
    writeBin("curl", fakeCurl);
    const s = buildInPlaceProbeScript({ via: "local", hosts: ["a.example.com", "b.example.com"], path: "/health" });
    const r = run(s, { FAKE_LOG: join(dir, "log"), FAKE_DIR: dir });
    const want = createHash("sha256").update("same page\n").digest("hex");
    expect(parseInPlaceProbe(r.stdout, ["a.example.com", "b.example.com"])).toEqual({
      kind: "ok",
      hosts: { "a.example.com": { status: 200, hash: want, hash2: want, size: 10, location: null }, "b.example.com": { status: 200, hash: want, hash2: want, size: 10, location: null } },
    });
    expect(r.stdout).not.toContain("same page");
    const log = readFileSync(join(dir, "log"), "utf8");
    expect(log).toContain("a.example.com:443:127.0.0.1 https://a.example.com/health");
  });
  it("two fetches tell a page that changes every time from one that does not", () => {
    writeBin("curl", fakeCurl);
    const s = buildInPlaceProbeScript({ via: "coolify", hosts: ["a.example.com"], path: "/", twice: true });
    const r = run(s, { FAKE_LOG: join(dir, "log"), FAKE_DIR: dir, DYN: "1" });
    const p = parseInPlaceProbe(r.stdout, ["a.example.com"]) as { kind: "ok"; hosts: Record<string, { hash: string; hash2: string }> };
    expect(p.hosts["a.example.com"].hash).not.toBe(p.hosts["a.example.com"].hash2);
  });
  it("a failing curl is status 000, not a pass", () => {
    writeBin("curl", "exit 7");
    const r = run(buildInPlaceProbeScript({ via: "local", hosts: ["a.example.com"], path: "/" }), { FAKE_LOG: join(dir, "log"), FAKE_DIR: dir });
    expect(parseInPlaceProbe(r.stdout, ["a.example.com"])).toEqual({ kind: "ok", hosts: { "a.example.com": { status: null, hash: expect.any(String), hash2: expect.any(String), size: 0, location: null } } });
  });
  it("reports the size and where a redirect goes, without its query string or fragment", () => {
    writeBin("curl", fakeCurl);
    const s = buildInPlaceProbeScript({ via: "local", hosts: ["a.example.com"], path: "/" });
    const r = run(s, { FAKE_LOG: join(dir, "log"), FAKE_DIR: dir, CODE: "301", SIZE: "0", LOC: "https://www.example.com/en?token=SECRET#frag" });
    expect(parseInPlaceProbe(r.stdout, ["a.example.com"])).toMatchObject({ kind: "ok", hosts: { "a.example.com": { status: 301, size: 0, location: "https://www.example.com/en" } } });
    expect(r.stdout).not.toContain("SECRET");
  });
  it("an older host's five-field line still parses (no size, no location)", () => {
    const h = "e".repeat(64);
    expect(parseInPlaceProbe(`TUGRA_IP_PROBE|a.example.com|200|${h}|${h}\nTUGRA_IP_PROBE_END`, ["a.example.com"])).toMatchObject({ hosts: { "a.example.com": { status: 200, size: null, location: null } } });
  });
  it("the app readiness script reads state, health and restarts of each named container and prints absent for a missing one", () => {
    writeBin("docker", `[ "$1" = container ] && [ "$5" = tugra_a ] && { echo "TUGRA_IP_APP|/tugra_a|running|healthy|2"; exit 0; }; exit 1`);
    const out = run(buildAppReadyScript(["tugra_a", "tugra_b"])).stdout;
    expect(parseAppReady(out)).toEqual([
      { name: "tugra_a", state: "running", health: "healthy", restarts: 2 },
      { name: "tugra_b", state: "absent", health: "none", restarts: 0 },
    ]);
    expect(parseAppReady("TUGRA_IP_APP|/x|running|healthy|0")).toBeNull(); // no END
    expect(() => buildAppReadyScript(["a; rm -rf /"])).toThrow();
  });
  it("no curl on the box is reported, not guessed", () => {
    const r = run(buildInPlaceProbeScript({ via: "local", hosts: ["a.example.com"], path: "/" }), { PATH: bin });
    expect(parseInPlaceProbe(r.stdout, ["a.example.com"])).toEqual({ kind: "nocurl" });
  });
  it("the dark probe reads Tugra's proxy bridge address and reports a missing proxy", () => {
    writeBin("curl", fakeCurl);
    writeBin("docker", 'echo "172.18.0.5 "');
    const ok = run(buildInPlaceProbeScript({ via: "tugra-dark", hosts: ["a.example.com"], path: "/" }), { FAKE_LOG: join(dir, "log"), FAKE_DIR: dir });
    expect(parseInPlaceProbe(ok.stdout, ["a.example.com"])).toMatchObject({ kind: "ok" });
    expect(readFileSync(join(dir, "log"), "utf8")).toContain("a.example.com:443:172.18.0.5");
    writeBin("docker", "exit 1");
    const none = run(buildInPlaceProbeScript({ via: "tugra-dark", hosts: ["a.example.com"], path: "/" }), { FAKE_LOG: join(dir, "log"), FAKE_DIR: dir });
    expect(parseInPlaceProbe(none.stdout, ["a.example.com"])).toEqual({ kind: "noproxy" });
  });
});

describe("adopt and alias, executed against a fake docker", () => {
  const fakeDocker = `
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "image inspect") [ -f "$FAKE_DIR/image-ok" ] ;;
  "tag "*) [ -f "$FAKE_DIR/tag-fails" ] && exit 1 || exit 0 ;;
  "volume inspect")
    v=""; for a in "$@"; do v="$a"; done
    [ -f "$FAKE_DIR/vol-$v" ] || exit 1
    case "$*" in *Mountpoint*) echo "/var/lib/docker/volumes/$v/_data";; *device*) cat "$FAKE_DIR/vol-$v";; esac ;;
  "volume create") for a in "$@"; do v="$a"; done; echo "/var/lib/docker/volumes/abc-data/_data" > "$FAKE_DIR/vol-$v"; echo created ;;
esac
`;
  const env = () => ({ FAKE_LOG: join(dir, "log"), FAKE_DIR: dir });
  it("tags the image Coolify built and reports a missing image without tagging", () => {
    writeBin("docker", fakeDocker);
    const s = buildAdoptImageScript({ image: "abc:1234", tag: "tugra_app1:dep1" });
    expect(parseAdopt(run(s, env()).stdout)).toBe("missing");
    writeFileSync(join(dir, "image-ok"), "");
    expect(parseAdopt(run(s, env()).stdout)).toBe("ok");
    const calls = readFileSync(join(dir, "log"), "utf8");
    expect(calls).toContain("tag abc:1234 tugra_app1:dep1");
    expect(calls.match(/^tag /gm)!.length).toBe(1);
    writeFileSync(join(dir, "tag-fails"), "");
    expect(parseAdopt(run(s, env()).stdout)).toBe("failed");
  });
  it("aliases a volume with a bind to the other one's data, no copy, and leaves an existing alias alone", () => {
    writeBin("docker", fakeDocker);
    writeFileSync(join(dir, "vol-abc-data"), "");
    const s = buildVolumeAliasScript([{ from: "abc-data", to: "tugra_appv_app1_data" }]);
    expect(parseAlias(run(s, env()).stdout, ["tugra_appv_app1_data"])!.get("tugra_appv_app1_data")).toBe("created");
    const create = readFileSync(join(dir, "log"), "utf8").split("\n").find((l) => l.startsWith("volume create"))!;
    expect(create).toContain("--opt type=none");
    expect(create).toContain("--opt o=bind");
    expect(create).toContain("device=/var/lib/docker/volumes/abc-data/_data");
    expect(parseAlias(run(s, env()).stdout, ["tugra_appv_app1_data"])!.get("tugra_appv_app1_data")).toBe("present");
  });
  it("refuses to treat an unrelated existing Tugra volume as the alias, and a missing Coolify volume is reported", () => {
    writeBin("docker", fakeDocker);
    writeFileSync(join(dir, "vol-abc-data"), "");
    writeFileSync(join(dir, "vol-tugra_appv_app1_data"), "/somewhere/else\n");
    expect(parseAlias(run(buildVolumeAliasScript([{ from: "abc-data", to: "tugra_appv_app1_data" }]), env()).stdout, ["tugra_appv_app1_data"])!.get("tugra_appv_app1_data")).toBe("foreign");
    expect(parseAlias(run(buildVolumeAliasScript([{ from: "gone-vol", to: "tugra_appv_app2_data" }]), env()).stdout, ["tugra_appv_app2_data"])!.get("tugra_appv_app2_data")).toBe("nosource");
  });
});

describe("restart policy, executed against a fake docker", () => {
  it("changes only a container whose id, name and image still match", () => {
    writeBin(
      "docker",
      `echo "$*" >> "$FAKE_LOG"
case "$1" in
  inspect) case "$*" in *"$FAKE_ID"*) echo "$FAKE_IDENT" ;; *) exit 1;; esac ;;
  update) exit 0 ;;
esac`,
    );
    const env = { FAKE_LOG: join(dir, "log"), FAKE_ID: ID, FAKE_IDENT: "/abc-20261125T101010|abc:1234" };
    const r = run(buildRestartPolicyScript([{ ...ctr, policy: "no" }, { id: ID2, name: "x-1", image: "x:1", policy: "no" }]), env);
    const p = parsePolicy(r.stdout, [ID, ID2]);
    expect(p.get(ID)).toBe("ok");
    expect(p.get(ID2)).toBe("gone");
    const r2 = run(buildRestartPolicyScript([{ ...ctr, policy: "no" }]), { ...env, FAKE_IDENT: "/abc-20261125T101010|evil:latest" });
    expect(parsePolicy(r2.stdout, [ID]).get(ID)).toBe("mismatch");
    expect(readFileSync(join(dir, "log"), "utf8").match(/^update --restart=no /gm)!.length).toBe(1);
  });
});

(HAS_OPENSSL ? describe : describe.skip)("fallback certificate, executed with real openssl on a fixture acme.json", () => {
  function makeCert(cn: string): { cert: string; key: string; serial: string } {
    const kp = join(dir, `${cn}.key`);
    const cp = join(dir, `${cn}.crt`);
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", kp, "-out", cp, "-subj", `/CN=${cn}`, "-days", "30"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const serial = (spawnSync("openssl", ["x509", "-in", cp, "-noout", "-serial"], { encoding: "utf8" }).stdout.trim().replace(/^serial=/, "") || "").toUpperCase();
    return { cert: readFileSync(cp).toString("base64"), key: readFileSync(kp).toString("base64"), serial };
  }
  it("copies the certificate and key to the proxy's directory (key 0600), prints serials only, and reports hosts it has none for", () => {
    const a = makeCert("a.example.com");
    const b = makeCert("b.example.com");
    const acme = {
      letsencrypt: {
        Account: { Email: "x@example.com", Registration: { body: {} }, PrivateKey: "SECRETACCOUNTKEY", KeyType: "4096" },
        Certificates: [
          { domain: { main: "a.example.com", sans: ["www.a.example.com"] }, certificate: a.cert, key: a.key, Store: "default" },
          { domain: { main: "b.example.com" }, certificate: b.cert, key: b.key, Store: "default" },
        ],
      },
    };
    writeFileSync(join(dir, "acme.json"), JSON.stringify(acme, null, 2));
    const dyn = join(dir, "dynamic");
    mkdirSync(dyn);
    const script = buildFallbackInstallScript({ hosts: ["a.example.com", "c.example.com"], acmePath: join(dir, "acme.json") }).replaceAll(PROXY_DYNAMIC_DIR, dyn);
    const r = run(script);
    const res = parseFallbackInstall(r.stdout, ["a.example.com", "c.example.com"])!;
    expect(res.get("a.example.com")).toEqual({ outcome: "installed", serial: a.serial });
    expect(res.get("c.example.com")).toEqual({ outcome: "absent", serial: null });
    const certDir = join(dyn, "certs");
    expect(readdirSync(certDir).sort()).toEqual(["fb-a-example-com.crt", "fb-a-example-com.key"]);
    expect(statSync(join(certDir, "fb-a-example-com.key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dyn, "tls-fb-a-example-com.yml"), "utf8")).toBe("tls:\n  certificates:\n    - certFile: /dynamic/certs/fb-a-example-com.crt\n      keyFile: /dynamic/certs/fb-a-example-com.key\n");
    // the certificate written is the one Coolify held, byte for byte
    expect(readFileSync(join(certDir, "fb-a-example-com.crt"))).toEqual(Buffer.from(a.cert, "base64"));
    // key bytes and the account key never reach what the script prints
    expect(r.stdout + r.stderr).not.toContain(a.key);
    expect(r.stdout + r.stderr).not.toContain(Buffer.from(a.key, "base64").toString().split("\n")[1]);
    expect(r.stdout).not.toContain("SECRETACCOUNTKEY");
    // removing it takes away exactly those files
    const rm = run(buildFallbackRemoveScript(["a.example.com"]).replaceAll(PROXY_DYNAMIC_DIR, dyn));
    expect(rm.stdout).toContain("TUGRA_IP_FALLBACK_REMOVED");
    expect(existsSync(join(dyn, "tls-fb-a-example-com.yml"))).toBe(false);
    expect(readdirSync(certDir)).toEqual([]);
  });
  it("a missing acme.json is `noacme` for every host and writes nothing", () => {
    const dyn = join(dir, "dynamic");
    mkdirSync(dyn);
    const r = run(buildFallbackInstallScript({ hosts: ["a.example.com"], acmePath: join(dir, "none.json") }).replaceAll(PROXY_DYNAMIC_DIR, dyn));
    expect(parseFallbackInstall(r.stdout, ["a.example.com"])!.get("a.example.com")).toEqual({ outcome: "noacme", serial: null });
    expect(readdirSync(dyn)).toEqual([]);
  });
  it("a certificate that is not base64 is `bad` and leaves no half-written file", () => {
    writeFileSync(join(dir, "acme.json"), JSON.stringify({ le: { Certificates: [{ domain: { main: "a.example.com" }, certificate: "@@@", key: "@@@" }] } }, null, 2));
    const dyn = join(dir, "dynamic");
    mkdirSync(dyn);
    const r = run(buildFallbackInstallScript({ hosts: ["a.example.com"], acmePath: join(dir, "acme.json") }).replaceAll(PROXY_DYNAMIC_DIR, dyn));
    expect(parseFallbackInstall(r.stdout, ["a.example.com"])!.get("a.example.com")!.outcome).toBe("absent");
    expect(existsSync(join(dyn, "certs")) ? readdirSync(join(dyn, "certs")) : []).toEqual([]);
  });
});

describe("served-certificate check, executed against a fake openssl", () => {
  it("prints the serial and issuer of what the box serves", () => {
    writeBin("openssl", `case "$1" in s_client) echo fake;; x509) printf 'serial=0A1B\\nissuer=C=US, O=Let\\047s Encrypt, CN=R11\\n';; esac`);
    const r = run(buildNewCertCheckScript("a.example.com"));
    expect(parseNewCertCheck(r.stdout, "a.example.com")).toEqual({ state: "served", serial: "0A1B", issuer: "C=US, O=Let s Encrypt, CN=R11" });
  });
  it("no openssl and no answer are different results", () => {
    expect(parseNewCertCheck(run(buildNewCertCheckScript("a.example.com"), { PATH: bin }).stdout, "a.example.com")).toEqual({ state: "noopenssl" });
    writeBin("openssl", "exit 1");
    expect(parseNewCertCheck(run(buildNewCertCheckScript("a.example.com")).stdout, "a.example.com")).toEqual({ state: "none" });
  });
});

describe("the database fingerprint script", () => {
  const rec = { kind: "recorded" as const, ctr };
  const identBin = `
case "$1" in
  inspect) case "$2" in -f) echo "/\${CTR_NAME:-abc-20261125T101010}|\${CTR_IMAGE:-abc:1234}";; *) exit 0;; esac;;
  exec) shift; [ "$1" = -i ] && shift; shift; exec "$@";;
esac
`;
  const fakePsql = `
in=$(cat)
case "$in" in
  *pg_class*) printf "select 'public.users', count(*) from public.users;\\nselect 'public.orders', count(*) from public.orders;\\n";;
  *) printf 'public.users|%s\\npublic.orders|%s\\n' "\${USERS:-5}" "\${ORDERS:-10}";;
esac
`;
  const fakeMysql = `
in=$(cat)
case "$in" in
  *information_schema*) printf "select 'db.t', count(*) from db.t;\\n";;
  *) printf 'db.t|%s\\n' "\${ROWS:-3}";;
esac
`;
  const setup = () => {
    writeBin("docker", identBin);
    writeBin("psql", fakePsql);
    writeBin("mysql", fakeMysql);
    writeBin("redis-cli", 'echo "NOAUTH Authentication required."');
    writeBin("mongosh", "echo 1");
  };

  it("is read-only: it removes nothing, writes no file, and never asks docker for an environment", () => {
    const s = buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }, { engine: "REDIS", ref: { kind: "name", name: "tugra_db_x" } }]);
    expect(s).not.toMatch(/docker\s+(rm|kill|prune|rmi|system|volume|update|stop|start|run)\b/);
    expect(s).not.toMatch(/\.Config\.Env|printenv|--env|\s-e\s/);
    expect(s).not.toMatch(/rm\s+-[a-z]*r|>\s*\/(?!dev\/null)|>>/);
    expect(spawnSync("/bin/sh", ["-n", "-c", s]).status).toBe(0);
  });
  it("refuses an engine it cannot check, a bad recorded container and a hostile name before anything runs", () => {
    expect(() => buildDbFingerprintScript([{ engine: "CLICKHOUSE" as never, ref: rec }])).toThrow();
    expect(() => buildDbFingerprintScript([{ engine: "POSTGRES", ref: { kind: "recorded", ctr: { ...ctr, id: "short" } } }])).toThrow();
    expect(() => buildDbFingerprintScript([{ engine: "POSTGRES", ref: { kind: "name", name: "x; id" } }])).toThrow();
  });
  it("counts every table inside the container and prints only numbers and a hash: the password and the table names stay in the container", () => {
    setup();
    const r = run(buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }]), { POSTGRES_PASSWORD: "pw-canary-9f2", USERS: "5", ORDERS: "10" });
    const fp = parseDbFingerprint(r.stdout, [ID])!.get(ID)!;
    expect(fp).toMatchObject({ level: "counts", state: "ok", tables: 2, rows: 15 });
    const want = createHash("sha256").update("public.orders|10\npublic.users|5\n").digest("hex");
    expect(fp.hash).toBe(want);
    expect(r.stdout + r.stderr).not.toMatch(/pw-canary|users|orders/);
  });
  it("a changed row count changes the hash, an unchanged database prints the same line", () => {
    setup();
    const a = parseDbFingerprint(run(buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }]), { USERS: "5" }).stdout, [ID])!.get(ID)!;
    const b = parseDbFingerprint(run(buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }]), { USERS: "5" }).stdout, [ID])!.get(ID)!;
    const c = parseDbFingerprint(run(buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }]), { USERS: "6" }).stdout, [ID])!.get(ID)!;
    expect(sameDatabase(a, b)).toBe(true);
    expect(sameDatabase(a, c)).toBe(false);
  });
  it("mysql and mariadb are counted the same way, and a server that asks for a password still counts as answering for the redis family and mongo", () => {
    setup();
    const my = parseDbFingerprint(run(buildDbFingerprintScript([{ engine: "MYSQL", ref: rec }]), { MYSQL_ROOT_PASSWORD: "x" }).stdout, [ID])!.get(ID)!;
    expect(my).toMatchObject({ level: "counts", state: "ok", tables: 1, rows: 3 });
    const alive = parseDbFingerprint(run(buildDbFingerprintScript([{ engine: "REDIS", ref: rec }, { engine: "MONGO", ref: { kind: "name", name: "tugra_db_m" } }])).stdout, [ID, "tugra_db_m"])!;
    expect(alive.get(ID)).toMatchObject({ level: "alive", state: "ok", tables: null, rows: null, hash: null });
    expect(alive.get("tugra_db_m")).toMatchObject({ level: "alive", state: "ok" });
  });
  it("a container that is gone or that is not the recorded one is never read, and a login that fails is `failed`, not a pass", () => {
    setup();
    const gone = run(buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }]), { CTR_NAME: "other-name" });
    expect(parseDbFingerprint(gone.stdout, [ID])!.get(ID)).toMatchObject({ state: "mismatch" });
    writeBin("psql", "exit 2");
    const failed = run(buildDbFingerprintScript([{ engine: "POSTGRES", ref: rec }]));
    expect(parseDbFingerprint(failed.stdout, [ID])!.get(ID)).toMatchObject({ level: "counts", state: "failed", hash: null });
  });
  it("the parser ignores refs it did not ask for, malformed lines and cut output", () => {
    const line = (ref: string, st: string) => `TUGRA_IP_DBFP|${ref}|counts|${st}|2|15|${"d".repeat(64)}`;
    expect(parseDbFingerprint(`${line(ID, "ok")}\n${line(ID2, "ok")}\nTUGRA_IP_DBFP|${ID}|bogus`, [ID])!.size).toBe(1);
    expect(parseDbFingerprint(line(ID, "weird"), [ID])!.size).toBe(0);
    expect(parseDbFingerprint(`${line(ID, "ok")}\n…(truncated)`, [ID])).toBeNull();
  });
  it("sameDatabase: counts need both sides read and equal, alive needs the Tugra side to answer, anything unread is a failure", () => {
    const ok = (o: Partial<DbFingerprint> = {}): DbFingerprint => ({ level: "counts", state: "ok", tables: 2, rows: 15, hash: "d".repeat(64), ...o });
    expect(sameDatabase(ok(), ok())).toBe(true);
    expect(sameDatabase(ok(), ok({ rows: 16 }))).toBe(false);
    expect(sameDatabase(ok(), ok({ hash: "e".repeat(64) }))).toBe(false);
    expect(sameDatabase(null, ok())).toBe(false);
    expect(sameDatabase(ok({ state: "failed" }), ok())).toBe(false);
    expect(sameDatabase(ok(), ok({ state: "failed" }))).toBe(false);
    expect(sameDatabase(ok(), null)).toBe(false);
    expect(sameDatabase(null, { level: "alive", state: "ok", tables: null, rows: null, hash: null })).toBe(true);
    expect(sameDatabase(null, { level: "alive", state: "failed", tables: null, rows: null, hash: null })).toBe(false);
  });
  it("which engines are counted and which only asked", () => {
    expect(["POSTGRES", "MYSQL", "MARIADB"].map((e) => checkLevelOf(e as never))).toEqual(["counts", "counts", "counts"]);
    expect(["REDIS", "KEYDB", "DRAGONFLY", "MONGO"].map((e) => checkLevelOf(e as never))).toEqual(["alive", "alive", "alive", "alive"]);
  });
});
