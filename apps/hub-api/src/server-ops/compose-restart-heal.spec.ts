import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildComposeRestartHealScript, healTargetsFor, HEAL_MARKER, parseHealed } from "./compose-restart-heal";
import { ComposeRestartHealService, HEAL_INTERVAL_MS } from "./compose-restart-heal.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";

const BARE = "services:\n  meilisearch:\n    image: getmeili/meilisearch\n  web:\n    image: nginx\n";
const row = (id: string, composeFile: string | null, over: Record<string, unknown> = {}) => ({ id, composeFile, gitUrl: null, composePath: null, ...over });

describe("healTargetsFor", () => {
  it("lists the members of a stored compose that set no policy, under the app's compose project", () => {
    expect(healTargetsFor([row("a1", BARE)])).toEqual([{ project: "tugra_a1", services: ["meilisearch", "web"] }]);
  });

  it("skips explicit policies (including \"no\"), init members, git-compose apps and files without services", () => {
    const explicit = "services:\n  a:\n    image: x\n    restart: \"no\"\n";
    const init = "services:\n  i:\n    image: x\n  a:\n    image: x\n    restart: always\n    depends_on:\n      i:\n        condition: service_completed_successfully\n";
    expect(
      healTargetsFor([
        row("e", explicit),
        row("i", init),
        row("g", BARE, { gitUrl: "https://x/r.git", composePath: "compose.yml" }),
        row("n", null),
        row("bad", "services: [oops"),
      ]),
    ).toEqual([]);
  });

  it("rejects an id that is not a plain compose project suffix", () => {
    expect(healTargetsFor([row("a;rm -rf /", BARE)])).toEqual([]);
  });
});

describe("buildComposeRestartHealScript", () => {
  it("emits one heal call per member and only ever runs `docker update --restart unless-stopped`", () => {
    const s = buildComposeRestartHealScript([{ project: "tugra_a1", services: ["meilisearch", "web"] }]);
    expect(s).toContain("heal tugra_a1 meilisearch\nheal tugra_a1 web\nexit 0");
    expect(s).toContain("docker update --restart unless-stopped");
    expect(s).not.toMatch(/docker (start|stop|restart|rm|kill|compose)/);
    // touches only a container whose policy is "no"/empty, never a one-off `compose run` container
    expect(s).toContain('case "$p" in ""|no)');
    expect(s).toContain("label=com.docker.compose.oneoff=False");
  });

  it("drops a malformed project or service name instead of passing it to the shell", () => {
    const s = buildComposeRestartHealScript([
      { project: "tugra_ok", services: ["good", "bad name", "x;id"] },
      { project: "other_proj", services: ["web"] },
    ]);
    expect(s).toContain("heal tugra_ok good");
    expect(s).not.toContain("bad name");
    expect(s).not.toContain("x;id");
    expect(s).not.toContain("other_proj");
  });

  it("parseHealed counts the marker lines", () => {
    expect(parseHealed(`${HEAL_MARKER} tugra_a web\nnoise\n${HEAL_MARKER} tugra_a db\n`)).toBe(2);
    expect(parseHealed("")).toBe(0);
  });
});

