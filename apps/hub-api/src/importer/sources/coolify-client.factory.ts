import { Injectable } from "@nestjs/common";
import { CoolifyHttpClient } from "./coolify-http";
import type { CoolifyClient } from "./coolify.source";
import { EgressIpService } from "../egress-ip.service";

/** Builds the live Coolify HTTP client. A separate injectable so services stay unit-testable with a fake. */
@Injectable()
export class CoolifyClientFactory {
  // Optional so a spec can `new CoolifyClientFactory()`; the module always provides it, and a 403 hint then names this hub's address.
  constructor(private readonly egress?: EgressIpService) {}

  create(baseUrl: string, token: string): CoolifyClient {
    return new CoolifyHttpClient(baseUrl, token, { egressIp: this.egress ? () => this.egress!.ip() : undefined });
  }
}
