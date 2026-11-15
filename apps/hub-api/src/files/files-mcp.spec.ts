import { MCP_TOOLS } from "../mcp/mcp-tools";

describe("MCP surface for files", () => {
  it("stays read-only: list_files only, no write/upload/delete/container-FS tool", () => {
    const fileish = MCP_TOOLS.map((t) => t.name).filter((n) => /file|upload|download|mkdir|rename|chmod|container_fs/i.test(n));
    expect(fileish).toEqual(["list_files"]);
    expect(MCP_TOOLS.find((t) => t.name === "list_files")!.scope).toBe("read:secrets");
  });
});
