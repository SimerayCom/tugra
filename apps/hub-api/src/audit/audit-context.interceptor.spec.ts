import { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";
import { AuditContextInterceptor } from "./audit-context.interceptor";
import { auditContext } from "./audit-context";

function ctxFor(user: unknown, type: "http" | "ws" = "http"): ExecutionContext {
  const req = { user };
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

// The handler reports the audit context visible to it at execution time.
const handler: CallHandler = { handle: () => of(auditContext.getStore()) };
const run = (ctx: ExecutionContext) => lastValueFrom(new AuditContextInterceptor().intercept(ctx, handler));

describe("AuditContextInterceptor", () => {
  it("runs the handler inside a PAT context (via + tokenId)", async () => {
    expect(await run(ctxFor({ userId: "u1", scopes: ["read"], tokenId: "tok1" }))).toEqual({ via: "pat", tokenId: "tok1" });
  });

  it("runs the handler inside a session context (no tokenId)", async () => {
    expect(await run(ctxFor({ userId: "u1", scopes: ["*"] }))).toEqual({ via: "session" });
  });

  it("establishes no context for a public route (no user)", async () => {
    expect(await run(ctxFor(undefined))).toBeUndefined();
  });

  it("does not touch non-HTTP contexts", async () => {
    expect(await run(ctxFor({ userId: "u1", tokenId: "tok1" }, "ws"))).toBeUndefined();
  });
});
