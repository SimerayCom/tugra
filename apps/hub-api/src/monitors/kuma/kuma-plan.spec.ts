import { BACKUP } from "./kuma-fixture";
import { parseKumaBackup } from "./kuma-model";
import { buildPlan, redactTarget } from "./kuma-plan";

const dump = () => parseKumaBackup(JSON.stringify(BACKUP));

describe("buildPlan", () => {
  it("separates importable, unsupported and group monitors and totals them", () => {
    const { view } = buildPlan(dump(), [], []);
    const by = (id: string) => view.monitors.find((m) => m.ref === id)!;
    expect(by("10")).toMatchObject({ action: "create", type: "HTTP", target: "https://example.com" });
    expect(by("16")).toMatchObject({ action: "unsupported", reason: "type", kumaType: "docker" });
    expect(by("17")).toMatchObject({ action: "group" });
    expect(by("19")).toMatchObject({ action: "unsupported", reason: "target" });
    expect(view.totals).toEqual({ monitors: 13, create: 8, exists: 0, unsupported: 5, channelsToCreate: 3 });
  });

  it("marks a monitor that already exists in the team, and one repeated inside the backup", () => {
    const twice = dump();
    twice.monitors.push({ ...twice.monitors[0], id: "99" });
    const { view } = buildPlan(twice, [{ name: "Postgres", type: "TCP", target: "DB.example.com:5432" }], []);
    expect(view.monitors.find((m) => m.ref === "13")!.action).toBe("exists");
    expect(view.monitors.find((m) => m.ref === "99")!.action).toBe("exists");
    expect(view.monitors.find((m) => m.ref === "10")!.action).toBe("create");
  });

  it("reuses a channel of the same type and name, creates the rest, and counts usage by importable monitors only", () => {
    const { view, channels } = buildPlan(dump(), [], [{ id: "c1", name: "ops chat", type: "telegram" }]);
    const ch = (ref: string) => view.channels.find((c) => c.ref === ref)!;
    expect(ch("1")).toMatchObject({ action: "reuse", existingId: "c1", usedBy: 2 });
    expect(ch("2")).toMatchObject({ action: "create", type: "webhook", usedBy: 1 });
    expect(ch("3")).toMatchObject({ action: "unsupported", reason: "type" });
    expect(ch("5")).toMatchObject({ action: "unsupported", reason: "incomplete" });
    expect([...channels.keys()].sort()).toEqual(["2", "4"]); // only the ones apply would create
  });

  it("never puts a secret in the preview", () => {
    const text = JSON.stringify(buildPlan(dump(), [], []).view);
    for (const secret of ["s3cr3t", "123:abc", "hooks.example.com", "svc", "pw", "smtp.example.com", "Bearer"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("shows targets without embedded credentials", () => {
    expect(redactTarget("https://user:pass@example.com/path")).toBe("https://example.com/path");
    expect(redactTarget("https://example.com")).toBe("https://example.com");
    expect(redactTarget("db.example.com:5432")).toBe("db.example.com:5432");
  });
});
