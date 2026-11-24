import { describe, it, expect } from "vitest";
import { claudeMcpAddCommand, mcpUrl } from "./mcp-command";

describe("mcp command", () => {
  it("points at the hub's POST /api/v1/mcp endpoint, ignoring trailing slashes", () => {
    expect(mcpUrl("https://hub.example.com/")).toBe("https://hub.example.com/api/v1/mcp");
    expect(mcpUrl("http://203.0.113.7:3000")).toBe("http://203.0.113.7:3000/api/v1/mcp");
  });

  it("builds the exact `claude mcp add` command with the Bearer header", () => {
    expect(claudeMcpAddCommand("https://hub.example.com", "tugra_pat_AbC-_9")).toBe(
      'claude mcp add --transport http tugra https://hub.example.com/api/v1/mcp --header "Authorization: Bearer tugra_pat_AbC-_9"',
    );
  });
});
