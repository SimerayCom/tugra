import { Controller, Get } from "@nestjs/common";
import { PROTOCOL_VERSION, appVersion } from "@tugra/shared";

@Controller("health")
export class HealthController {
  @Get()
  check() {
    return {
      status: "ok",
      service: "tugra-hub-api",
      version: appVersion(),
      protocol: PROTOCOL_VERSION,
      time: new Date().toISOString(),
    };
  }
}
