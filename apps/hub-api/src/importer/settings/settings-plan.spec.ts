import { buildSettingsPlan, destinationKey, taskKey } from "./settings-plan";
import type { RawSettings, TargetContext } from "./settings-types";

const SECRETS = ["bot-token-1", "-100123", "https://hooks.example.com/secret-path", "super-secret-value", "rm -rf /secret-command"];

const unavailable = { ok: false, reason: "not_exposed" } as const;
const baseRaw = (over: Partial<RawSettings> = {}): RawSettings => ({
  notifications: unavailable,
  sharedVariables: unavailable,
  storages: unavailable,
  scheduledTasks: unavailable,
  serverSettings: unavailable,
  tags: unavailable,
  members: unavailable,
  ...over,
});
const ctx = (over: Partial<TargetContext> = {}): TargetContext => ({
  channelNames: new Set(),
  sharedVarKeys: new Set(),
  destinationKeys: new Set(),
  memberEmails: new Set(),
  pendingInviteEmails: new Set(),
  actorEmail: "me@example.com",
  imported: new Map(),
  hasOperation: false,
  taskKeys: new Set(),
  ...over,
});
const find = (plan: ReturnType<typeof buildSettingsPlan>, id: string) => plan.sections.flatMap((s) => s.entries).find((e) => e.id === id)!;

