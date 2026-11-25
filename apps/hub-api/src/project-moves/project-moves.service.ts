import { Injectable } from "@nestjs/common";

/**
 * Move a project and everything under it (apps, databases, services, volumes, domains) from one Tugra server to another (lane H),
 * composing the existing app move and database move, with the verification report, a temporary address, DNS and a 7-day safety copy.
 * An empty skeleton; lane H owns this module. Team OWNER only, audited.
 */
@Injectable()
export class ProjectMovesService {}
