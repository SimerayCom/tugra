import { Module } from "@nestjs/common";
import { SavedViewsController } from "./saved-views.controller";
import { SavedViewsService } from "./saved-views.service";

@Module({
  controllers: [SavedViewsController],
  providers: [SavedViewsService],
})
export class SavedViewsModule {}
