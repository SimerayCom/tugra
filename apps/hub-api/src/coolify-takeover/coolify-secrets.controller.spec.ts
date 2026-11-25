import "reflect-metadata";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { of, lastValueFrom } from "rxjs";
import { COOLIFY_SECRET_CLASSES } from "@tugra/shared";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { AuditService } from "../audit/audit.service";
import { sanitizeToolResult } from "../mcp/tool-result-sanitizer";
import { CoolifySecretsController } from "./coolify-secrets.controller";
import { SecretsGrantSchema } from "./dto";

const proto = CoolifySecretsController.prototype as any;
const scopesOf = (name: string): string[] | undefined => Reflect.getMetadata(REQUIRE_SCOPES, proto[name]);

describe("CoolifySecretsController", () => {
  it("creating consent needs write AND read:secrets, revoking needs write, listing the default read", () => {
    expect(scopesOf("grant")).toEqual(["write", "read:secrets"]);
    expect(scopesOf("revoke")).toEqual(["write"]);
    expect(scopesOf("list")).toBeUndefined();
  });

  it("has no route that can return a secret value, a key or an envelope: only list, grant and revoke", () => {
    const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    expect(routes.sort()).toEqual(["grant", "list", "revoke"]);
  });

  it("delegates with the caller's id (the service enforces OWNER)", async () => {
    const grants = { list: jest.fn(async () => []), createSecretsGrant: jest.fn(async () => ({ id: "g" })), revoke: jest.fn(async () => ({ id: "g" })) } as any;
    const c = new CoolifySecretsController(grants);
    await c.list({ userId: "u1" } as any, { teamId: "t1" });
    await c.grant({ userId: "u1" } as any, { serverId: "s1", confirm: "host" });
    await c.revoke({ userId: "u1" } as any, "g1");
    expect(grants.list).toHaveBeenCalledWith("u1", "t1");
    expect(grants.createSecretsGrant).toHaveBeenCalledWith("u1", { serverId: "s1", confirm: "host" });
    expect(grants.revoke).toHaveBeenCalledWith("u1", "g1");
  });

  it("redacts key columns for a scope-limited token as a second line of defence", async () => {
    const meta = Reflect.getMetadata(INTERCEPTORS_METADATA, CoolifySecretsController) as unknown[];
    const itc = meta.find((i) => i instanceof RedactSecretsInterceptor) as RedactSecretsInterceptor;
    expect(itc).toBeDefined();
    const ctx = { getType: () => "http", switchToHttp: () => ({ getRequest: () => ({ user: { scopes: ["read"] } }) }) } as any;
    const body = { id: "g", recipientKeyEnc: "tk1.x", recipientPublicKey: "AAAA", runId: "r" };
    const out = await lastValueFrom(itc.intercept(ctx, { handle: () => of(body) } as any));
    expect(out).toEqual({ id: "g", recipientKeyEnc: null, recipientPublicKey: null, runId: null });
  });
});

describe("secret grant request body", () => {
  const ok = { serverId: "s1", confirm: "host" };
  it("accepts the minimal body and every known class", () => {
    expect(SecretsGrantSchema.safeParse(ok).success).toBe(true);
    expect(SecretsGrantSchema.safeParse({ ...ok, classes: [...COOLIFY_SECRET_CLASSES], hours: 168 }).success).toBe(true);
  });
  it("rejects what the service would also refuse, before it gets there", () => {
    for (const bad of [{}, { serverId: "s1" }, { ...ok, confirm: "" }, { ...ok, classes: [] }, { ...ok, classes: ["app_key"] }, { ...ok, hours: 0 }, { ...ok, hours: 169 }, { ...ok, hours: 1.5 }, { ...ok, hours: "24" }]) {
      expect(SecretsGrantSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("secret material never leaves through the generic surfaces", () => {
  it("the MCP sanitizer nulls the wrapped run key, the import-session key and snapshot, and any envelope", () => {
    const out = sanitizeToolResult({ id: "g", recipientKeyEnc: "tk1.a", recipientKey: "AAAA", sessionKeyEnc: "tk1.b", snapshotEnc: "tk1.c", sealed: "tse1.x", envelope: "tse1.y", classes: ["env"] }) as Record<string, unknown>;
    expect(out).toEqual({ id: "g", recipientKeyEnc: null, recipientKey: null, sessionKeyEnc: null, snapshotEnc: null, sealed: null, envelope: null, classes: ["env"] });
  });

  it("the audit read side strips the key and envelope keys from meta", async () => {
    const rows = [{ id: "a1", actor: "u1", action: "coolify.secrets.grant", target: "s1", meta: { classes: ["env"], recipientKey: "AAAA", recipientKeyEnc: "tk1.z", sealed: "tse1.q", envelope: "tse1.r", hours: 24 }, createdAt: new Date() }];
    const prisma = { user: { findMany: jest.fn(async () => []) }, auditLog: { findMany: jest.fn(async () => rows) } } as any;
    const svc = new AuditService(prisma);
    const views = await (svc as any).toViews(rows);
    expect(views[0].meta).toEqual({ classes: ["env"], hours: 24 });
  });
});
