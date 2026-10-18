import { BadRequestException, Injectable } from "@nestjs/common";
import { MigratorService } from "../migrator/migrator.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { planImport } from "./import-planner";
import type { ImportSource } from "./import-source";
import type { ImportPlan } from "./foreign-fleet";
import type { ImportPlanRequestInput } from "./dto";

/**
 * Importer orchestration. For now it exposes only the DRY-RUN plan: build the requested source adapter,
 * `discover()` a secret-free {@link import("./foreign-fleet").ForeignFleet}, and run the pure planner. The
 * executor (apply/status/rollback) and the encrypted remote-session store land in S4c.
 *
 * Authorization is delegated to the adapter: the local-docker source reuses {@link MigratorService.discover},
 * which enforces the caller's `apps:config` permission on the server and blanks env VALUES on the wire.
 */
@Injectable()
export class ImporterService {
  constructor(private readonly migrator: MigratorService) {}

  async plan(userId: string, input: ImportPlanRequestInput): Promise<ImportPlan> {
    const source = this.sourceFor(userId, input);
    try {
      const fleet = await source.discover();
      return planImport(fleet, { sourceKind: input.sourceKind, targetServerId: input.serverId });
    } finally {
      await source.close();
    }
  }

  private sourceFor(userId: string, input: ImportPlanRequestInput): ImportSource {
    switch (input.sourceKind) {
      case "local-docker":
        return new LocalDockerSource(this.migrator, userId, input.serverId);
      default:
        // Unreachable via the controller (the DTO is a literal), but keep the service safe if called directly.
        throw new BadRequestException(`unsupported import source: ${input.sourceKind}`);
    }
  }
}
