import { Global, Module } from "@nestjs/common";
import { QueueHubService } from "./queue-hub.service";
import { TickSchedulerService } from "./tick-scheduler.service";

/** Shared BullMQ plumbing: one Redis connection for every queue, and the single scheduler queue + worker for periodic ticks. */
@Global()
@Module({
  providers: [QueueHubService, TickSchedulerService],
  exports: [QueueHubService, TickSchedulerService],
})
export class SchedulerModule {}
