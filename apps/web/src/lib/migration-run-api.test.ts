import { describe, it, expect, afterEach, vi } from "vitest";
import { api, migrationRunReportMdUrl } from "./api";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every guided-run call goes to the hub route the contract defines, with the right verb and body. */
describe("migration run api client", () => {
  afterEach(() => vi.unstubAllGlobals());
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const stub = () => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonRes(200, {});
      }),
    );
  };

  it("lists with filters and reads one run, its events and its report", async () => {
    stub();
    await api.listMigrationRuns();
    await api.listMigrationRuns({ teamId: "t1", status: "WAITING", active: true, limit: 20 });
    await api.getMigrationRun("r/1");
    await api.getMigrationRunEvents("r1", 7);
    await api.getMigrationRunReport("r1");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/v1/migration-runs"],
      ["GET", "/api/v1/migration-runs?teamId=t1&status=WAITING&active=true&limit=20"],
      ["GET", "/api/v1/migration-runs/r%2F1"],
      ["GET", "/api/v1/migration-runs/r1/events?afterSeq=7&limit=200"],
      ["GET", "/api/v1/migration-runs/r1/report"],
    ]);
    expect(migrationRunReportMdUrl("r1")).toBe("/api/v1/migration-runs/r1/report?format=md");
  });

  it("posts create, start, approve, retry, skip, evidence, attach and command to the step routes", async () => {
    stub();
    await api.createMigrationRun({ sessionId: "s", sourceKind: "coolify", targetServerId: "srv", planHash: "a".repeat(32), dryRun: true });
    await api.startMigrationRun("r1");
    await api.approveMigrationRunStep("r1", "VERIFY", { boundHash: "b".repeat(64), acks: ["x"], confirmName: "srv" });
    await api.retryMigrationRunStep("r1", "IMPORT");
    await api.skipMigrationRunStep("r1", "DATA_SEED", { reason: "later" });
    await api.attestMigrationRunStep("r1", "FREEZE", { checkId: "frozen", note: "done" });
    await api.attachMigrationRunStep("r1", "DATA_SEED", { kind: "object-migration", resourceId: "om1" });
    await api.migrationRunCommand("r1", "DATA_FINAL", { reissue: true });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "/api/v1/migration-runs"],
      ["POST", "/api/v1/migration-runs/r1/start"],
      ["POST", "/api/v1/migration-runs/r1/steps/VERIFY/approve"],
      ["POST", "/api/v1/migration-runs/r1/steps/IMPORT/retry"],
      ["POST", "/api/v1/migration-runs/r1/steps/DATA_SEED/skip"],
      ["POST", "/api/v1/migration-runs/r1/steps/FREEZE/evidence"],
      ["POST", "/api/v1/migration-runs/r1/steps/DATA_SEED/attach"],
      ["POST", "/api/v1/migration-runs/r1/steps/DATA_FINAL/command"],
    ]);
    expect(calls[2].body).toEqual({ boundHash: "b".repeat(64), acks: ["x"], confirmName: "srv" });
    expect(calls[3].body).toEqual({});
    expect(calls[7].body).toEqual({ reissue: true });
  });

  it("posts the run-level actions with their typed confirmations", async () => {
    stub();
    await api.setMigrationRunInputs("r1", { acmeEmail: "ops@example.org" });
    await api.pauseMigrationRun("r1");
    await api.resumeMigrationRun("r1");
    await api.abortMigrationRun("r1", { confirmName: "r1" });
    await api.cleanupMigrationRun("r1", { confirmName: "r1", includeData: true, dataConfirmNames: ["db"] });
    await api.reverseMigrationRun("r1", { confirmName: "r1", acknowledgeDataLoss: true });
    await api.decommissionMigrationRun("r1", { confirmName: "coolify.example.org" });
    await api.migrationRunSourceSession("r1", { token: "t" });
    await api.migrationRunSourceSession("r1", { agent: true });
    expect(calls.map((c) => c.url.replace("/api/v1/migration-runs/r1", ""))).toEqual(["/inputs", "/pause", "/resume", "/abort", "/cleanup", "/reverse", "/decommission", "/source-session", "/source-session"]);
    expect(calls[8].body).toEqual({ agent: true });
    expect(calls[4].body).toEqual({ confirmName: "r1", includeData: true, dataConfirmNames: ["db"] });
    expect(calls[5].body).toEqual({ confirmName: "r1", acknowledgeDataLoss: true });
  });
});
