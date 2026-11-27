import { Global, Module } from "@nestjs/common";
import { InFlightService } from "./in-flight.service";
import { InFlightRegistry } from "./in-flight.registry";

/** The "what is running right now" read used by the hub and agent updates, and the registry for work that only lives in this process. Global: the registry is injected where the work happens. */
@Global()
@Module({ providers: [InFlightService, InFlightRegistry], exports: [InFlightService, InFlightRegistry] })
export class InFlightModule {}
