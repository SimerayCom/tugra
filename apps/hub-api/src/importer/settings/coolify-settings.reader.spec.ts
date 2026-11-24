import type { CoolifyClient } from "../sources/coolify.source";
import { failureReason, readCoolifySettings } from "./coolify-settings.reader";
import { CoolifySource } from "../sources/coolify.source";

class FakeClient implements CoolifyClient {
  calls: string[] = [];
  constructor(private routes: Record<string, unknown>) {}
  async get<T>(path: string): Promise<T> {
    this.calls.push(path);
    if (!(path in this.routes)) throw new Error(`Coolify API error 404 ${path}`);
    const v = this.routes[path];
    if (v instanceof Error) throw v;
    return v as T;
  }
}

describe("failureReason", () => {
  it("classifies the HTTP status in the client's error", () => {
    expect(failureReason(new Error("Coolify API error 404: not found"))).toBe("not_exposed");
    expect(failureReason(new Error("Coolify API error 403 (token valid but not authorized)"))).toBe("forbidden");
    expect(failureReason(new Error("socket hang up"))).toBe("error");
  });
});

describe("readCoolifySettings", () => {
  it("reports every section as not exposed on a Coolify without those endpoints (no guessing)", async () => {
    const raw = await readCoolifySettings(new FakeClient({ "/servers": [], "/applications": [], "/services": [] }));
    expect(raw.notifications).toEqual({ ok: false, reason: "not_exposed" });
    expect(raw.sharedVariables).toEqual({ ok: false, reason: "not_exposed" });
    expect(raw.storages).toEqual({ ok: false, reason: "not_exposed" });
    expect(raw.tags).toEqual({ ok: false, reason: "not_exposed" });
    expect(raw.members).toEqual({ ok: false, reason: "not_exposed" });
    // empty fleets have nothing to ask a task / cleanup question of: readable and empty
    expect(raw.scheduledTasks).toEqual({ ok: true, items: [] });
    expect(raw.serverSettings).toEqual({ ok: true, items: [] });
  });

  it("reads each section from its endpoint", async () => {
    const client = new FakeClient({
      "/notifications/telegram": { telegram_enabled: true, telegram_token: "t", telegram_chat_id: "1", telegram_notifications_deployment_failure: true, telegram_notifications_deployment_failure_thread_id: "7" },
      "/notifications/discord": new Error("Coolify API error 403"),
      "/team/envs": [{ key: "TEAM_VAR", value: "1" }],
      "/projects": [{ uuid: "p1", name: "Acme" }],
      "/projects/p1": { uuid: "p1", name: "Acme", environments: [{ id: 1, name: "production" }] },
      "/projects/p1/envs": [{ key: "PROJ_VAR", value: "2" }],
      "/projects/p1/environments/production/envs": [{ key: "ENV_VAR", value: "3" }],
      "/s3-storages": [{ uuid: "s1", name: "Backups", type: "s3", endpoint: "https://s3.example.com", bucket: "acme", region: "eu-1" }],
      "/applications": [{ uuid: "a1", name: "web" }, { uuid: "a2", name: "worker" }],
      "/services": [{ uuid: "sv1", name: "stack" }],
      "/databases": [{ uuid: "d1", name: "db" }],
      "/applications/a1/scheduled-tasks": [{ uuid: "t1", name: "Nightly", command: "run", frequency: "daily" }],
      "/applications/a2/scheduled-tasks": [],
      "/services/sv1/scheduled-tasks": new Error("Coolify API error 500"),
      "/servers": [{ uuid: "srv1", name: "app-1" }],
      "/servers/srv1/docker-cleanup": { docker_cleanup_frequency: "0 3 * * *", docker_cleanup_threshold: 70 },
      "/tags": [{ uuid: "g1", name: "prod" }],
      "/applications/a1/tags": [{ name: "prod" }],
      "/applications/a2/tags": [],
      "/databases/d1/tags": [{ name: "prod" }],
      "/services/sv1/tags": [],
      "/team/members": [{ email: "A@example.com", name: "Ann" }],
    });
    const raw = await new CoolifySource(client).readSettings();
    expect(raw.notifications).toMatchObject({ ok: true, partial: true });
    expect(raw.notifications.ok && raw.notifications.items.map((c) => c.kind)).toEqual(["telegram"]);
    expect(raw.sharedVariables.ok && raw.sharedVariables.items.map((v) => [v.scope, v.key, v.environmentName ?? null])).toEqual([
      ["team", "TEAM_VAR", null],
      ["project", "PROJ_VAR", null],
      ["environment", "ENV_VAR", "production"],
    ]);
    expect(raw.storages.ok && raw.storages.items[0]).toMatchObject({ ref: "s1", bucket: "acme" });
    expect(raw.scheduledTasks).toMatchObject({ ok: true, partial: true });
    expect(raw.scheduledTasks.ok && raw.scheduledTasks.items).toHaveLength(1);
    expect(raw.serverSettings.ok && raw.serverSettings.items[0]).toMatchObject({ serverRef: "srv1", thresholdPct: 70 });
    expect(raw.tags.ok && raw.tags.items).toEqual([{ name: "prod", resources: [{ kind: "application", ref: "a1", name: "web" }, { kind: "database", ref: "d1", name: "db" }] }]);
    expect(raw.members.ok && raw.members.items).toEqual([{ email: "a@example.com", name: "Ann" }]);
  });

  it("a refused token is forbidden, not 'not exposed'", async () => {
    const raw = await readCoolifySettings(new FakeClient({ "/team/members": new Error("Coolify API error 403"), "/s3-storages": new Error("Coolify API error 403"), "/applications": [], "/services": [], "/servers": [] }));
    expect(raw.members).toEqual({ ok: false, reason: "forbidden" });
    expect(raw.storages).toEqual({ ok: false, reason: "forbidden" });
  });

  it("only reads the per-resource tags when the team has tags", async () => {
    const client = new FakeClient({ "/tags": [], "/applications": [{ uuid: "a1" }], "/services": [], "/databases": [], "/servers": [] });
    await readCoolifySettings(client);
    expect(client.calls.some((c) => c.endsWith("/tags") && c !== "/tags")).toBe(false);
  });

  it("reads only the requested sections", async () => {
    const client = new FakeClient({ "/team/members": [{ email: "a@example.com", name: "Ann" }] });
    const raw = await readCoolifySettings(client, new Set(["members"]));
    expect(client.calls).toEqual(["/team/members"]);
    expect(raw.members.ok).toBe(true);
    expect(raw.notifications).toEqual({ ok: false, reason: "not_exposed" });
  });
});
