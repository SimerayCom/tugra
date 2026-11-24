import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app-config";
import { setupOpenApi } from "./openapi/openapi";
import {
  cloudflareClientIpMiddleware,
  cloudflareProxyEnabled,
  parseCloudflareExtraCidrs,
  parseTrustedProxyCidrs,
  strictProxyTrust,
  trustProxyEnabled,
  trustProxyFn,
} from "./common/observed-ip";
import { applyTransferTimeouts } from "./common/http-timeouts";
import { securityHeadersMiddleware } from "./common/security-headers";
import { largeJsonBody } from "./common/large-json";

async function bootstrap() {
  // rawBody is needed to verify HMAC webhook signatures over the exact payload bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // nosniff / no framing / no referrer on every hub response (also reachable on the raw hub port).
  app.use(securityHeadersMiddleware);
  // A monitoring backup can be a few hundred kB: allow 4 MB of JSON for the Uptime Kuma import routes only.
  app.use(largeJsonBody("/api/v1/monitors/import/kuma/", 4 * 1024 * 1024));
  (app.getHttpAdapter().getInstance() as { disable(k: string): void }).disable("x-powered-by");
  // Behind the Next proxy / a reverse proxy the TCP peer is the proxy, so per-IP throttling would bucket every
  // browser user together. Only when the operator declares a proxy (HUB_TRUSTED_PROXY=true) trust exactly ONE
  // hop (req.ip = rightmost X-Forwarded-For entry, same rule as the PAT guard / agent gateway); never blanket-trust.
  // The hop is honored only when the TCP peer is itself a private/loopback/docker peer (or listed in
  // HUB_TRUSTED_PROXY_CIDRS), so a direct public hit on a raw published port cannot forge X-Forwarded-For.
  if (trustProxyEnabled()) {
    (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set("trust proxy", trustProxyFn);
    const cidrs = parseTrustedProxyCidrs();
    // eslint-disable-next-line no-console
    console.log(
      `HUB_TRUSTED_PROXY=true: X-Forwarded-For honored only from private/loopback/docker peers (+HUB_TRUSTED_PROXY_CIDRS=${cidrs.length ? cidrs.join(",") : "none"})${strictProxyTrust() ? " strict=true (only HUB_TRUSTED_PROXY_CIDRS peers are trusted)" : ""}; direct public peers use the socket IP`,
    );
    if (cloudflareProxyEnabled()) {
      // Express derives req.ip (throttling, request logs) from X-Forwarded-For alone, which behind Cloudflare is the
      // edge: replace it with the verified CF-Connecting-IP (see cloudflareClientIpMiddleware) before anything reads it.
      app.use(cloudflareClientIpMiddleware);
      // eslint-disable-next-line no-console
      console.log(
        `HUB_TRUSTED_PROXY_CLOUDFLARE=true: CF-Connecting-IP honored only when the observed hop is a published Cloudflare edge range (+${parseCloudflareExtraCidrs().length} extra); any other source keeps its own address`,
      );
    }
  }
  configureApp(app); // /api/v1 prefix (+ webhook/oauth/health/version exemptions)
  // Mount Swagger UI (/api/docs) + the JSON contract (/api/v1/openapi.json) after the prefix is applied.
  setupOpenApi(app);
  // Expose the custom response headers so browser (cross-origin) clients can read them; origin/credentials
  // behaviour is unchanged (bare defaults). Covers pagination + the existing per-PAT rate-limit headers.
  app.enableCors({
    exposedHeaders: [
      "X-Total-Count",
      "X-Limit",
      "X-Next-Cursor",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
      "X-Tugra-Audit-Truncated", // the Pro audit export flags a capped result here (readable cross-origin)
    ],
  });
  // File uploads/downloads can take minutes: don't let Node's 300 s request timeout cut a large body mid-stream.
  applyTransferTimeouts(app.getHttpServer());
  const port = process.env.HUB_PORT ? Number(process.env.HUB_PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Tugra hub-api listening on :${port}`);
}

void bootstrap();
