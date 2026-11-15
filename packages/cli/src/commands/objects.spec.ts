import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { register, parsePairs, SRC_SECRET_ENV, DST_SECRET_ENV } from "./objects";
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
  delete process.env[SRC_SECRET_ENV];
  delete process.env[DST_SECRET_ENV];
  globalThis.fetch = origFetch;
  jest.restoreAllMocks();
});

const run = (args: string[]) => {
  const p = new Command();
  register(p);
  return p.parseAsync(["node", "tugra", ...args]);
};
const migration = { id: "m1", name: "move", status: "PREFLIGHTED", buckets: [{ srcBucket: "bk1", dstBucket: "bk1", selected: false, exclude: [] }, { srcBucket: "bk2", dstBucket: "bk2", selected: false, exclude: [] }] };
function stub(body: unknown = migration) {
  const fn = jest.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const calls = (fn: jest.Mock) => fn.mock.calls.map((c) => ({ url: String(c[0]), init: (c as unknown[])[1] as { method?: string; body?: string } }));

describe("tugra objects", () => {
  it("create reads the secret keys from the environment, never from flags", async () => {
    const fn = stub();
    await expect(run(["objects", "create", "--name", "move", "--server", "s1", "--source", "https://a.example.com", "--source-access-key", "AK1", "--destination", "http://host.docker.internal:9100", "--destination-access-key", "AK2"])).rejects.toThrow(/never passed as flags/);
    expect(fn).not.toHaveBeenCalled();
    process.env[SRC_SECRET_ENV] = "SK-ONE";
    process.env[DST_SECRET_ENV] = "SK-TWO";
    await run(["objects", "create", "--name", "move", "--server", "s1", "--source", "https://a.example.com", "--source-access-key", "AK1", "--destination", "http://host.docker.internal:9100", "--destination-access-key", "AK2", "--no-preserve"]);
    const [c] = calls(fn);
    expect(c.url).toBe("https://h/api/v1/object-migrations");
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(c.init.body!)).toEqual({ name: "move", targetServerId: "s1", preserve: false, source: { endpoint: "https://a.example.com", accessKey: "AK1", secretKey: "SK-ONE" }, destination: { endpoint: "http://host.docker.internal:9100", accessKey: "AK2", secretKey: "SK-TWO" } });
    expect(out.join("")).not.toContain("SK-ONE");
  });

  it("buckets selects exactly the named buckets (everything else deselected), with rename and excludes; unknown bucket fails before any write", async () => {
    const fn = stub();
    await run(["objects", "buckets", "m1", "--select", "bk2", "--rename", "bk2=bk2-new", "--exclude", "bk2=tmp/*", "bk2=*.log"]);
    const put = calls(fn).find((c) => c.init.method === "PUT")!;
    expect(put.url).toBe("https://h/api/v1/object-migrations/m1/buckets");
    expect(JSON.parse(put.init.body!)).toEqual({ buckets: [{ srcBucket: "bk1", selected: false }, { srcBucket: "bk2", selected: true, dstBucket: "bk2-new", exclude: ["tmp/*", "*.log"] }] });
    const fn2 = stub();
    await expect(run(["objects", "buckets", "m1", "--select", "ghost"])).rejects.toThrow(/unknown source bucket/);
    expect(calls(fn2).some((c) => c.init.method === "PUT")).toBe(false);
  });

  it("start: seed by default; final carries the explicit acknowledgement and --remove only when asked", async () => {
    const fn = stub();
    await run(["objects", "start", "m1"]);
    expect(JSON.parse(calls(fn)[0].init.body!)).toEqual({ phase: "seed" });
    await run(["objects", "start", "m1", "--phase", "final", "--ack-writes-frozen"]);
    expect(JSON.parse(calls(fn)[1].init.body!)).toEqual({ phase: "final", acknowledgeWritesFrozen: true });
    await run(["objects", "start", "m1", "--phase", "final", "--ack-writes-frozen", "--remove", "--merge"]);
    expect(JSON.parse(calls(fn)[2].init.body!)).toEqual({ phase: "final", acknowledgeWritesFrozen: true, removeExtraneous: true, mergeIntoExisting: true });
    await expect(run(["objects", "start", "m1", "--phase", "nuke"])).rejects.toThrow(/seed or final/);
  });

  it("preflight / verify / carry-config / cancel POST the matching sub-resource", async () => {
    const fn = stub();
    for (const a of ["preflight", "verify", "carry-config", "cancel"]) await run(["objects", a, "m1"]);
    expect(calls(fn).map((c) => `${c.init.method} ${c.url.replace("https://h/api/v1", "")}`)).toEqual([
      "POST /object-migrations/m1/preflight",
      "POST /object-migrations/m1/verify",
      "POST /object-migrations/m1/carry-config",
      "POST /object-migrations/m1/cancel",
    ]);
  });

  it("import git-links posts the session and target server", async () => {
    const fn = stub({ rows: [], groups: [{ host: "github.com", owner: "acme", status: "linked", apps: 3, sourceName: "Acme" }] });
    await run(["import", "git-links", "--session", "s1", "--server", "srv1"]);
    const c = calls(fn)[0];
    expect(c.url).toBe("https://h/api/v1/import/git-links");
    expect(JSON.parse(c.init.body!)).toEqual({ sessionId: "s1", targetServerId: "srv1" });
    expect(out.join("")).toContain("github.com");
  });

  it("parsePairs splits at the first '='", () => {
    expect(parsePairs(["a=b=c", "x=y"])).toEqual({ a: "b=c", x: "y" });
    expect(() => parsePairs(["nope"])).toThrow();
  });
});
