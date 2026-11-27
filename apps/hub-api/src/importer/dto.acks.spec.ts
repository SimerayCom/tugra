import { ImportApplySchema, ImportAckSchema } from "./dto";

const base = { sessionId: "s", targetServerId: "t", planHash: "a".repeat(32) };

describe("ImportApplySchema acks", () => {
  it("accepts per-item and apply-wide acks for the two ackable codes only", () => {
    const ok = ImportApplySchema.safeParse({ sourceKind: "coolify", ...base, acks: [{ code: "app.env.unresolved" }, { code: "app.env.key.invalid", itemRef: "app:s1:a1" }] });
    expect(ok.success).toBe(true);
  });
  it("tokenReadOnly and any other blocker code can never be acknowledged (the enum is the allow-list)", () => {
    for (const code of ["app.env.tokenReadOnly", "app.env.consentRequired", "app.git.missing", "db.engine.unknown", "app.env.unresolvable"]) {
      expect(ImportAckSchema.safeParse({ code }).success).toBe(false);
    }
  });
  it("omitted acks is valid (existing callers unchanged); caps at 2000; rejects empty/oversized itemRef", () => {
    expect(ImportApplySchema.safeParse({ sourceKind: "dokploy", ...base }).success).toBe(true);
    expect(ImportApplySchema.safeParse({ sourceKind: "coolify", ...base, acks: Array.from({ length: 2001 }, () => ({ code: "app.env.unresolved" })) }).success).toBe(false);
    expect(ImportAckSchema.safeParse({ code: "app.env.unresolved", itemRef: "" }).success).toBe(false);
    expect(ImportAckSchema.safeParse({ code: "app.env.unresolved", itemRef: "x".repeat(301) }).success).toBe(false);
  });
  it("local-docker takes no acks", () => {
    const r = ImportApplySchema.parse({ sourceKind: "local-docker", serverId: "s", planHash: "a".repeat(32), acks: [{ code: "app.env.unresolved" }] });
    expect(r).not.toHaveProperty("acks");
  });
});
