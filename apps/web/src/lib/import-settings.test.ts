import { describe, it, expect } from "vitest";
import importNs from "../i18n/locales/en/import.json";
import { BLOCKED_KEY, NOTE_KEY, RESULT_CODE_KEY, buildApplyBody, initialSelection, missingInput, needsInviteConfirmation, readySelection, type SettingsEntry, type SettingsInputs, type SettingsPreview } from "./import-settings";

const lookup = (dotted: string): unknown => dotted.replace(/^import\./, "").split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), importNs);

const entry = (over: Partial<SettingsEntry> & Pick<SettingsEntry, "id" | "section">): SettingsEntry => ({ name: over.id, selectable: true, defaultSelected: false, notes: [], detail: {}, ...over });
const preview = (entries: SettingsEntry[]): SettingsPreview => ({ supported: true, sections: [{ section: "notifications", available: true, entries }] });
const inputs = (over: Partial<SettingsInputs> = {}): SettingsInputs => ({ selected: new Set(), s3: {}, servers: {}, roles: {}, confirmInvites: false, ...over });

describe("import settings helpers", () => {
  it("only selectable, default-flagged entries start ticked", () => {
    const p = preview([
      entry({ id: "a", section: "notifications", defaultSelected: true }),
      entry({ id: "b", section: "notifications", defaultSelected: true, selectable: false, blocked: "exists" }),
      entry({ id: "c", section: "notifications" }),
    ]);
    expect([...initialSelection(p)]).toEqual(["a"]);
  });

  it("a storage needs both keys, a server cleanup needs a server", () => {
    const st = entry({ id: "storage:s1", section: "storages", needs: ["s3Credentials"] });
    expect(missingInput(st, inputs())).toBe("s3Credentials");
    expect(missingInput(st, inputs({ s3: { "storage:s1": { accessKey: "AK", secretKey: " " } } }))).toBe("s3Credentials");
    expect(missingInput(st, inputs({ s3: { "storage:s1": { accessKey: "AK", secretKey: "SK" } } }))).toBeNull();
    const sv = entry({ id: "server:x", section: "serverSettings", needs: ["server"] });
    expect(missingInput(sv, inputs())).toBe("server");
    expect(missingInput(sv, inputs({ servers: { "server:x": "t1" } }))).toBeNull();
  });

  it("builds a body with only what the ticked, ready entries need (no keys of an unticked storage)", () => {
    const p = preview([
      entry({ id: "notification:telegram", section: "notifications" }),
      entry({ id: "storage:s1", section: "storages", needs: ["s3Credentials"] }),
      entry({ id: "storage:s2", section: "storages", needs: ["s3Credentials"] }),
      entry({ id: "server:srv-a", section: "serverSettings", needs: ["server"] }),
      entry({ id: "member:a@example.com", section: "members", needs: ["role"], detail: { suggestedRole: "ADMIN" } }),
      entry({ id: "member:b@example.com", section: "members", needs: ["role"], detail: { suggestedRole: "VIEWER" } }),
    ]);
    const inp = inputs({
      selected: new Set(["notification:telegram", "storage:s1", "server:srv-a", "member:a@example.com", "member:b@example.com"]),
      s3: { "storage:s1": { accessKey: " AK ", secretKey: "SK" }, "storage:s2": { accessKey: "LEAK", secretKey: "LEAK" } },
      servers: { "server:srv-a": "tugra-1" },
      roles: { "member:b@example.com": "ADMIN" },
      confirmInvites: true,
    });
    const body = buildApplyBody(p, inp, { sessionId: "sess", sourceKind: "coolify", opId: "op-1" });
    expect(body).toEqual({
      sessionId: "sess",
      sourceKind: "coolify",
      opId: "op-1",
      select: ["notification:telegram", "storage:s1", "server:srv-a", "member:a@example.com", "member:b@example.com"],
      serverMap: { "srv-a": "tugra-1" },
      s3Credentials: { "storage:s1": { accessKey: "AK", secretKey: "SK" } },
      memberRoles: { "member:a@example.com": "ADMIN", "member:b@example.com": "ADMIN" },
      confirmInvites: true,
    });
    expect(JSON.stringify(body)).not.toContain("LEAK");
  });

  it("an entry that still lacks input is left out of the request", () => {
    const p = preview([entry({ id: "storage:s1", section: "storages", needs: ["s3Credentials"] }), entry({ id: "a", section: "notifications" })]);
    const inp = inputs({ selected: new Set(["storage:s1", "a"]) });
    expect(readySelection(p, inp).map((e) => e.id)).toEqual(["a"]);
    expect(buildApplyBody(p, inp, { sessionId: "s", sourceKind: "coolify" }).select).toEqual(["a"]);
  });

  it("invitations need the confirmation whenever a member is ticked", () => {
    const p = preview([entry({ id: "member:a@example.com", section: "members" })]);
    expect(needsInviteConfirmation(p, inputs())).toBe(false);
    expect(needsInviteConfirmation(p, inputs({ selected: new Set(["member:a@example.com"]) }))).toBe(true);
  });

  it("every code the hub sends has an English string", () => {
    for (const map of [BLOCKED_KEY, NOTE_KEY, RESULT_CODE_KEY]) for (const [code, key] of Object.entries(map)) expect(typeof lookup(key), `${code} -> ${key}`).toBe("string");
  });
});
