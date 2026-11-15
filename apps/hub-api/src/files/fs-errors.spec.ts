import { FS_ERROR_CODES } from "@tugra/shared";
import { FsRemoteException, fsErrorStatus, sanitizeFsMessage } from "./fs-errors";

describe("fs-errors", () => {
  it("maps every closed agent code to the spec'd HTTP status", () => {
    const want: Record<string, number> = {
      not_found: 404, exists: 409, not_dir: 409, is_dir: 409, not_regular: 409, not_empty: 409, denied: 403,
      read_only: 409, no_space: 507, too_large: 413, changed: 412, integrity: 502, bad_request: 400, unsupported: 501,
      not_configured: 409, busy: 429, expired: 504, not_running: 409, no_binary: 409, failed: 502,
    };
    expect(Object.keys(want).sort()).toEqual([...FS_ERROR_CODES].sort()); // the table cannot drift from the closed set
    for (const [code, status] of Object.entries(want)) {
      expect(fsErrorStatus(code)).toBe(status);
      const e = new FsRemoteException(code, "m");
      expect(e.getStatus()).toBe(status);
      expect(e.getResponse()).toEqual({ statusCode: status, code, message: "m" });
    }
  });

  it("treats an unknown or missing code as 502 agent_error", () => {
    for (const c of ["weird", undefined, null, 5, "__proto__"]) {
      const e = new FsRemoteException(c, "boom");
      expect(e.getStatus()).toBe(502);
      expect((e.getResponse() as { code: string }).code).toBe("agent_error");
    }
  });

  it("strips control characters and caps the agent's message at 200 chars", () => {
    expect(sanitizeFsMessage("a\nb\u0000c\u001b[31m")).toBe("a b c [31m");
    expect(sanitizeFsMessage("x".repeat(500))).toHaveLength(200);
    expect(sanitizeFsMessage(undefined)).toBe("");
    expect(new FsRemoteException("failed", "").getResponse()).toMatchObject({ message: "file operation failed" });
  });
});
