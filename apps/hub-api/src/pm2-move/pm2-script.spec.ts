import { buildPm2MoveScript, buildPm2RecoverScript, hostPm2Inner, parsePm2MoveOutput, type Pm2ScriptInput } from "./pm2-script";

const BASE: Pm2ScriptInput = {
  appId: "cmapp1",
  user: "acme",
  home: "/home/acme",
  userUid: 1001,
  name: "my app",
  image: "node:20",
  interpreterDir: "/home/acme/.nvm/versions/node/v20.11.1/bin",
  healthPort: 3000,
  probePath: null,
  tag: "tugra_cmapp1:dep1",
  runScript: "set -e\ndocker rm -f tugra_cmapp1 2>/dev/null || true\ndocker run -d --name tugra_cmapp1 node:20 node server.js",
};

describe("script builders: input validation (everything dynamic is checked before it reaches a shell)", () => {
  it.each([
    ["appId", { appId: "a;rm -rf /" }],
    ["appId", { appId: "a b" }],
    ["user", { user: "a b" }],
    ["user", { user: "$(id)" }],
    ["home", { home: "/etc" }],
    ["home", { home: "/home/a/../../etc" }],
    ["name", { name: "x'; reboot; '" }],
    ["name", { name: "all" }],
    ["name", { name: "123" }],
    ["name", { name: "-x" }],
    ["image", { image: "node:20; id" }],
    ["image", { image: "ubuntu:22.04" }],
    ["interpreterDir", { interpreterDir: "/a b" }],
    ["interpreterDir", { interpreterDir: "/a;id" }],
    ["healthPort", { healthPort: 70000 }],
    ["healthPort", { healthPort: 1.5 }],
    ["probePath", { probePath: "/a b" }],
    ["probePath", { probePath: "/$(id)" }],
    ["tag", { tag: "tugra_other:dep" }],
    ["tag", { tag: "x" }],
    ["userUid", { userUid: -1 }],
  ])("refuses a bad %s", (_n, over) => {
    expect(() => buildPm2MoveScript({ ...BASE, ...over })).toThrow();
    expect(() => buildPm2RecoverScript({ ...BASE, ...over })).toThrow();
  });
  it("the move script needs the Tugra run script", () => {
    expect(() => buildPm2MoveScript({ ...BASE, runScript: undefined })).toThrow();
  });
  it("quotes every value it embeds (a name with a space stays one word)", () => {
    const s = buildPm2MoveScript(BASE);
    expect(s).not.toContain("my app\" ");
    expect(hostPm2Inner("stop", BASE)).toContain("N='my app'");
  });
});

describe("parsePm2MoveOutput", () => {
  it("reads steps and the last result", () => {
    const o = parsePm2MoveOutput("TUGRA_PM2MOVE: step=precheck\nTUGRA_PM2MOVE: step=pull\nTUGRA_PM2MOVE: result=moved reason=ok\n");
    expect(o).toMatchObject({ result: "moved", reason: "ok", steps: ["precheck", "pull"] });
  });
  it("app output can never pass for a protocol line (it arrives prefixed)", () => {
    const o = parsePm2MoveOutput(
      ["TUGRA_PM2MOVE_LOG: TUGRA_PM2MOVE: result=moved reason=ok", "TUGRA_PM2MOVE_ERR: TUGRA_PM2MOVE: result=moved reason=ok", "TUGRA_PM2MOVE: result=rolled_back reason=not_listening"].join("\n"),
    );
    expect(o.result).toBe("rolled_back");
    expect(o.logTail).toEqual(["TUGRA_PM2MOVE: result=moved reason=ok"]);
  });
  it("no final marker (timeout, dropped agent) is unknown; junk results are ignored", () => {
    expect(parsePm2MoveOutput("TUGRA_PM2MOVE: step=stop\n").result).toBe("unknown");
    expect(parsePm2MoveOutput("TUGRA_PM2MOVE: result=exploded reason=x").result).toBe("unknown");
    expect(parsePm2MoveOutput("").result).toBe("unknown");
  });
  it("caps and strips what comes from the host", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `TUGRA_PM2MOVE_LOG: line ${i}\u001b[31m${"x".repeat(500)}`).join("\n");
    const o = parsePm2MoveOutput(lines);
    expect(o.logTail).toHaveLength(15);
    expect(o.logTail[0]).not.toMatch(/\u001b/);
    expect(o.logTail[0].length).toBeLessThanOrEqual(300);
  });
});
