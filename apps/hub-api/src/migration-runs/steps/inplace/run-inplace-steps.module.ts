import { Module } from "@nestjs/common";
import { CoolifyInPlaceModule } from "../../../coolify-inplace/coolify-inplace.module";
import { InPlaceRunSteps } from "./inplace-run.steps";

/**
 * The in-place side of DEPLOY_DARK and VERIFY: one small injectable over the takeover service's run port, shared by the import-side and
 * the data-side step modules. (CUTOVER's in-place side is provided by the cutover step module, which also owns the swap record.)
 */
@Module({ imports: [CoolifyInPlaceModule], providers: [InPlaceRunSteps], exports: [InPlaceRunSteps] })
export class RunInPlaceStepsModule {}
