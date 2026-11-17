import { buildEnvReport, classifyEnvRow, ENV_REPORT_MAX_ENTRIES, ENV_REPORT_KEY_MAX } from "./env-report";

// Real-shaped Coolify /applications/<uuid>/envs rows (read:sensitive token => value + real_value present).
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
const sensitiveRows = [
  { uuid: "e1", key: "DATABASE_URL", value: "postgres://u:s3cr3t@host/db", real_value: "postgres://u:s3cr3t@host/db", is_preview: false, is_buildtime: true, is_runtime: true, is_shared: false, is_coolify: false, is_literal: false, is_multiline: false },
  { uuid: "e2", key: "TLS_KEY", value: PEM, real_value: PEM, is_preview: false, is_multiline: true },
  { uuid: "e3", key: "SHARED_TOKEN", value: "{{team.SHARED_TOKEN}}", real_value: "{{team.SHARED_TOKEN}}", is_shared: true, is_preview: false },
  { uuid: "e4", key: "SERVICE_FQDN_WEB", is_coolify: true, is_preview: false },
  { uuid: "e5", key: "HAS=EQUALS", value: "x", real_value: "x", is_preview: false },
  { uuid: "e6", key: "HAS SPACE", value: "x", real_value: "x" },
  { uuid: "e7", key: "__proto__", value: "x", real_value: "x" },
  { uuid: "e8", key: "DATABASE_URL", value: "postgres://u:preview-pw@host/pdb", real_value: "postgres://u:preview-pw@host/pdb", is_preview: true },
];

describe("classifyEnvRow", () => {
  it("classifies each real row shape", () => {
    expect(classifyEnvRow(sensitiveRows[0])).toEqual({ kind: "value", key: "DATABASE_URL", value: "postgres://u:s3cr3t@host/db" });
    expect(classifyEnvRow(sensitiveRows[1])).toMatchObject({ kind: "value", key: "TLS_KEY", value: PEM }); // multiline PEM is a normal value
    expect(classifyEnvRow(sensitiveRows[2])).toEqual({ kind: "unresolved", key: "SHARED_TOKEN", reason: "SHARED_UNEXPANDED" });
    expect(classifyEnvRow(sensitiveRows[3])).toEqual({ kind: "unresolved", key: "SERVICE_FQDN_WEB", reason: "MAGIC" });
    expect(classifyEnvRow(sensitiveRows[4])).toEqual({ kind: "invalid", key: "HAS=EQUALS" });
    expect(classifyEnvRow(sensitiveRows[7])).toEqual({ kind: "preview" });
    expect(classifyEnvRow({ key: "PLAIN" })).toEqual({ kind: "unresolved", key: "PLAIN", reason: "NO_VALUE" });
    expect(classifyEnvRow({ key: "S", is_shared: true })).toEqual({ kind: "unresolved", key: "S", reason: "SHARED_UNEXPANDED" });
    expect(classifyEnvRow({ value: "x" })).toEqual({ kind: "skip" });
    expect(classifyEnvRow(null)).toEqual({ kind: "skip" });
  });

  it("a literal row is never interpolated, so brace text in it is real data (not an unexpanded reference)", () => {
    expect(classifyEnvRow({ key: "TPL", value: "{{team.X}}", real_value: "{{team.X}}", is_literal: true })).toEqual({ kind: "value", key: "TPL", value: "{{team.X}}" });
    expect(classifyEnvRow({ key: "TPL2", value: "{{ project.X }}" })).toMatchObject({ kind: "unresolved", reason: "SHARED_UNEXPANDED" });
  });
});

