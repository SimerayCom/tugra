import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { register } from "./version";
import { setProfile } from "../config";

let dir: string;
let out: string[];
let err: string[];
const origFetch = globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tugra-cli-"));
  process.env.XDG_CONFIG_HOME = dir;
  setProfile("default", { hub: "https://h", token: "tugra_pat_x" });
  out = [];
  err = [];
  jest.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  jest.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  globalThis.fetch = origFetch;
  jest.restoreAllMocks();
});

function stubVersion(protocol: number, edition = "community") {
  globalThis.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ version: "9.9.9", protocol, channel: "stable", commit: "", edition }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("version command", () => {
  it("--json reports the CLI + hub version", async () => {
    stubVersion(2, "pro");
    const p = new Command();
    register(p);
    await p.parseAsync(["node", "tugra", "version", "--json"]);
    const json = JSON.parse(out.join(""));
    expect(json.cli).toBeTruthy();
    expect(json.hub.version).toBe("9.9.9");
    expect(json.hub.edition).toBe("pro");
    expect(err.join("")).toBe(""); // protocol matches → no warning
  });

  it("warns on stderr when the hub protocol differs from the CLI", async () => {
    stubVersion(99);
    const p = new Command();
    register(p);
    await p.parseAsync(["node", "tugra", "version"]);
    expect(err.join("")).toMatch(/protocol 99 differs/);
    expect(out.join("")).toContain("tugra CLI");
  });
});
