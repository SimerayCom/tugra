import { BadRequestException } from "@nestjs/common";
import { ImporterService } from "./importer.service";
import type { AdoptableContainer } from "../migrator/migrator.service";

const container: AdoptableContainer = {
  id: "c1",
  name: "web",
  image: "nginx:1",
  state: "running",
  ports: [{ host: 80, container: 80, protocol: "tcp" }],
  env: [{ key: "K", value: "SECRETVAL" }],
  mounts: [],
  restartPolicy: "always",
  isTugra: false,
  composeProject: null,
  adoptable: true,
};

describe("ImporterService", () => {
  it("plan() discovers via local-docker and returns a deterministic, secret-free plan", async () => {
    const discover = jest.fn().mockResolvedValue({ containers: [container] });
    const svc = new ImporterService({ discover } as never);
    const plan = await svc.plan("u1", { sourceKind: "local-docker", serverId: "srv1" });

    expect(discover).toHaveBeenCalledWith("u1", "srv1"); // caller identity preserved → migrator authz runs
    expect(plan.sourceKind).toBe("local-docker");
    expect(plan.mode).toBe("copy");
    expect(plan.totals.apps).toBe(1);
    expect(plan.items.find((i) => i.kind === "app")!.itemRef).toBe("app:srv1:c1");
    expect(plan.planHash).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(plan)).not.toContain("SECRETVAL"); // env values never reach the plan
  });

  it("surfaces the compose-skip warning end-to-end in plan.warnings", async () => {
    const compose: AdoptableContainer = { ...container, id: "c2", composeProject: "stack", adoptable: false };
    const discover = jest.fn().mockResolvedValue({ containers: [container, compose] });
    const svc = new ImporterService({ discover } as never);
    const plan = await svc.plan("u1", { sourceKind: "local-docker", serverId: "srv1" });
    expect(plan.totals.apps).toBe(1); // only the standalone container is planned
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("1 compose-managed");
  });

  it("rejects an unsupported source kind", async () => {
    const svc = new ImporterService({ discover: jest.fn() } as never);
    await expect(
      svc.plan("u1", { sourceKind: "coolify" as never, serverId: "srv1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
