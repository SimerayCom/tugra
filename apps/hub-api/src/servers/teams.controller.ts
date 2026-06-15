import { Controller, Get, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ServersService } from "./servers.service";

@Controller("teams")
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.servers.listTeamsForUser(user.userId);
  }
}
