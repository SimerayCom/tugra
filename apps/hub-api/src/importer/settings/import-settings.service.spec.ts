import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImportSettingsService } from "./import-settings.service";
import type { RawSettings } from "./settings-types";

const unavailable = { ok: false, reason: "not_exposed" } as const;
const raw = (over: Partial<RawSettings> = {}): RawSettings => ({ notifications: unavailable, sharedVariables: unavailable, storages: unavailable, scheduledTasks: unavailable, serverSettings: unavailable, tags: unavailable, members: unavailable, ...over });

function make(settings: RawSettings, opts: { supported?: boolean; opTasks?: unknown[]; opActor?: string } = {}) {
  const source = { readSettings: opts.supported === false ? undefined : jest.fn().mockResolvedValue(settings), close: jest.fn().mockResolvedValue(undefined) };
  const importer = { openSession: jest.fn().mockResolvedValue({ source, session: { id: "sess", teamId: "team-1", sourceKind: "coolify" } }) };
  const prisma = {
    notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
    sharedVariable: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    backupDestination: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    teamInvitation: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue({ email: "me@example.com" }) },
    scheduledTask: { findMany: jest.fn().mockResolvedValue([]) },
    server: { findFirst: jest.fn().mockResolvedValue({ id: "tugra-srv" }) },
    application: { findMany: jest.fn().mockResolvedValue([{ id: "tugra-app-1", teamId: "team-1" }]), findFirst: jest.fn().mockResolvedValue({ tags: ["x"] }) },
    database: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ tags: [] }) },
    bulkOperation: { findUnique: jest.fn().mockResolvedValue({ id: "op-1", kind: "import", actorId: opts.opActor ?? "u1", tasks: opts.opTasks ?? [{ itemRef: "app:_:app-1", resourceType: "application", resourceId: "tugra-app-1" }] }) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const notifications = { create: jest.fn().mockImplementation(async (_u: string, d: { name: string }) => ({ id: `ch-${d.name}`, name: d.name })), update: jest.fn().mockResolvedValue({}) };
  const destinations = { create: jest.fn().mockResolvedValue({ id: "dest-1", recoveryKey: "recovery-key-once" }) };
  const sharedVars = { upsert: jest.fn().mockResolvedValue({ id: "var-1" }) };
  const tasks = { create: jest.fn().mockResolvedValue({ id: "task-1" }) };
  const cleanup = { setConfig: jest.fn().mockResolvedValue(undefined) };
  const teams = { invite: jest.fn().mockResolvedValue({ id: "inv-1" }) };
  const apps = { setTags: jest.fn().mockResolvedValue(undefined) };
  const databases = { setTags: jest.fn().mockResolvedValue(undefined) };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const svc = new ImportSettingsService(prisma as never, audit as never, importer as never, notifications as never, destinations as never, sharedVars as never, tasks as never, cleanup as never, teams as never, apps as never, databases as never, access as never);
  return { access, svc, source, importer, prisma, audit, notifications, destinations, sharedVars, tasks, cleanup, teams, apps, databases };
}

const telegram: RawSettings["notifications"] = {
  ok: true,
  items: [{ kind: "telegram", enabled: false, secretsReadable: true, providerType: "telegram", config: { botToken: "bot-token-1", chatId: "-100123" }, events: [{ event: "deployment_success", threadId: "5" }, { event: "deployment_failure", threadId: "6" }] }],
};

