import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ObjectMigrationsController } from "./object-migrations.controller";
import { CreateObjectMigrationSchema, SetBucketsSchema, StartObjectMigrationSchema } from "./dto";

const user = { userId: "u1" } as never;
const pipe = <T>(schema: never, v: unknown): T => new ZodValidationPipe(schema).transform(v, { type: "body" } as never) as T;

function make() {
  const svc = Object.fromEntries(["create", "list", "get", "preflight", "setBuckets", "start", "verify", "carryConfig", "cancel", "remove"].map((k) => [k, jest.fn().mockResolvedValue({ ok: true })]));
  return { ctl: new ObjectMigrationsController(svc as never), svc };
}

describe("ObjectMigrationsController", () => {
  it("delegates every route with the caller's user id", async () => {
    const { ctl, svc } = make();
    const create = pipe<never>(CreateObjectMigrationSchema as never, { name: "m", targetServerId: "s", source: { endpoint: "https://a.example.com", accessKey: "a", secretKey: "b" }, destination: { endpoint: "http://host.docker.internal:9100", accessKey: "c", secretKey: "d" } });
    await ctl.create(user, create);
    expect(svc.create).toHaveBeenCalledWith("u1", expect.objectContaining({ preserve: true }));
    await ctl.list(user, { teamId: "t1" });
    expect(svc.list).toHaveBeenCalledWith("u1", "t1");
    await ctl.list(user, {});
    expect(svc.list).toHaveBeenLastCalledWith("u1", undefined);
    await ctl.get(user, "m1");
    await ctl.preflight(user, "m1");
    await ctl.setBuckets(user, "m1", pipe<never>(SetBucketsSchema as never, { buckets: [{ srcBucket: "bk1", selected: true }] }));
    await ctl.start(user, "m1", pipe<never>(StartObjectMigrationSchema as never, { phase: "final", acknowledgeWritesFrozen: true }));
    await ctl.verify(user, "m1");
    await ctl.carryConfig(user, "m1");
    await ctl.cancel(user, "m1");
    await ctl.remove(user, "m1");
    for (const k of ["get", "preflight", "verify", "carryConfig", "cancel", "remove"]) expect(svc[k]).toHaveBeenCalledWith("u1", "m1");
    expect(svc.start).toHaveBeenCalledWith("u1", "m1", { phase: "final", acknowledgeWritesFrozen: true });
  });

  it("the pipes reject hostile input before the service is reached", () => {
    expect(() => pipe(CreateObjectMigrationSchema as never, { name: "m", targetServerId: "s", source: { endpoint: "http://127.0.0.1", accessKey: "a", secretKey: "b" }, destination: { endpoint: "https://b.example.com", accessKey: "c", secretKey: "d" } })).toThrow();
    expect(() => pipe(SetBucketsSchema as never, { buckets: [{ srcBucket: "BAD NAME", selected: true }] })).toThrow();
    expect(() => pipe(SetBucketsSchema as never, { buckets: [{ srcBucket: "bk1", selected: true, exclude: ["../x"] }] })).toThrow();
    expect(() => pipe(SetBucketsSchema as never, { buckets: [{ srcBucket: "bk1", selected: true, exclude: ["a;b"] }] })).toThrow();
    expect(() => pipe(StartObjectMigrationSchema as never, { phase: "nuke" })).toThrow();
  });
});
