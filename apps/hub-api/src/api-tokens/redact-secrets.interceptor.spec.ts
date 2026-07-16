import { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { RedactSecretsInterceptor } from "./redact-secrets.interceptor";

function ctxFor(scopes: string[]): ExecutionContext {
  const req = { user: { scopes } };
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function handlerOf(body: unknown): CallHandler {
  return { handle: () => of(body) };
}

async function run(interceptor: RedactSecretsInterceptor, scopes: string[], body: unknown) {
  return lastValueFrom(interceptor.intercept(ctxFor(scopes), handlerOf(body)));
}

describe("RedactSecretsInterceptor", () => {
  const interceptor = new RedactSecretsInterceptor(["password", "connectionUri"]);

  it("nulls named fields for a scope-limited token that cannot read secrets", async () => {
    const out = await run(interceptor, ["read", "write"], { id: "d1", password: "hunter2", connectionUri: "postgres://x", host: "db" });
    expect(out).toEqual({ id: "d1", password: null, connectionUri: null, host: "db" });
  });

  it("leaves the payload untouched for read:secrets, admin, and session ['*']", async () => {
    const body = { id: "d1", password: "hunter2", connectionUri: "postgres://x" };
    for (const scopes of [["read:secrets"], ["admin"], ["*"]]) {
      expect(await run(interceptor, scopes, { ...body })).toEqual(body);
    }
  });

  it("redacts each element of an array response", async () => {
    const out = await run(interceptor, ["read"], [
      { id: "a", password: "p1" },
      { id: "b", password: "p2" },
    ]);
    expect(out).toEqual([
      { id: "a", password: null },
      { id: "b", password: null },
    ]);
  });

  it("is a no-op when the fields are absent", async () => {
    const out = await run(interceptor, ["read"], { id: "x", name: "no-secrets-here" });
    expect(out).toEqual({ id: "x", name: "no-secrets-here" });
  });

  it("passes primitives / null bodies through unchanged", async () => {
    expect(await run(interceptor, ["read"], null)).toBeNull();
    expect(await run(interceptor, ["read"], "ok")).toBe("ok");
  });

  it("does not mutate the original object (fresh copy per request)", async () => {
    const original = { id: "d1", password: "hunter2" };
    await run(interceptor, ["read"], original);
    expect(original.password).toBe("hunter2");
  });
});
