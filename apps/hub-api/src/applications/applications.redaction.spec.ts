import "reflect-metadata";
import { lastValueFrom, of } from "rxjs";
import { ApplicationsController } from "./applications.controller";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";

const redactor = (): RedactSecretsInterceptor => {
  const list = (Reflect.getMetadata("__interceptors__", ApplicationsController) ?? []) as unknown[];
  return list.find((i) => i instanceof RedactSecretsInterceptor) as RedactSecretsInterceptor;
};
const ctx = (scopes: string[]) => ({ getType: () => "http", switchToHttp: () => ({ getRequest: () => ({ user: { scopes } }) }) }) as never;

describe("ApplicationsController secret redaction", () => {
  it("nulls customLabels (values can be tokens) for a PAT without read:secrets, keeps it for read:secrets and sessions", async () => {
    const view = { id: "a", customLabels: { token: "tok_x" }, webhookSecret: "w", inlineDockerfile: "FROM x" };
    const out = (await lastValueFrom(redactor().intercept(ctx(["read"]), { handle: () => of(view) }))) as Record<string, unknown>;
    expect(out.customLabels).toBeNull();
    expect(out.webhookSecret).toBeNull();
    const full = await lastValueFrom(redactor().intercept(ctx(["read", "read:secrets"]), { handle: () => of(view) }));
    expect(full).toEqual(view);
    expect(await lastValueFrom(redactor().intercept(ctx(["*"]), { handle: () => of(view) }))).toEqual(view);
  });

  it("GET /apps/:id/labels needs read:secrets (its custom / fromDockerOptions values are nested, so the interceptor cannot null them)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ApplicationsController.prototype.getLabels)).toEqual(["read:secrets"]);
  });
});