describe("ImportSettingsService.preview", () => {
  it("opens the caller's session (authz lives there) and returns the secret-free plan", async () => {
    const { svc, importer, source } = make(raw({ notifications: telegram }));
    const out = await svc.preview("u1", { sessionId: "sess" });
    expect(importer.openSession).toHaveBeenCalledWith("u1", "sess", undefined);
    expect(out.supported).toBe(true);
    expect(JSON.stringify(out)).not.toContain("bot-token-1");
    expect(source.close).toHaveBeenCalled();
  });

  it("a source that carries no settings is reported unsupported", async () => {
    const { svc } = make(raw(), { supported: false });
    await expect(svc.preview("u1", { sessionId: "sess" })).resolves.toEqual({ supported: false, sections: [] });
  });

  it("refuses another user's operation", async () => {
    const { svc } = make(raw(), { opActor: "someone-else" });
    await expect(svc.preview("u1", { sessionId: "sess", opId: "op-1" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an unknown operation is a 404", async () => {
    const { svc, prisma } = make(raw());
    prisma.bulkOperation.findUnique.mockResolvedValue(null);
    await expect(svc.preview("u1", { sessionId: "sess", opId: "nope" })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ImportSettingsService.apply: notifications", () => {
  it("creates one channel per topic in the session's team with the mapped events, secrets in the config only, disabled like the source", async () => {
    const { svc, notifications, audit } = make(raw({ notifications: telegram }));
    const out = await svc.apply("u1", { sessionId: "sess", select: ["notification:telegram"] });
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith("u1", { name: "Telegram (Coolify) - topic 5", type: "telegram", teamId: "team-1", config: { botToken: "bot-token-1", chatId: "-100123", messageThreadId: 5 }, eventTypes: ["deploy_success"] });
    expect(notifications.create).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "Telegram (Coolify) - topic 6", eventTypes: ["deploy_failed"] }));
    expect(notifications.update).toHaveBeenCalledTimes(2); // the Coolify channel was off
    expect(notifications.update).toHaveBeenCalledWith("u1", "ch-Telegram (Coolify) - topic 5", { enabled: false });
    expect(out.results[0]).toMatchObject({ status: "created", section: "notifications", channels: [{ id: "ch-Telegram (Coolify) - topic 5" }, { id: "ch-Telegram (Coolify) - topic 6" }] });
    expect(out.counts).toEqual({ created: 1, skipped: 0, failed: 0 });
    // no secret in the response or the audit row
    expect(JSON.stringify(out)).not.toContain("bot-token-1");
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain("bot-token-1");
  });

  it("a failure after the first topic channel keeps that channel in the result", async () => {
    const { svc, notifications } = make(raw({ notifications: telegram }));
    notifications.create.mockImplementationOnce(async (_u: string, d: { name: string }) => ({ id: `ch-${d.name}` })).mockRejectedValueOnce(new ConflictException("x"));
    const out = await svc.apply("u1", { sessionId: "sess", select: ["notification:telegram"] });
    expect(out.results[0]).toMatchObject({ status: "failed", code: "conflict", channels: [{ id: "ch-Telegram (Coolify) - topic 5" }] });
  });

  it("is idempotent: a second run skips the channels that exist", async () => {
    const { svc, notifications, prisma } = make(raw({ notifications: telegram }));
    prisma.notificationChannel.findMany.mockResolvedValue([{ name: "Telegram (Coolify) - topic 5" }, { name: "Telegram (Coolify) - topic 6" }]);
    const out = await svc.apply("u1", { sessionId: "sess", select: ["notification:telegram"] });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(out.results[0]).toMatchObject({ status: "skipped", code: "exists" });
  });

  it("an entry the preview did not offer is never applied (unknown / unreadable)", async () => {
    const { svc, notifications } = make(raw({ notifications: { ok: true, items: [{ kind: "slack", enabled: true, secretsReadable: false, providerType: "slack", config: {}, events: [] }] } }));
    const out = await svc.apply("u1", { sessionId: "sess", select: ["notification:slack", "notification:made-up"] });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(out.results.map((r) => [r.status, r.code])).toEqual([["skipped", "needs_sensitive"], ["skipped", "unknown_entry"]]);
  });

  it("a permission refusal from the service is a fixed 'forbidden' code, with no message leaked", async () => {
    const { svc, notifications } = make(raw({ notifications: telegram }));
    notifications.create.mockRejectedValue(new ForbiddenException("integrations permission required for team-1"));
    const out = await svc.apply("u1", { sessionId: "sess", select: ["notification:telegram"] });
    expect(out.results[0]).toEqual({ id: "notification:telegram", section: "notifications", status: "failed", code: "forbidden" });
    expect(out.counts.failed).toBe(1);
  });
});

describe("ImportSettingsService.apply: other sections", () => {
  it("shared variables: written through the variables service, never overwriting an existing key", async () => {
    const vars: RawSettings["sharedVariables"] = { ok: true, items: [{ scope: "team", key: "API_URL", value: "super-secret-value", locked: false }] };
    const { svc, sharedVars, prisma } = make(raw({ sharedVariables: vars }));
    const out = await svc.apply("u1", { sessionId: "sess", select: ["variable:team:API_URL"] });
    expect(sharedVars.upsert).toHaveBeenCalledWith("u1", "team-1", "API_URL", "super-secret-value");
    expect(JSON.stringify(out)).not.toContain("super-secret-value");
    sharedVars.upsert.mockClear();
    prisma.sharedVariable.findUnique.mockResolvedValue({ id: "x" }); // raced in between
    const again = await svc.apply("u1", { sessionId: "sess", select: ["variable:team:API_URL"] });
    expect(sharedVars.upsert).not.toHaveBeenCalled();
    expect(again.results[0]).toMatchObject({ status: "skipped", code: "exists" });
  });

  it("storages: needs the operator's keys (the source API never has them); returns the recovery key once", async () => {
    const st: RawSettings["storages"] = { ok: true, items: [{ ref: "s1", name: "Backups", type: "s3", endpoint: "https://s3.example.com", bucket: "acme", region: "eu-1", skipTlsVerification: false }] };
    const { svc, destinations } = make(raw({ storages: st }));
    const missing = await svc.apply("u1", { sessionId: "sess", select: ["storage:s1"] });
    expect(missing.results[0]).toMatchObject({ status: "failed", code: "credentials_required" });
    expect(destinations.create).not.toHaveBeenCalled();
    const ok = await svc.apply("u1", { sessionId: "sess", select: ["storage:s1"], s3Credentials: { "storage:s1": { accessKey: "AK", secretKey: "SK" } } });
    expect(destinations.create).toHaveBeenCalledWith("u1", { teamId: "team-1", name: "Backups", type: "S3", s3Bucket: "acme", s3Endpoint: "https://s3.example.com", s3Region: "eu-1", s3AccessKey: "AK", s3SecretKey: "SK" });
    expect(ok.results[0]).toMatchObject({ status: "created", targetId: "dest-1", recoveryKey: "recovery-key-once" });
  });

  it("scheduled tasks: created on the imported app, only with an operation", async () => {
    const t: RawSettings["scheduledTasks"] = { ok: true, items: [{ resourceKind: "application", resourceRef: "app-1", resourceName: "web", ref: "t1", name: "Nightly", command: "run-it", frequency: "daily", enabled: true, timeoutSec: 60 }] };
    const { svc, tasks } = make(raw({ scheduledTasks: t }));
    const without = await svc.apply("u1", { sessionId: "sess", select: ["task:app-1:t1"] });
    expect(without.results[0]).toMatchObject({ status: "skipped", code: "needs_import" });
    const out = await svc.apply("u1", { sessionId: "sess", opId: "op-1", select: ["task:app-1:t1"] });
    expect(tasks.create).toHaveBeenCalledWith("u1", "tugra-app-1", { name: "Nightly", schedule: "0 0 * * *", command: "run-it", enabled: true, timeoutSec: 60 });
    expect(out.results[0].status).toBe("created");
  });

  it("settings land in the team the import landed in, not the connection's team (multi-team)", async () => {
    const vars: RawSettings["sharedVariables"] = { ok: true, items: [{ scope: "team", key: "API_URL", value: "v", locked: false }] };
    const t: RawSettings["scheduledTasks"] = { ok: true, items: [{ resourceKind: "application", resourceRef: "app-1", resourceName: "web", ref: "t1", name: "Nightly", command: "run-it", frequency: "daily", enabled: true }] };
    const { svc, sharedVars, tasks, prisma, access } = make(raw({ sharedVariables: vars, scheduledTasks: t }));
    prisma.application.findMany.mockResolvedValue([{ id: "tugra-app-1", teamId: "team-2" }]);
    const out = await svc.apply("u1", { sessionId: "sess", opId: "op-1", select: ["variable:team:API_URL", "task:app-1:t1"] });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "team-2", "apps:config");
    expect(sharedVars.upsert).toHaveBeenCalledWith("u1", "team-2", "API_URL", "v");
    expect(tasks.create).toHaveBeenCalled();
    expect(out.counts.created).toBe(2);
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: "team-2" } }));
  });

  it("a caller without apps:config on the target team is refused", async () => {
    const { svc, access, prisma } = make(raw());
    prisma.application.findMany.mockResolvedValue([{ id: "tugra-app-1", teamId: "team-2" }]);
    access.requirePermission.mockRejectedValue(new ForbiddenException("no"));
    await expect(svc.preview("u1", { sessionId: "sess", opId: "op-1" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an explicit teamId (no operation yet) is checked and used for the plan and the writes", async () => {
    const vars: RawSettings["sharedVariables"] = { ok: true, items: [{ scope: "team", key: "API_URL", value: "v", locked: false }] };
    const { svc, access, sharedVars } = make(raw({ sharedVariables: vars }));
    await svc.apply("u1", { sessionId: "sess", teamId: "team-3", select: ["variable:team:API_URL"] });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "team-3", "apps:config");
    expect(sharedVars.upsert).toHaveBeenCalledWith("u1", "team-3", "API_URL", "v");
  });

  it("the session's own team needs no extra permission check", async () => {
    const { svc, access } = make(raw());
    await svc.preview("u1", { sessionId: "sess", teamId: "team-1" });
    expect(access.requirePermission).not.toHaveBeenCalled();
  });

  it("apply reads only the sections that hold a selected entry", async () => {
    const { svc, source } = make(raw());
    await svc.apply("u1", { sessionId: "sess", select: ["variable:team:A", "tag:x"] });
    expect(source.readSettings).toHaveBeenCalledWith(new Set(["sharedVariables", "tags"]));
  });

  it("server settings: needs a mapped server of the session's team, then writes through the cleanup service", async () => {
    const c: RawSettings["serverSettings"] = { ok: true, items: [{ serverRef: "s1", serverName: "app-1", frequency: "0 4 * * *", thresholdPct: 80, deleteVolumes: false, deleteNetworks: false, forceCleanup: false }] };
    const { svc, cleanup, prisma } = make(raw({ serverSettings: c }));
    expect((await svc.apply("u1", { sessionId: "sess", select: ["server:s1"] })).results[0]).toMatchObject({ status: "failed", code: "server_required" });
    prisma.server.findFirst.mockResolvedValueOnce(null);
    expect((await svc.apply("u1", { sessionId: "sess", select: ["server:s1"], serverMap: { s1: "elsewhere" } })).results[0]).toMatchObject({ code: "server_not_found" });
    expect(prisma.server.findFirst).toHaveBeenCalledWith({ where: { id: "elsewhere", teamId: "team-1" }, select: { id: true } });
    const ok = await svc.apply("u1", { sessionId: "sess", select: ["server:s1"], serverMap: { s1: "tugra-srv" } });
    expect(cleanup.setConfig).toHaveBeenCalledWith("u1", "tugra-srv", { enabled: true, cron: "0 4 * * *", thresholdPct: 80, volumes: false });
    expect(ok.results[0].status).toBe("created");
  });

  it("server settings: two source servers cannot be mapped onto the same Tugra server", async () => {
    const c: RawSettings["serverSettings"] = { ok: true, items: [
      { serverRef: "s1", serverName: "app-1", frequency: "0 4 * * *", deleteVolumes: false, deleteNetworks: false, forceCleanup: true },
      { serverRef: "s2", serverName: "app-2", frequency: "0 5 * * *", deleteVolumes: true, deleteNetworks: false, forceCleanup: true },
    ] };
    const { svc, cleanup } = make(raw({ serverSettings: c }));
    const out = await svc.apply("u1", { sessionId: "sess", select: ["server:s1", "server:s2"], serverMap: { s1: "tugra-srv", s2: "tugra-srv" } });
    expect(cleanup.setConfig).toHaveBeenCalledTimes(1);
    expect(out.results.map((r) => [r.status, r.code])).toEqual([["created", undefined], ["failed", "server_duplicate"]]);
  });

  it("tags: adds the tag to each imported resource that does not have it", async () => {
    const tg: RawSettings["tags"] = { ok: true, items: [{ name: "Prod", resources: [{ kind: "application", ref: "app-1", name: "web" }] }] };
    const { svc, apps } = make(raw({ tags: tg }));
    const out = await svc.apply("u1", { sessionId: "sess", opId: "op-1", select: ["tag:Prod"] });
    expect(apps.setTags).toHaveBeenCalledWith("u1", "tugra-app-1", ["x", "prod"]);
    expect(out.results[0].status).toBe("created");
  });

  it("members: no invitation without the explicit confirmation; role comes from the operator; an existing member is skipped", async () => {
    const m: RawSettings["members"] = { ok: true, items: [{ email: "new@example.com", name: "New" }] };
    const { svc, teams } = make(raw({ members: m }));
    const noConfirm = await svc.apply("u1", { sessionId: "sess", select: ["member:new@example.com"] });
    expect(noConfirm.results[0]).toMatchObject({ status: "failed", code: "confirmation_required" });
    expect(teams.invite).not.toHaveBeenCalled();
    await svc.apply("u1", { sessionId: "sess", select: ["member:new@example.com"], confirmInvites: true, memberRoles: { "member:new@example.com": "ADMIN" } });
    expect(teams.invite).toHaveBeenCalledWith("u1", "team-1", "new@example.com", "ADMIN");
    teams.invite.mockRejectedValue(new ConflictException("user is already a member"));
    const dup = await svc.apply("u1", { sessionId: "sess", select: ["member:new@example.com"], confirmInvites: true });
    expect(dup.results[0]).toMatchObject({ status: "skipped", code: "exists" });
  });

  it("audits the run with counts only", async () => {
    const m: RawSettings["members"] = { ok: true, items: [{ email: "new@example.com", name: "New" }] };
    const { svc, audit } = make(raw({ members: m }));
    await svc.apply("u1", { sessionId: "sess", select: ["member:new@example.com"], confirmInvites: true });
    expect(audit.log).toHaveBeenCalledWith({ actor: "u1", action: "import.settings.apply", target: "sess", meta: { created: 1, skipped: 0, failed: 0, bySection: { members: 1 } } });
  });
});
