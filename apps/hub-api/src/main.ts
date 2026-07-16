import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app-config";

async function bootstrap() {
  // rawBody is needed to verify HMAC webhook signatures over the exact payload bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app); // /api/v1 prefix (+ webhook/oauth/health/version exemptions)
  app.enableCors();
  const port = process.env.HUB_PORT ? Number(process.env.HUB_PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Tugra hub-api listening on :${port}`);
}

void bootstrap();
