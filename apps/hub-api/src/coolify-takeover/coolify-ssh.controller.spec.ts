import "reflect-metadata";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { CoolifySshController } from "./coolify-ssh.controller";
import { CoolifyTakeoverModule } from "./coolify-takeover.module";
import { SshConfirmSchema, SshStartSchema, SshVerifySchema } from "./dto";

const scopesOf = (name: keyof CoolifySshController) => Reflect.getMetadata(REQUIRE_SCOPES, CoolifySshController.prototype[name]) as string[] | undefined;

describe("CoolifySshController", () => {
  it("every step that acts needs `write`, and the ones that carry consent also `read:secrets`", () => {
    expect(scopesOf("start")).toEqual(["write", "read:secrets"]);
    expect(scopesOf("install")).toEqual(["write", "read:secrets"]);
    expect(scopesOf("uninstall")).toEqual(["write", "read:secrets"]);
    expect(scopesOf("cancel")).toEqual(["write"]);
    expect(scopesOf("verify")).toEqual(["write", "read:secrets"]);
  });

  it("is mounted under the Coolify host, so the host is always named", () => {
    expect(Reflect.getMetadata("path", CoolifySshController)).toBe("coolify-takeover/servers/:serverId/ssh");
  });

  it("is registered in the takeover module, and the service it needs is exported for the lanes after it", () => {
    expect(Reflect.getMetadata("controllers", CoolifyTakeoverModule)).toContain(CoolifySshController);
  });

  it("hands the caller's id and the path ids to the service", async () => {
    const ssh = { startRun: jest.fn().mockResolvedValue("S"), startVerify: jest.fn().mockResolvedValue("V"), startInstall: jest.fn().mockResolvedValue("I"), startUninstall: jest.fn().mockResolvedValue("U"), cancelRun: jest.fn().mockResolvedValue("C"), getRun: jest.fn().mockResolvedValue("G"), latestRun: jest.fn().mockResolvedValue("L") } as any;
    const c = new CoolifySshController(ssh);
    const user = { userId: "u1" } as any;
    const body = { coolifyServerUuids: ["abc123def456"], teamId: "t", confirm: "1" };
    await c.start(user, "HOST", body);
    await c.verify(user, "HOST", { coolifyServerUuids: ["abc123def456"] });
    await c.install(user, "HOST", "run1", { confirm: "1" });
    await c.uninstall(user, "HOST", "run1", { confirm: "1" });
    await c.cancel(user, "HOST", "run1");
    await c.get(user, "HOST", "run1");
    await c.latest(user, "HOST");
    expect(ssh.startRun).toHaveBeenCalledWith("u1", "HOST", body);
    expect(ssh.startVerify).toHaveBeenCalledWith("u1", "HOST", { coolifyServerUuids: ["abc123def456"] });
    expect(ssh.startInstall).toHaveBeenCalledWith("u1", "HOST", "run1", { confirm: "1" });
    expect(ssh.startUninstall).toHaveBeenCalledWith("u1", "HOST", "run1", { confirm: "1" });
    expect(ssh.cancelRun).toHaveBeenCalledWith("u1", "HOST", "run1");
    expect(ssh.getRun).toHaveBeenCalledWith("u1", "HOST", "run1");
    expect(ssh.latestRun).toHaveBeenCalledWith("u1", "HOST");
  });
});

describe("SSH install bodies", () => {
  const ok = { coolifyServerUuids: ["abc123def456"], teamId: "t1", confirm: "1" };
  it("accepts a normal request", () => {
    expect(SshStartSchema.safeParse(ok).success).toBe(true);
    expect(SshStartSchema.safeParse({ ...ok, concurrency: 8 }).success).toBe(true);
    expect(SshConfirmSchema.safeParse({ confirm: "3" }).success).toBe(true);
  });
  it("refuses anything that is not a Coolify uuid, too many servers, a missing confirm and an out-of-range concurrency", () => {
    for (const bad of [["-oProxyCommand=x"], ["ABC123DEF456"], ["a;b"], [], Array.from({ length: 101 }, (_, i) => `srv${String(i).padStart(9, "0")}`)]) {
      expect(SshStartSchema.safeParse({ ...ok, coolifyServerUuids: bad }).success).toBe(false);
    }
    expect(SshStartSchema.safeParse({ ...ok, confirm: "" }).success).toBe(false);
    expect(SshStartSchema.safeParse({ coolifyServerUuids: ok.coolifyServerUuids, teamId: "t1" }).success).toBe(false);
    expect(SshStartSchema.safeParse({ ...ok, concurrency: 0 }).success).toBe(false);
    expect(SshStartSchema.safeParse({ ...ok, concurrency: 9 }).success).toBe(false);
    expect(SshConfirmSchema.safeParse({}).success).toBe(false);
  });
  it("does not carry a token, a key or an address: unknown keys are not part of the shape", () => {
    const parsed = SshStartSchema.parse({ ...ok, token: "tugra_en_x", privateKey: "x", ip: "1.2.3.4" } as never) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("token");
    expect(parsed).not.toHaveProperty("privateKey");
    expect(parsed).not.toHaveProperty("ip");
  });
});

describe("SSH verify body", () => {
  it("takes the uuids, and the typed count when the owner already gave it (the hub asks for it otherwise)", () => {
    expect(SshVerifySchema.safeParse({ coolifyServerUuids: ["abc123def456"] }).success).toBe(true);
    expect(SshVerifySchema.safeParse({ coolifyServerUuids: ["abc123def456"], confirm: "1" }).success).toBe(true);
  });
  it("refuses an option-like uuid, none, too many, and an empty confirm", () => {
    for (const bad of [["-oProxyCommand=x"], [], Array.from({ length: 101 }, (_, i) => `srv${String(i).padStart(9, "0")}`)]) {
      expect(SshVerifySchema.safeParse({ coolifyServerUuids: bad }).success).toBe(false);
    }
    expect(SshVerifySchema.safeParse({ coolifyServerUuids: ["abc123def456"], confirm: "" }).success).toBe(false);
  });
});
