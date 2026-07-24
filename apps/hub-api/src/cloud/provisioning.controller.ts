import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ProvisioningService } from "./provisioning.service";
import { ProvisionServerInput, ProvisionServerSchema } from "./dto";

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ProvisioningController {
  constructor(private readonly svc: ProvisioningService) {}

  // POST /servers/provision — static segment, never collides with GET/PUT/DELETE /servers/:id.
  @Post("provision")
  @ApiZodBody(ProvisionServerSchema)
  provision(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(ProvisionServerSchema)) body: ProvisionServerInput) {
    return this.svc.provision(user.userId, body);
  }
}
