import { Injectable } from "@nestjs/common";
import { CoolifyHttpClient } from "./coolify-http";
import type { CoolifyClient } from "./coolify.source";

/** Builds the live Coolify HTTP client. A separate injectable so services stay unit-testable with a fake. */
@Injectable()
export class CoolifyClientFactory {
  create(baseUrl: string, token: string): CoolifyClient {
    return new CoolifyHttpClient(baseUrl, token);
  }
}
