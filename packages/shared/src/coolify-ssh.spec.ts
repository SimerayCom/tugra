import {
  COOLIFY_SSH_CONTAINER_ID_RE,
  COOLIFY_SSH_HOSTKEY_FP_RE,
  COOLIFY_SSH_RESULT_CODES,
  COOLIFY_SSH_TOKEN_RE,
  COOLIFY_SSH_UUID_RE,
  canonicalCoolifySsh,
  coolifySshOffersManualCommand,
  type CoolifySshFields,
} from "./coolify-ssh";

const base: CoolifySshFields = {
  reqId: "r1",
  op: "probe",
  coolifyServerUuid: "abc123def456",
  scriptSha256: "a".repeat(64),
  payloadSha256: "b".repeat(64),
  useSudo: false,
  expectedHostKeyFp: "",
  exp: 1800000000,
  capability: "coolify_ssh",
};

describe("canonicalCoolifySsh", () => {
  // The same literal is asserted by the Go test (agent/internal/protocol/coolify_ssh_test.go): the two sides sign and verify one text.
  it("renders the shared vector", () => {
    expect(canonicalCoolifySsh(base)).toBe(
      "cssh\n2:r1\n5:probe\n12:abc123def456\n64:" + "a".repeat(64) + "\n64:" + "b".repeat(64) + "\n1:0\n0:\n10:1800000000\n11:coolify_ssh",
    );
  });

  it("changes when any single field changes", () => {
    const ref = canonicalCoolifySsh(base);
    const variants: Partial<CoolifySshFields>[] = [
      { reqId: "r2" }, { op: "install" }, { coolifyServerUuid: "zzz123def456" }, { scriptSha256: "c".repeat(64) }, { payloadSha256: "d".repeat(64) },
      { useSudo: true }, { expectedHostKeyFp: "SHA256:" + "A".repeat(43) }, { exp: 1800000001 }, { capability: "coolify_secrets" },
    ];
    for (const v of variants) expect(canonicalCoolifySsh({ ...base, ...v })).not.toBe(ref);
  });

  it("cannot be forged by moving a newline between fields", () => {
    const a = canonicalCoolifySsh({ ...base, reqId: "x\n5:probe", op: "probe" });
    const b = canonicalCoolifySsh({ ...base, reqId: "x", op: "probe" });
    expect(a).not.toBe(b);
  });
});

describe("coolify ssh shapes", () => {
  it("accepts Coolify uuids and refuses anything that could be an option or a path", () => {
    expect(COOLIFY_SSH_UUID_RE.test("abc123def456ghi789jkl012")).toBe(true);
    for (const bad of ["-oProxyCommand=x", "ABC123DEF456", "a/b", "abc", "", "abc123 def456", "abc123def456\n"]) expect(COOLIFY_SSH_UUID_RE.test(bad)).toBe(false);
  });
  it("accepts the enroll token shape only", () => {
    expect(COOLIFY_SSH_TOKEN_RE.test("tugra_en_" + "A".repeat(32))).toBe(true);
    for (const bad of ["", "tugra_en_x", "x tugra_en_" + "A".repeat(32), "tugra_en_" + "A".repeat(32) + "; rm -rf /", "tugra_en_" + "A".repeat(32) + "\n"]) {
      expect(COOLIFY_SSH_TOKEN_RE.test(bad)).toBe(false);
    }
  });
  it("accepts a sha256 fingerprint or nothing, and a 64-hex container id", () => {
    expect(COOLIFY_SSH_HOSTKEY_FP_RE.test("")).toBe(true);
    expect(COOLIFY_SSH_HOSTKEY_FP_RE.test("SHA256:" + "A".repeat(43))).toBe(true);
    expect(COOLIFY_SSH_HOSTKEY_FP_RE.test("MD5:aa:bb")).toBe(false);
    expect(COOLIFY_SSH_CONTAINER_ID_RE.test("f".repeat(64))).toBe(true);
    expect(COOLIFY_SSH_CONTAINER_ID_RE.test("tugra-agent")).toBe(false);
  });
  it("offers the manual command after a retryable failure only", () => {
    expect(coolifySshOffersManualCommand("needs_root")).toBe(true);
    expect(coolifySshOffersManualCommand("unsupported_proxy")).toBe(true);
    for (const c of ["hostkey_mismatch", "hostkey_changed", "cancelled", "skipped_present", "skipped_foreign", "ok_installed"] as const) {
      expect(coolifySshOffersManualCommand(c)).toBe(false);
    }
    expect(coolifySshOffersManualCommand(null)).toBe(false);
    for (const c of COOLIFY_SSH_RESULT_CODES) expect(typeof coolifySshOffersManualCommand(c)).toBe("boolean");
  });
});
