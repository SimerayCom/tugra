import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = process.env.HUB_PORT ? Number(process.env.HUB_PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Tugra hub-api listening on :${port}`);
}

void bootstrap();
