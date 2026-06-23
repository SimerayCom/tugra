import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_LOG_CHARS = 12_000; // send the tail — failures surface at the end

export interface AnalyzeContext {
  appName: string;
  status: string;
  exitCode: number | null;
}

/**
 * Opt-in AI assistance: sends a failed deployment's logs to Anthropic and
 * returns a plain-language diagnosis. Disabled (503) unless the instance admin
 * has set ANTHROPIC_API_KEY — logs only leave the box on explicit request.
 */
@Injectable()
export class AiService {
  constructor(private readonly config: ConfigService) {}

  configured(): boolean {
    return !!this.config.get<string>("ANTHROPIC_API_KEY");
  }

  async analyze(logs: string, ctx: AnalyzeContext): Promise<string> {
    const key = this.config.get<string>("ANTHROPIC_API_KEY");
    if (!key) throw new ServiceUnavailableException("AI analysis is not configured");
    const model = this.config.get<string>("ANTHROPIC_MODEL") || DEFAULT_MODEL;

    const tail = logs.length > MAX_LOG_CHARS ? logs.slice(-MAX_LOG_CHARS) : logs;
    const prompt =
      `You are a DevOps assistant. A container deployment for "${ctx.appName}" ` +
      `failed (status ${ctx.status}, exit code ${ctx.exitCode ?? "unknown"}). ` +
      `Analyze the build/run log below and respond concisely in markdown with: ` +
      `**Likely root cause** and **Concrete fix steps**.\n\n` +
      "```\n" + tail + "\n```";

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API: HTTP ${res.status}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? "";
  }
}
