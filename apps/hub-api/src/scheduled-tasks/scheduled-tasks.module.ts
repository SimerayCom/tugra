import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ScheduledTasksController } from "./scheduled-tasks.controller";
import { ScheduledTasksService } from "./scheduled-tasks.service";
import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";
import { ScheduledTasksSchedulerService } from "./scheduled-tasks.scheduler.service";

@Module({
  imports: [AgentGatewayModule, NotificationsModule],
  controllers: [ScheduledTasksController],
  providers: [ScheduledTasksService, ScheduledTaskRunnerService, ScheduledTasksSchedulerService],
  exports: [ScheduledTasksService],
})
export class ScheduledTasksModule {}
