import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { CatalogModule } from "../catalog/catalog.module";
import { ApplicationsModule } from "../applications/applications.module";
import { DatabasesModule } from "../databases/databases.module";

@Module({
  // ApplicationsModule + DatabasesModule power environment clone (it reuses app/db clone). No cycle: neither
  // module imports ProjectsModule.
  imports: [CatalogModule, ApplicationsModule, DatabasesModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
