import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guard for the "no update ping, IP probe or version checks by default" trust-wedge. The infra files below (shell + docker + compose)
// are not otherwise exercised by jest, so a future edit could silently re-introduce a default-on outbound
// call and quietly make the claim false again. These static assertions fail CI if that happens. The Traefik
// proxy flags are covered separately by deploy-script.spec.ts + swarm-proxy-script.spec.ts.
const ROOT = resolve(__dirname, "../../../.."); // apps/hub-api/src/deploy -> repo root
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("outbound guard — no update ping, IP probe or version checks by default", () => {
  const install = read("scripts/install.sh");
  const dockerHub = read("deploy/Dockerfile.hub");
  const dockerWeb = read("deploy/Dockerfile.web");
  const compose = read("deploy/docker-compose.yml");

  it("install.sh writes the update-manifest channel ONLY inside the --enable-update-checks opt-in (not by default)", () => {
    // the two ensure_env lines must sit immediately under the opt-in guard, never unconditionally
    expect(install).toMatch(/if \[ "\$ENABLE_UPDATE_CHECKS" = "1" \]; then\s+ensure_env UPDATE_MANIFEST_URL/);
    // exactly one occurrence, so there is no second, ungated one
    expect(install.match(/ensure_env UPDATE_MANIFEST_URL/g)).toHaveLength(1);
    expect(install.match(/ensure_env UPDATE_PUBLISHER_KEY/g)).toHaveLength(1);
  });

  // NB: anonymous usage stats (TUGRA_TELEMETRY) are intentionally ON by default (opt-out) — a product
  // decision, so they are NOT part of this opt-in outbound guard. Their off-switch
  // (--no-telemetry / TUGRA_TELEMETRY=0) is covered by hub-install-script.spec.

  it("install.sh runs the public-IP probe ONLY inside the --detect-public-ip opt-in", () => {
    // the ipify/ifconfig/icanhazip chain must appear AFTER (inside) the detect guard
    expect(install).toMatch(/\[ "\$DETECT_PUBLIC_IP" = "1" \][\s\S]*api\.ipify\.org/);
    // and not be reachable without it: the probe hosts occur exactly once, in that block
    expect(install.match(/api\.ipify\.org/g)).toHaveLength(1);
  });

  it("the hub image AND compose disable the Prisma checkpoint version-ping (every boot runs `prisma migrate deploy`)", () => {
    expect(dockerHub).toContain("CHECKPOINT_DISABLE=1");
    expect(compose).toContain('CHECKPOINT_DISABLE: "1"'); // also on already-pulled images, via the compose env block
  });

  it("the web image disables Next.js build telemetry", () => {
    expect(dockerWeb).toContain("NEXT_TELEMETRY_DISABLED=1");
  });
});
