import {
  canonicalCoolifySecrets,
  coolifySealAad,
  COOLIFY_SECRET_REF_RE,
  COOLIFY_SECRET_REF_KINDS,
  COOLIFY_SECRET_CLASSES,
  COOLIFY_SECRET_TIER,
  COOLIFY_SECRET_WIRE_CODES,
  COOLIFY_SECRETS_MAX_REFS_PER_FRAME,
  COOLIFY_SECRETS_REFUSAL_CODES,
} from "./index";

describe("coolify secrets: signed frame", () => {
  const f = { serverId: "srv-1", reqId: "req-1", runId: "run-1", classes: ["env", "s3"], refs: ["env:abc", "s3:xyz"], recipientKey: "AAAA", exp: 1800000000, capability: "coolify_secrets" };

  it("is byte-identical to the Go canonical form (the same golden string is asserted in agent/internal/protocol)", () => {
    expect(canonicalCoolifySecrets(f)).toBe("coolify_secrets\n5:srv-1\n5:req-1\n5:run-1\n6:env,s3\n14:env:abc,s3:xyz\n4:AAAA\n10:1800000000\n15:coolify_secrets");
  });

  it("cannot be shifted by a newline inside a field", () => {
    const a = canonicalCoolifySecrets({ ...f, serverId: "a\n1:b", reqId: "c" });
    const b = canonicalCoolifySecrets({ ...f, serverId: "a", reqId: "b\n1:c" });
    expect(a).not.toBe(b);
  });

  it("changes with every field (a frame cannot be re-aimed)", () => {
    const base = canonicalCoolifySecrets(f);
    const variants = [
      { serverId: "srv-2" }, { reqId: "req-2" }, { runId: "run-2" }, { classes: ["env"] }, { refs: ["env:abc"] }, { recipientKey: "BBBB" }, { exp: 1800000001 }, { capability: "database" },
    ];
    for (const v of variants) expect(canonicalCoolifySecrets({ ...f, ...v })).not.toBe(base);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(canonicalCoolifySecrets({ ...f, runId: "é" })).toContain("\n2:é\n");
  });
});

describe("coolify secrets: seal context", () => {
  it("binds run, server, ref, field and class with NUL separators", () => {
    expect(coolifySealAad({ runId: "r", serverId: "s", ref: "env:x", field: "value", cls: "env" })).toBe("r\u0000s\u0000env:x\u0000value\u0000env");
  });
  it("refuses an empty part or a NUL inside a part", () => {
    expect(() => coolifySealAad({ runId: "", serverId: "s", ref: "env:x", field: "v", cls: "env" })).toThrow();
    expect(() => coolifySealAad({ runId: "r", serverId: "s", ref: "env:x", field: "v\u0000", cls: "env" })).toThrow();
  });
});

describe("coolify secrets: vocabulary", () => {
  it("has a tier for every class, T0 is not a class", () => {
    for (const c of COOLIFY_SECRET_CLASSES) expect(["T1", "T2"]).toContain(COOLIFY_SECRET_TIER[c]);
    expect(COOLIFY_SECRET_CLASSES).not.toContain("app_key" as never);
    expect(COOLIFY_SECRET_REF_KINDS).not.toContain("server_key" as never);
  });
  it("accepts a ref of a known shape and rejects SQL-looking ones", () => {
    expect(COOLIFY_SECRET_REF_RE.test("env:ok4w0cs")).toBe(true);
    expect(COOLIFY_SECRET_REF_RE.test("s3:x_1")).toBe(true);
    for (const bad of ["env:a'b", "env:a b", "env:", "ENV:abc", "env:a;b", "env:a\nb"]) expect(COOLIFY_SECRET_REF_RE.test(bad)).toBe(false);
  });
  it("keeps the wire and refusal codes closed and distinct", () => {
    expect(COOLIFY_SECRET_WIRE_CODES).toContain("bad_mac");
    expect(new Set(COOLIFY_SECRETS_REFUSAL_CODES).size).toBe(COOLIFY_SECRETS_REFUSAL_CODES.length);
    expect(COOLIFY_SECRETS_MAX_REFS_PER_FRAME).toBe(200);
  });
});
