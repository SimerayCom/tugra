import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { register, parseLabelPairs } from "./resources";
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

const view = {
  engine: "docker",
  editable: true,
  tugra: [
    { scope: "container", key: "traefik.enable", value: "true", masked: false, purpose: "traefik_routing" },
    { scope: "container", key: "traefik.http.middlewares.x-ba.basicauth.users", value: null, masked: true, purpose: "traefik_routing" },
  ],
  custom: [{ key: "team", value: "core" }, { key: "Env", value: "prod" }],
  fromDockerOptions: [{ key: "legacy", value: "1" }],
};

/** GET /labels returns `view`; PUT /custom-labels returns {ok:true}. Captures every call. */
function stub() {
  const fn = jest.fn(async (_url: string, init?: { method?: string }) =>
    init?.method === "PUT"
      ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const putBody = (fn: jest.Mock) => {
  const call = fn.mock.calls.find((c) => c[1]?.method === "PUT")!;
  return { url: call[0] as string, body: JSON.parse(call[1].body as string) };
};

describe("parseLabelPairs", () => {
  it("splits at the first = and allows empty values", () => {
    expect(parseLabelPairs(["a=b=c", "e="])).toEqual([["a", "b=c"], ["e", ""]]);
  });
  it("rejects a pair without a key", () => {
    expect(() => parseLabelPairs(["nokey"])).toThrow(/KEY=VALUE/);
    expect(() => parseLabelPairs(["=v"])).toThrow(/KEY=VALUE/);
  });
});

describe("tugra apps labels", () => {
  it("ls hits GET /apps/:id/labels and masks hidden values", async () => {
    const fn = stub();
    await run(["apps", "labels", "ls", "a1"]);
    expect(fn.mock.calls[0][0]).toBe("https://h/api/v1/apps/a1/labels");
    const text = out.join("");
    expect(text).toContain("traefik.enable");
    expect(text).toContain("(masked)");
    expect(text).toContain("custom");
    expect(text).toContain("docker-options");
  });

  it("ls --json prints the full view", async () => {
    stub();
    await run(["apps", "labels", "ls", "a1", "--json"]);
    expect(JSON.parse(out.join(""))).toMatchObject({ engine: "docker", custom: view.custom });
  });

  it("set merges over the current labels (case-insensitive replace) via read-modify-write", async () => {
    const fn = stub();
    await run(["apps", "labels", "set", "a1", "env=staging", "new=1"]);
    const { url, body } = putBody(fn);
    expect(url).toBe("https://h/api/v1/apps/a1/custom-labels");
    expect(body).toEqual({ labels: { team: "core", env: "staging", new: "1" } });
  });

  it("set --replace sends only the given labels and reads nothing first", async () => {
    const fn = stub();
    await run(["apps", "labels", "set", "a1", "only=1", "--replace"]);
    expect(fn.mock.calls.filter((c) => c[1]?.method !== "PUT")).toHaveLength(0);
    expect(putBody(fn).body).toEqual({ labels: { only: "1" } });
  });

  it("rm removes keys (case-insensitive) and errors on an unknown one", async () => {
    const fn = stub();
    await run(["apps", "labels", "rm", "a1", "env"]);
    expect(putBody(fn).body).toEqual({ labels: { team: "core" } });
    await expect(run(["apps", "labels", "rm", "a1", "nope"])).rejects.toThrow(/no custom label named "nope"/);
  });

  it("reset PUTs an empty map", async () => {
    const fn = stub();
    await run(["apps", "labels", "reset", "a1"]);
    expect(putBody(fn).body).toEqual({ labels: {} });
  });
});
