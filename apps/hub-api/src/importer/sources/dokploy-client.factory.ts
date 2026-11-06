import { Injectable } from "@nestjs/common";
import { DokployHttpClient } from "./dokploy-http";
import type { DokployClient } from "./dokploy.source";

/** Builds the live Dokploy HTTP client. A separate injectable so the source stays unit-testable with a fake. */
@Injectable()
export class DokployClientFactory {
  create(baseUrl: string, apiKey: string): DokployClient {
    return new DokployHttpClient(baseUrl, apiKey);
  }
}
