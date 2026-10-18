import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app-config";
import { setupOpenApi } from "./openapi/openapi";

async function bootstrap() {
  // rawBody is needed to verify HMAC webhook signatures over the exact payload bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
    ],
  });
  const port = process.env.HUB_PORT ? Number(process.env.HUB_PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Tugra hub-api listening on :${port}`);
}

void bootstrap();
