import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { importVolumeRows, register } from "./resources";
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

const run = (args: string[]) => {
  const p = new Command();
  p.exitOverride();
  register(p);
  return p.parseAsync(["node", "tugra", ...args]);
};
const REF = "volume:srv1:5f3a9c:data";
const view = {
  enabled: true,
  tokenExpiresAt: null,
  volumes: [
    { itemRef: REF, resourceName: "web", state: "COPYING", phase: "streaming", partsDone: 12, rawBytesDone: 2 * 1024 ** 3, rawBytesTotal: 5 * 1024 ** 3, bps: 25 * 1024 ** 2, etaSec: 7200, error: null },
    { itemRef: "volume:srv1:pg:data", resourceName: "pg", state: "FAILED", phase: null, partsDone: 0, rawBytesDone: 0, rawBytesTotal: null, bps: null, etaSec: null, error: "vx-diverged" },
  ],
};
function stub(body: unknown = view) {
  const fn = jest.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("tugra import volumes", () => {
  it("lists the copies as a table with progress, speed, ETA and the failure text", async () => {
    const fn = stub();
    await run(["import", "volumes", "op1"]);
    expect(fn).toHaveBeenCalledTimes(1);
    const calls = fn.mock.calls as unknown as Array<[string, { method?: string }]>;
    expect(calls[0][0]).toBe("https://h/api/v1/import/operations/op1/volumes");
    const text = out.join("");
    expect(text).toContain("COPYING");
    expect(text).toContain("40% (2.0 GiB of 5.0 GiB)");
    expect(text).toContain("25 MiB/s");
    expect(text).toContain("120 min");
    expect(text).toContain("vx-diverged");
  });

  it("--json prints the hub's view untouched", async () => {
    stub();
    await run(["import", "volumes", "op1", "--json"]);
    expect(JSON.parse(out.join(""))).toEqual(view);
  });

  it("--abort and --reset POST to the volume's own endpoint with the url-encoded itemRef", async () => {
    const fn = stub({ state: "ABORTED" });
    await run(["import", "volumes", "op1", "--abort", REF]);
    await run(["import", "volumes", "op1", "--reset", REF]);
    const calls = fn.mock.calls as unknown as Array<[string, { method?: string }]>;
    expect(calls[0][0]).toBe(`https://h/api/v1/import/operations/op1/volumes/${encodeURIComponent(REF)}/abort`);
    expect(calls[0][1].method).toBe("POST");
    expect(calls[1][0]).toBe(`https://h/api/v1/import/operations/op1/volumes/${encodeURIComponent(REF)}/reset`);
    expect(out.join("")).toContain(`abort requested for ${REF}: ABORTED`);
  });

  it("refuses --abort together with --reset and sends nothing", async () => {
    const fn = stub();
    await expect(run(["import", "volumes", "op1", "--abort", REF, "--reset", REF])).rejects.toThrow(/either --abort or --reset/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("says so when the stream is off or there is nothing to copy", async () => {
    stub({ enabled: false, tokenExpiresAt: null, volumes: [] });
    await run(["import", "volumes", "op1"]);
    expect(out.join("")).toContain("switched off on this hub");
    out.length = 0;
    stub({ enabled: true, tokenExpiresAt: null, volumes: [] });
    await run(["import", "volumes", "op1"]);
    expect(out.join("")).toContain("no volume of this import has data to copy");
  });

  it("row helper: unknown totals print only what was copied; unknown speed/eta stay empty", () => {
    const rows = importVolumeRows({ enabled: true, tokenExpiresAt: null, volumes: [{ itemRef: "x", resourceName: null, state: "COPYING", phase: null, partsDone: 1, rawBytesDone: 3 * 1024 ** 2, rawBytesTotal: null, bps: null, etaSec: null, error: null }] });
    expect(rows[0]).toMatchObject({ progress: "3 MiB", speed: "", eta: "", error: "", name: "" });
  });
});
