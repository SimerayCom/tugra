import "reflect-metadata";
import { COOLIFY_HOST_IDENTITY } from "./coolify-ssh-plan";
import { hostIdentityReaderOf } from "./coolify-host-identity";
import { CoolifyTakeoverModule } from "./coolify-takeover.module";
import { ServersService } from "../servers/servers.service";

const FP = "SHA256:" + "A".repeat(43);
const FP2 = "SHA256:" + "B".repeat(43);

describe("COOLIFY_HOST_IDENTITY: what a freshly enrolled agent reports about its own sshd host keys", () => {
  it("is provided by the takeover module, built from the servers service (so the install's cross-check is real)", () => {
    const providers = Reflect.getMetadata("providers", CoolifyTakeoverModule) as Array<unknown>;
    const p = providers.find((x) => typeof x === "object" && x !== null && (x as { provide?: unknown }).provide === COOLIFY_HOST_IDENTITY) as { useFactory: (s: unknown) => unknown; inject: unknown[] };
    expect(p).toBeDefined();
    expect(p.inject).toEqual([ServersService]);
    const servers = { hostIdentityOf: jest.fn(() => ({ sshHostKeyFp: FP })) };
    expect(p.useFactory(servers)).toMatchObject({ reportedHostKeyFp: expect.any(Function), reportedHostKeyFps: expect.any(Function) });
  });

  it("gives the first key and the whole list the agent reported", async () => {
    const servers = { hostIdentityOf: jest.fn((id: string) => (id === "s1" ? { sshHostKeyFp: FP, sshHostKeyFps: [FP, FP2] } : undefined)) };
    const r = hostIdentityReaderOf(servers);
    await expect(r.reportedHostKeyFp("s1")).resolves.toBe(FP);
    await expect(r.reportedHostKeyFps!("s1")).resolves.toEqual([FP, FP2]);
  });

  it("an agent that reported none (older agent, not connected since the hub started) has none: null and an empty list, never a guess", async () => {
    const r = hostIdentityReaderOf({ hostIdentityOf: () => undefined });
    await expect(r.reportedHostKeyFp("s1")).resolves.toBeNull();
    await expect(r.reportedHostKeyFps!("s1")).resolves.toEqual([]);
    const only = hostIdentityReaderOf({ hostIdentityOf: () => ({ machineIdHash: "m" }) });
    await expect(only.reportedHostKeyFp("s1")).resolves.toBeNull();
  });
});
