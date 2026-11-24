import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ImporterController } from "./importer.controller";
import { ImportApplySchema, ImportGitLinksSchema, ImportGitRelinkSchema } from "./dto";

const user = { userId: "u1" } as never;

function make() {
  const executor = { apply: jest.fn().mockResolvedValue({ opId: "op-1" }) };
  const gitLinks = { list: jest.fn().mockResolvedValue({ rows: [], groups: [] }), relink: jest.fn().mockResolvedValue({ results: [], linked: 0 }) };
  const ctl = new ImporterController({} as never, executor as never, gitLinks as never, {} as never, { resolve: jest.fn() } as never, {} as never);
  return { ctl, executor, gitLinks };
}

describe("ImporterController — egress IP", () => {
  it("GET /import/egress-ip returns the resolver's answer", async () => {
    const egress = { resolve: jest.fn().mockResolvedValue({ ip: "203.0.113.7", source: "server" }) };
    const ctl = new ImporterController({} as never, {} as never, {} as never, {} as never, egress as never, {} as never);
    await expect(ctl.egressIp()).resolves.toEqual({ ip: "203.0.113.7", source: "server" });
  });
});

describe("ImporterController — acks and git-link endpoints", () => {
  it("apply passes the validated body (acks included) to the executor unchanged", async () => {
    const { ctl, executor } = make();
    const raw = { sourceKind: "coolify", sessionId: "s", targetServerId: "t", planHash: "a".repeat(32), acks: [{ code: "app.env.unresolved", itemRef: "app:s:a" }] };
    const body = new ZodValidationPipe(ImportApplySchema).transform(raw, { type: "body" } as never) as never;
    await ctl.apply(user, body);
    expect(executor.apply).toHaveBeenCalledWith("u1", raw);
  });

  it("the pipe rejects an ack for a non-ackable code (tokenReadOnly) before the executor is reached", () => {
    const pipe = new ZodValidationPipe(ImportApplySchema);
    expect(() => pipe.transform({ sourceKind: "coolify", sessionId: "s", targetServerId: "t", planHash: "a".repeat(32), acks: [{ code: "app.env.tokenReadOnly" }] }, { type: "body" } as never)).toThrow();
  });

  it("POST /import/git-links and /operations/:opId/git-links/relink delegate with the caller's user id", async () => {
    const { ctl, gitLinks } = make();
    const b1 = new ZodValidationPipe(ImportGitLinksSchema).transform({ sessionId: "s", targetServerId: "t" }, { type: "body" } as never) as never;
    await ctl.gitLinksPreview(user, b1);
    expect(gitLinks.list).toHaveBeenCalledWith("u1", { sessionId: "s", targetServerId: "t" });
    const b2 = new ZodValidationPipe(ImportGitRelinkSchema).transform({ choices: { "app:s:a": "gs-1" } }, { type: "body" } as never) as never;
    await ctl.relinkGit(user, "op-9", b2);
    expect(gitLinks.relink).toHaveBeenCalledWith("u1", "op-9", { choices: { "app:s:a": "gs-1" } });
  });

  it("the git-link DTOs require their ids", () => {
    expect(ImportGitLinksSchema.safeParse({ sessionId: "s" }).success).toBe(false);
    expect(ImportGitRelinkSchema.safeParse({}).success).toBe(true);
    expect(ImportGitRelinkSchema.safeParse({ choices: { a: "" } }).success).toBe(false);
  });
});