// Runs the real script under /bin/sh against a fake `docker` that holds per-container restart policies, so the shell
// logic (policy filter, idempotence, one-off skip, no start/stop) is exercised without a daemon or the runner OS.
describe("buildComposeRestartHealScript (real shell, fake docker)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "heal-"));
    // state file: <id> <project> <service> <oneoff> <policy>
    writeFileSync(
      join(dir, "state"),
      ["c1 tugra_a1 meilisearch False no", "c2 tugra_a1 web False unless-stopped", "c3 tugra_a1 web True no", "c4 tugra_a1 db False ", "c5 tugra_zz web False no"].join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "docker"),
      `#!/bin/sh
S="$(dirname "$0")/state"
case "$1" in
  ps)
    shift; proj=; svc=; one=
    while [ $# -gt 0 ]; do case "$1" in --filter) shift; case "$1" in label=com.docker.compose.project=*) proj="\${1#*=}"; proj="\${proj#*=}";; label=com.docker.compose.service=*) svc="\${1#*=}"; svc="\${svc#*=}";; label=com.docker.compose.oneoff=*) one="\${1#*=}"; one="\${one#*=}";; esac;; esac; shift; done
    awk -v p="$proj" -v s="$svc" -v o="$one" '$2==p && $3==s && $4==o {print $1}' "$S";;
  inspect) awk -v id="$4" '$1==id {print $5}' "$S";;
  update) echo "update $*" >> "$(dirname "$0")/calls"; awk -v id="$4" '{ if ($1==id) $5="unless-stopped"; print }' "$S" > "$S.n" && mv "$S.n" "$S";;
  *) echo "unexpected docker $*" >> "$(dirname "$0")/calls"; exit 1;;
esac
`,
    );
    chmodSync(join(dir, "docker"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (script: string) => spawnSync("sh", ["-c", script], { env: { PATH: `${dir}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
  const state = () => readFileSync(join(dir, "state"), "utf8");
  const calls = () => { try { return readFileSync(join(dir, "calls"), "utf8"); } catch { return ""; } };

  it("sets unless-stopped on a policy-less member, leaves set policies / one-offs / other projects alone, and is idempotent", () => {
    const script = buildComposeRestartHealScript([{ project: "tugra_a1", services: ["meilisearch", "web", "db"] }]);
    const first = run(script);
    expect(first.status).toBe(0);
    expect(parseHealed(first.stdout)).toBe(2); // c1 (no) and c4 (empty policy)
    const st = state();
    expect(st).toContain("c1 tugra_a1 meilisearch False unless-stopped");
    expect(st).toContain("c4 tugra_a1 db False unless-stopped");
    expect(st).toContain("c3 tugra_a1 web True no"); // compose run one-off untouched
    expect(st).toContain("c5 tugra_zz web False no"); // not in the targets
    const second = run(script);
    expect(parseHealed(second.stdout)).toBe(0); // nothing left to heal
    expect(calls().split("\n").filter((l) => l.startsWith("update"))).toHaveLength(2);
    expect(calls()).not.toContain("unexpected");
  });
});

describe("ComposeRestartHealService", () => {
  function make(opts: { online?: boolean; apps?: unknown[]; exitCode?: number } = {}) {
    const findApps = jest.fn().mockResolvedValue(opts.apps ?? [row("a1", BARE)]);
    const prisma = { server: { findMany: jest.fn().mockResolvedValue([{ id: "s1" }]) }, application: { findMany: findApps } } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: opts.exitCode ?? 0, output: `${HEAL_MARKER} tugra_a1 web\n` });
    const agentWs = { isOnline: jest.fn().mockReturnValue(opts.online ?? true), sendCommand } as unknown as AgentWsServer;
    return { svc: new ComposeRestartHealService(prisma, agentWs), sendCommand, findApps };
  }

  it("sends the heal script for the server's non-stopped stored-compose apps over the bulk capability", async () => {
    const { svc, sendCommand, findApps } = make();
    await svc.runTick(1_000);
    expect(findApps.mock.calls[0][0].where).toMatchObject({ serverId: "s1", source: "COMPOSE", status: { not: "STOPPED" } });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][1]).toContain("heal tugra_a1 meilisearch");
    expect(sendCommand.mock.calls[0][2]).toBe("bulk");
  });

  it("is throttled per server, then runs again after the interval", async () => {
    const { svc, sendCommand } = make();
    await svc.runTick(1_000);
    await svc.runTick(1_000 + 60_000);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    await svc.runTick(1_000 + HEAL_INTERVAL_MS);
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to an offline agent or when no app has anything to heal", async () => {
    const off = make({ online: false });
    await off.svc.runTick(1_000);
    expect(off.sendCommand).not.toHaveBeenCalled();
    const none = make({ apps: [row("e", "services:\n  a:\n    image: x\n    restart: always\n")] });
    await none.svc.runTick(1_000);
    expect(none.sendCommand).not.toHaveBeenCalled();
  });

  it("never throws, and a failed server is retried on the next tick", async () => {
    const { svc, sendCommand } = make();
    sendCommand.mockRejectedValueOnce(new Error("agent gone"));
    await expect(svc.runTick(1_000)).resolves.toBeUndefined();
    await svc.runTick(2_000); // within the interval, but the failed pass cleared the throttle
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});
