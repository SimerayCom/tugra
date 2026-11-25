import { Injectable } from "@nestjs/common";

/**
 * Campaigns of guided runs (Coolify hub takeover, lane E): group a mixed placement into one run per source server, in waves, and keep the
 * `MigrationCampaign` row beside the runs' `campaign` label. An empty skeleton; lane E owns this module. Owner-only and audited.
 */
@Injectable()
export class MigrationCampaignsService {}
