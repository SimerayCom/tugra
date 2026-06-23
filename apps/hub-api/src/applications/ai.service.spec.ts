import { ServiceUnavailableException } from "@nestjs/common";
import { AiService } from "./ai.service";
import { ConfigService } from "@nestjs/config";

function make(values: Record<string, string | undefined>) {
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new AiService(config);
}

const ctx = { appName: "web", status: "FAILED", exitCode: 1 };

describe("AiService", () => {
  it("is not configured without an API key", () => {
    expect(make({}).configured()).toBe(false);
    expect(make({ ANTHROPIC_API_KEY: "sk" }).configured()).toBe(true);
  });

  it("throws 503 when analyze is called unconfigured", async () => {
    await expect(make({}).analyze("logs", ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("calls the Anthropic API with auth headers + model and returns the text", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ content: [{ text: "Root cause: OOM" }] }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const out = await make({ ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_MODEL: "claude-sonnet-4-6" }).analyze("boom: exit 1", ctx);
    expect(out).toBe("Root cause: OOM");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-x");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(init.body).toContain("claude-sonnet-4-6");
    expect(init.body).toContain("boom: exit 1");
  });

  it("truncates very long logs to the tail", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ content: [{ text: "ok" }] }) });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const huge = "A".repeat(20000) + "TAIL_MARKER_AT_END";
    await make({ ANTHROPIC_API_KEY: "sk" }).analyze(huge, ctx);
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).toContain("TAIL_MARKER_AT_END");
    expect(body).not.toContain("A".repeat(13000));
    expect(body.length).toBeLessThan(huge.length);
  });

  it("throws on a non-OK API response", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    await expect(make({ ANTHROPIC_API_KEY: "sk" }).analyze("x", ctx)).rejects.toThrow(/429/);
  });
});
