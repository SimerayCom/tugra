import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine } from "../output";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function register(program: Command): void {
  program
    .command("api <method> <path>")
    .description("Make a raw authenticated request to any API endpoint (e.g. `tugra api GET /apps`). The full REST API.")
    .option("--data <json>", "JSON request body (POST/PUT/PATCH only)")
    .option("--json", "output as JSON (the default for this command)")
    .action(async (method: string, path: string, opts: { data?: string }) => {
      const m = method.toUpperCase();
      if (!METHODS.has(m)) throw new Error(`unsupported method: ${method} (use GET, POST, PUT, PATCH or DELETE)`);
      let body: unknown;
      if (opts.data !== undefined) {
        if (m === "GET" || m === "DELETE") throw new Error(`--data is not sent with a ${m} request`);
        try {
          body = JSON.parse(opts.data);
        } catch {
          throw new Error("--data must be valid JSON");
        }
      }
      const res = await activeClient().client.requestRaw(m, path, body);
      if (res === undefined) printLine("ok"); // 204 / empty response
      else printJson(res);
    });
}