describe("buildEnvReport", () => {
  it("reports PEM multiline as carried, shared-unexpanded + magic as unresolved, invalid keys by name, preview twins counted", () => {
    const r = buildEnvReport(sensitiveRows);
    expect(r.total).toBe(7); // the preview twin is not counted
    expect(r.previewSkipped).toBe(1);
    expect(r.unresolved).toEqual([
      { key: "SERVICE_FQDN_WEB", reason: "MAGIC" },
      { key: "SHARED_TOKEN", reason: "SHARED_UNEXPANDED" },
    ]);
    expect(r.invalidKeys).toEqual(["HAS SPACE", "HAS=EQUALS", "__proto__"]); // sorted
    expect(r.tokenReadOnly).toBe(false);
  });

  it("tokenReadOnly: variables exist but NO row carries a value (token lacks read:sensitive)", () => {
    const r = buildEnvReport([{ key: "A" }, { key: "B", is_shared: true }, { key: "C", is_coolify: true }]);
    expect(r.tokenReadOnly).toBe(true);
    expect(r.total).toBe(3);
    expect(r.unresolved.map((u) => u.key)).toEqual(["A", "B", "C"]);
    // no rows at all is NOT a read-only token
    expect(buildEnvReport([]).tokenReadOnly).toBe(false);
    expect(buildEnvReport("not-an-array").total).toBe(0);
    // only preview rows: nothing to read, not read-only
    expect(buildEnvReport([{ key: "P", is_preview: true }]).tokenReadOnly).toBe(false);
  });

  it("VALUES NEVER appear in the serialized report (recursive scan of every string)", () => {
    const json = JSON.stringify(buildEnvReport(sensitiveRows));
    for (const secret of ["s3cr3t", "preview-pw", "MIIEowIBAAKCAQEA", "BEGIN RSA", "{{team", "postgres://"]) expect(json).not.toContain(secret);
  });

  it("caps entries and key length", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ key: `K${String(i).padStart(4, "0")}` }));
    const r = buildEnvReport(rows);
    expect(r.unresolved).toHaveLength(ENV_REPORT_MAX_ENTRIES);
    const long = buildEnvReport([{ key: "A".repeat(500), value: "v" }]);
    expect(long.invalidKeys[0]).toHaveLength(ENV_REPORT_KEY_MAX); // > ENV_KEY_MAX => invalid, clipped for display
  });

  it("is order-independent", () => {
    expect(buildEnvReport([...sensitiveRows].reverse())).toEqual(buildEnvReport(sensitiveRows));
  });
});

describe("locked variables (Coolify 4.7 is_shown_once)", () => {
  // The REAL 4.7.5 shape: a locked row has no value and no real_value even for a read:sensitive token.
  const locked = { uuid: "l1", key: "LOCKED_SECRET", is_shown_once: true, is_preview: false, is_shared: false, is_coolify: false };

  it("classifies a locked row with its own LOCKED reason (never NO_VALUE), also when it is shared or a magic variable", () => {
    expect(classifyEnvRow(locked)).toEqual({ kind: "unresolved", key: "LOCKED_SECRET", reason: "LOCKED" });
    expect(classifyEnvRow({ ...locked, is_shared: true })).toMatchObject({ reason: "LOCKED" });
    expect(classifyEnvRow({ ...locked, is_coolify: true })).toMatchObject({ reason: "LOCKED" });
  });

  it("a locked row that DOES carry a value (an older instance) is carried like any other", () => {
    expect(classifyEnvRow({ ...locked, value: "v", real_value: "v" })).toEqual({ kind: "value", key: "LOCKED_SECRET", value: "v" });
  });

  it("when EVERY variable is locked the token is not blamed: no tokenReadOnly, each key reported LOCKED", () => {
    const r = buildEnvReport([locked, { ...locked, key: "OTHER_LOCKED" }]);
    expect(r.tokenReadOnly).toBe(false);
    expect(r.total).toBe(2);
    expect(r.unresolved).toEqual([
      { key: "LOCKED_SECRET", reason: "LOCKED" },
      { key: "OTHER_LOCKED", reason: "LOCKED" },
    ]);
  });

  it("a locked row beside readable ones changes nothing for the others; beside unreadable ones the token is still the problem", () => {
    expect(buildEnvReport([locked, { key: "A", value: "x" }]).tokenReadOnly).toBe(false);
    const r = buildEnvReport([locked, { key: "A" }]); // no value on a NON-locked row: the token lacks read:sensitive
    expect(r.tokenReadOnly).toBe(true);
    expect(r.unresolved).toEqual([
      { key: "A", reason: "NO_VALUE" },
      { key: "LOCKED_SECRET", reason: "LOCKED" },
    ]);
  });
});
