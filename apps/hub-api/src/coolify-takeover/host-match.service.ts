import { Injectable } from "@nestjs/common";

/**
 * Which Tugra server is the same machine as a Coolify server (Coolify hub takeover, lane D): the I/O half around the pure `matchHosts`
 * function (loads candidate servers and their reported facts, never lets a caller without `servers:manage` auto-link). An empty
 * skeleton; lane D owns this file and `host-match.ts`.
 */
@Injectable()
export class HostMatchService {}
