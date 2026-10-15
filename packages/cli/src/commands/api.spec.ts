import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { register } from "./api";
import { setProfile } from "../config";

let dir: string;
let out: string[];
const origFetch = globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugra-cli-"));
  process.env.XDG_CONFIG_HOME = dir;
  setProfile("default", { hub: "https://h", token: "tugra_pat_x" });
  out = [];
  jest.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  globalThis.fetch = origFetch;
  jest.restoreAllMocks();
});

function run(args: string[]) {
  const p = new Command();
  register(p);
  return p.parseAsync(["node", "tugra", ...args]);
}

function stub(status: number, body: unknown): jest.Mock {
  const fn = jest.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("tugra api passthrough", () => {
  it("GET hits the path and prints the JSON response", async () => {
    const fetchMock = stub(200, [{ id: "a1" }]);
    await run(["api", "GET", "/apps"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://h/api/v1/apps");
    expect(out.join("")).toContain("a1");
  });

  it("POST --data sends the JSON body", async () => {
    const fetchMock = stub(201, { id: "a1" });
    await run(["api", "POST", "/apps", "--data", '{"name":"web"}']);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[0][1].body).toBe('{"name":"web"}');
  });

  it("prints 'ok' for an empty response body", async () => {
    globalThis.fetch = jest.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    await run(["api", "DELETE", "/api-tokens/t1"]);
    expect(out.join("")).toContain("ok");
  });

  it("rejects an unsupported method", async () => {
    await expect(run(["api", "FETCH", "/apps"])).rejects.toThrow(/unsupported method/);
  });

  it("rejects --data on a GET, and invalid JSON", async () => {
    await expect(run(["api", "GET", "/apps", "--data", "{}"])).rejects.toThrow(/not sent with a GET/);
    await expect(run(["api", "POST", "/apps", "--data", "{bad"])).rejects.toThrow(/valid JSON/);
  });
});
