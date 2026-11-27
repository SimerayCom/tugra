import { Injectable } from "@nestjs/common";
import { CaproverHttpClient, caproverLogin } from "./caprover-http";
import type { CaproverClient } from "./caprover.source";

/** Builds the live CapRover HTTP client and does the login. A separate injectable so the source stays unit-testable with a fake. */
@Injectable()
export class CaproverClientFactory {
  create(baseUrl: string, token: string): CaproverClient {
    return new CaproverHttpClient(baseUrl, token);
  }

  /** Password in, login token out. The password is used for this one request only. */
  login(baseUrl: string, password: string): Promise<string> {
    return caproverLogin(baseUrl, password);
  }
}
