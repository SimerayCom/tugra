import { DB_NET } from "../databases/database-script";
import { PROXY_NETWORK } from "./deploy-script";
import { PANEL_NETWORK } from "./panel-router";
import { SWARM_OVERLAY } from "./service-script";
import { APPS_NETWORK, RESERVED_NETWORK_NAMES, isUserNetworkNameAllowed } from "./network-names";

describe("network-names", () => {
  it("reserved literals equal the real Tugra network constants (drift guard)", () => {
    for (const n of [PROXY_NETWORK, DB_NET, SWARM_OVERLAY, PANEL_NETWORK]) {
      expect(RESERVED_NETWORK_NAMES.has(n)).toBe(true);
    }
  });

  it("never reserves the shared apps bridge itself", () => {
    expect(RESERVED_NETWORK_NAMES.has(APPS_NETWORK)).toBe(false);
    expect(isUserNetworkNameAllowed(APPS_NETWORK)).toBe(true);
  });

  it("allows ordinary names, refuses built-ins and tugra-/tugra_ prefixes", () => {
    expect(isUserNetworkNameAllowed("db-net")).toBe(true);
    expect(isUserNetworkNameAllowed("backend")).toBe(true);
    for (const n of ["bridge", "host", "none", "tugra-net", "tugra-proxy", "tugra-other", "Tugra_x", "ingress"]) {
      expect(isUserNetworkNameAllowed(n)).toBe(false);
    }
  });
});
