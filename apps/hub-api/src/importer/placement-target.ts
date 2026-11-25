import { UnprocessableEntityException } from "@nestjs/common";

/**
 * A server an import places apps on must be able to take them now: its agent ONLINE and the `deploy` capability granted. The same
 * rule for every entry point (the wizard, the API, MCP), so a dead or locked-down target is a clear 422 before anything is created.
 * A row that does not report a field (a test double) is not judged on it.
 */
export function assertPlacementTargetReady(srv: { id: string; status?: string; capabilities?: string[] }): void {
  if (srv.status === "PENDING") throw new UnprocessableEntityException({ statusCode: 422, message: "the target server has not connected its agent yet", code: "import.target_pending", serverId: srv.id });
  if (srv.status !== undefined && srv.status !== "ONLINE") throw new UnprocessableEntityException({ statusCode: 422, message: "the target server is offline", code: "import.target_offline", serverId: srv.id });
  if (srv.capabilities !== undefined && !srv.capabilities.includes("deploy")) {
    throw new UnprocessableEntityException({ statusCode: 422, message: "the target server's agent has no deploy capability", code: "import.target_capability", serverId: srv.id, capability: "deploy" });
  }
}
