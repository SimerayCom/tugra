import { describe, it, expect, beforeEach } from "vitest";
import { clearImportResume, IMPORT_RESUME_KEY, loadImportResume, saveImportResume } from "./import-resume";

const store = (): Storage => window.sessionStorage;
const SID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

beforeEach(() => store().clear());

describe("import resume", () => {
  it("keeps the session, the address, the selection and the copy modes, and reads them back", () => {
    saveImportResume({ kind: "coolify", baseUrl: "https://coolify.example.com", sessionId: SID, selection: { mode: "servers", hosts: new Set(["s1"]), projects: new Set(), extra: new Set(), placement: { s1: "t1" }, teamId: "team1" }, dbModes: { "database:s1:db": "volume" } });
    const r = loadImportResume()!;
    expect(r).toMatchObject({ kind: "coolify", baseUrl: "https://coolify.example.com", sessionId: SID, dbModes: { "database:s1:db": "volume" } });
    expect([...r.selection!.hosts]).toEqual(["s1"]);
    expect(r.selection!.placement).toEqual({ s1: "t1" });
  });

  it("never stores a token, and drops an address that carries credentials", () => {
    saveImportResume({ kind: "dokploy", baseUrl: "https://user:secret@dokploy.example.com", sessionId: SID, dbModes: {} });
    const raw = store().getItem(IMPORT_RESUME_KEY)!;
    expect(raw).not.toContain("secret");
    expect(loadImportResume()!.baseUrl).toBe("");
  });

  it("does not store a session id that is not an id", () => {
    saveImportResume({ kind: "coolify", baseUrl: "", sessionId: "x y", dbModes: {} });
    expect(store().getItem(IMPORT_RESUME_KEY)).toBeNull();
  });

  it("reads nothing from a value that is not ours, and clear removes it", () => {
    store().setItem(IMPORT_RESUME_KEY, "{not json");
    expect(loadImportResume()).toBeNull();
    store().setItem(IMPORT_RESUME_KEY, JSON.stringify({ v: 1, kind: "other", sessionId: SID }));
    expect(loadImportResume()).toBeNull();
    saveImportResume({ kind: "coolify", baseUrl: "", sessionId: SID, dbModes: {} });
    clearImportResume();
    expect(loadImportResume()).toBeNull();
  });

  it("keeps whether every Coolify team is shown and whether the match step was finished", () => {
    saveImportResume({ kind: "coolify", baseUrl: "", sessionId: SID, dbModes: {}, allTeams: true, matched: true });
    expect(loadImportResume()).toMatchObject({ allTeams: true, matched: true });
    saveImportResume({ kind: "coolify", baseUrl: "", sessionId: SID, dbModes: {} });
    const r = loadImportResume()!;
    expect(r.allTeams).toBeUndefined();
    expect(r.matched).toBeUndefined();
  });
});