describe("buildSettingsPlan", () => {
  it("marks every section unavailable (with the reason) and offers nothing when the API has none of it", () => {
    const plan = buildSettingsPlan(baseRaw(), ctx());
    expect(plan.sections).toHaveLength(7);
    expect(plan.sections.every((s) => !s.available && s.reason === "not_exposed" && s.entries.length === 0)).toBe(true);
    expect(plan.planned.size).toBe(0);
  });

  it("notifications: topics split into channels, unmapped events noted, preview is secret-free", () => {
    const plan = buildSettingsPlan(
      baseRaw({
        notifications: {
          ok: true,
          items: [
            {
              kind: "telegram",
              enabled: true,
              secretsReadable: true,
              providerType: "telegram",
              config: { botToken: "bot-token-1", chatId: "-100123" },
              events: [{ event: "deployment_success", threadId: "5" }, { event: "deployment_failure", threadId: "6" }, { event: "server_patch", threadId: "7" }],
            },
            { kind: "discord", enabled: true, secretsReadable: false, providerType: "discord", config: {}, events: [] },
            { kind: "email", enabled: true, secretsReadable: false, instanceEmail: true, providerType: "smtp", config: {}, events: [] },
          ],
        },
      }),
      ctx(),
    );
    const tg = find(plan, "notification:telegram");
    expect(tg).toMatchObject({ selectable: true, defaultSelected: true });
    expect((tg.detail.groups as unknown[]).length).toBe(2);
    expect(tg.notes.map((n) => n.code)).toEqual(expect.arrayContaining(["events_not_carried", "topics_split", "double_send"]));
    expect(find(plan, "notification:discord")).toMatchObject({ selectable: false, blocked: "needs_sensitive" });
    expect(find(plan, "notification:email")).toMatchObject({ selectable: false, blocked: "email_instance_settings" });
    expect(plan.planned.has("notification:discord")).toBe(false);
    const json = JSON.stringify(plan.sections);
    for (const s of SECRETS) expect(json).not.toContain(s);
  });

  it("notifications: already in Tugra when every target channel name exists", () => {
    const raw = baseRaw({ notifications: { ok: true, items: [{ kind: "slack", enabled: true, secretsReadable: true, providerType: "slack", config: { webhookUrl: "https://hooks.example.com/secret-path" }, events: [{ event: "deployment_success" }] }] } });
    const plan = buildSettingsPlan(raw, ctx({ channelNames: new Set(["Slack (Coolify)"]) }));
    expect(find(plan, "notification:slack")).toMatchObject({ selectable: false, blocked: "exists" });
  });

  it("shared variables: never preselected, blocked when locked / unreadable / invalid / existing / duplicate", () => {
    const v = (key: string, value: string | undefined, over = {}) => ({ scope: "team" as const, key, value, locked: false, ...over });
    const plan = buildSettingsPlan(
      baseRaw({
        sharedVariables: {
          ok: true,
          items: [
            v("OK_KEY", "super-secret-value"),
            v("LOCKED", "x", { locked: true }),
            v("NO_VALUE", undefined),
            v("bad key", "x"),
            v("MULTI", "a\nb"),
            v("HAS", "x"),
            { scope: "project", projectRef: "p1", projectName: "Acme", key: "OK_KEY", value: "other", locked: false },
          ],
        },
      }),
      ctx({ sharedVarKeys: new Set(["HAS"]) }),
    );
    const ids = plan.sections[1].entries.map((e) => [e.name, e.blocked ?? "ok"]);
    expect(ids).toEqual([["OK_KEY", "ok"], ["LOCKED", "locked"], ["NO_VALUE", "needs_sensitive"], ["bad key", "invalid_key"], ["MULTI", "multiline"], ["HAS", "exists"], ["OK_KEY", "duplicate_key"]]);
    expect(plan.sections[1].entries.every((e) => !e.defaultSelected)).toBe(true);
    expect(plan.sections[1].entries[0].notes[0].code).toBe("team_wide");
    expect(JSON.stringify(plan.sections)).not.toContain("super-secret-value");
  });

  it("storages: S3 only, bucket/endpoint validated, credentials requested, existing destination recognised", () => {
    const s = (ref: string, over = {}) => ({ ref, name: ref, type: "s3", endpoint: "https://s3.example.com", bucket: "acme", region: "eu-1", skipTlsVerification: false, ...over });
    const plan = buildSettingsPlan(baseRaw({ storages: { ok: true, items: [s("a"), s("b", { type: "sftp" }), s("c", { bucket: "bad bucket!" }), s("d", { endpoint: "" }), s("e", { bucket: "taken" })] } }), ctx({ destinationKeys: new Set([destinationKey("https://S3.example.com/", "taken")]) }));
    expect(plan.sections[2].entries.map((e) => e.blocked ?? "ok")).toEqual(["ok", "unsupported_type", "invalid_bucket", "no_endpoint", "exists"]);
    expect(find(plan, "storage:a").needs).toEqual(["s3Credentials"]);
    expect(find(plan, "storage:a").notes.map((n) => n.code)).toContain("credentials_not_exposed");
  });

  it("scheduled tasks: need an import operation, the imported app, and a valid schedule; the command is never shown", () => {
    const t = (ref: string, over = {}) => ({ resourceKind: "application" as const, resourceRef: "app-1", resourceName: "web", ref, name: ref, command: "rm -rf /secret-command", frequency: "daily", enabled: true, ...over });
    const raw = baseRaw({ scheduledTasks: { ok: true, items: [t("a"), t("b", { frequency: "whenever" }), t("c", { resourceRef: "app-9" }), t("d", { container: "web" })] } });
    expect(buildSettingsPlan(raw, ctx()).sections[3].entries.every((e) => e.blocked === "needs_import")).toBe(true);
    const plan = buildSettingsPlan(raw, ctx({ hasOperation: true, imported: new Map([["app-1", { kind: "application", id: "tugra-app-1" }]]), taskKeys: new Set([taskKey("tugra-app-1", "d", "rm -rf /secret-command")]) }));
    expect(plan.sections[3].entries.map((e) => e.blocked ?? "ok")).toEqual(["ok", "invalid_schedule", "app_not_imported", "exists"]);
    expect(plan.planned.get("task:app-1:a")).toMatchObject({ section: "scheduledTasks", appId: "tugra-app-1", cron: "0 0 * * *" });
    expect(JSON.stringify(plan.sections)).not.toContain("secret-command");
  });

  it("server settings: carries the cleanup schedule, needs a target server, warns about volumes", () => {
    const plan = buildSettingsPlan(baseRaw({ serverSettings: { ok: true, items: [{ serverRef: "s1", serverName: "app-1", frequency: "0 4 * * *", thresholdPct: 80, deleteVolumes: true, deleteNetworks: false, forceCleanup: false }, { serverRef: "s2", serverName: "app-2", frequency: "nonsense", deleteVolumes: false, deleteNetworks: false, forceCleanup: true }] } }), ctx());
    expect(find(plan, "server:s1")).toMatchObject({ selectable: true, needs: ["server"], detail: { schedule: "0 4 * * *", thresholdPct: 80, volumes: true } });
    expect(find(plan, "server:s1").notes.map((n) => n.code)).toEqual(expect.arrayContaining(["volumes_pruned", "cleanup_always"]));
    expect(find(plan, "server:s2")).toMatchObject({ selectable: false, blocked: "invalid_schedule" });
  });

  it("tags: only tags that reach an imported resource are offered", () => {
    const raw = baseRaw({ tags: { ok: true, items: [{ name: "Prod Env", resources: [{ kind: "application", ref: "app-1", name: "web" }, { kind: "database", ref: "db-9", name: "x" }] }, { name: "lonely", resources: [{ kind: "application", ref: "app-7", name: "y" }] }] } });
    expect(buildSettingsPlan(raw, ctx()).sections[5].entries.every((e) => e.blocked === "needs_import")).toBe(true);
    const plan = buildSettingsPlan(raw, ctx({ hasOperation: true, imported: new Map([["app-1", { kind: "application", id: "A" }]]) }));
    expect(find(plan, "tag:Prod Env")).toMatchObject({ selectable: true, detail: { resources: 2, imported: 1 } });
    expect(find(plan, "tag:Prod Env").notes[0]).toMatchObject({ code: "tag_normalized", params: { as: "prod-env" } });
    expect(find(plan, "tag:lonely")).toMatchObject({ selectable: false, blocked: "no_imported_resources" });
  });

  it("members: never preselected, skip self and existing members, flag owners", () => {
    const plan = buildSettingsPlan(baseRaw({ members: { ok: true, items: [{ email: "me@example.com", name: "Me" }, { email: "in@example.com", name: "In" }, { email: "new@example.com", name: "New", role: "owner" }, { email: "p@example.com", name: "P" }] } }), ctx({ memberEmails: new Set(["in@example.com"]), pendingInviteEmails: new Set(["p@example.com"]) }));
    expect(plan.sections[6].entries.map((e) => e.blocked ?? "ok")).toEqual(["self", "exists", "ok", "ok"]);
    expect(plan.sections[6].entries.every((e) => !e.defaultSelected)).toBe(true);
    expect(find(plan, "member:new@example.com")).toMatchObject({ needs: ["role"], detail: { suggestedRole: "ADMIN" } });
    expect(find(plan, "member:new@example.com").notes.map((n) => n.code)).toContain("owner_not_carried");
    expect(find(plan, "member:p@example.com").notes.map((n) => n.code)).toContain("invite_pending");
  });

  it("keeps the partial flag of a section that was only partly readable", () => {
    const plan = buildSettingsPlan(baseRaw({ tags: { ok: true, items: [], partial: true } }), ctx());
    expect(plan.sections[5]).toMatchObject({ available: true, partial: true });
  });
});
