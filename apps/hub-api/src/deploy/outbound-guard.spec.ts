import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyUpdateCheckDefaults, OFFICIAL_UPDATE_MANIFEST_URL } from "../config/env";

// Guard for the outbound trust-wedge: no IP probe or unsigned outbound call by default, and the ONE default-on
// outbound call (the signed, identifier-free release-manifest check) has a hard off switch that is honoured
// everywhere. The infra files below (shell + docker + compose) are not otherwise exercised by jest, so a
// future edit could silently re-introduce an ungated outbound call and quietly make the claim false again.
// These static assertions fail CI if that happens. The Traefik proxy flags are covered separately by
// deploy-script.spec.ts + swarm-proxy-script.spec.ts.
const ROOT = resolve(__dirname, "../../../.."); // apps/hub-api/src/deploy -> repo root
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("outbound guard — no IP probe or unsigned outbound by default; update checks honour the hard off", () => {
  const install = read("scripts/install.sh");
  const dockerHub = read("deploy/Dockerfile.hub");
  const dockerWeb = read("deploy/Dockerfile.web");
  const compose = read("deploy/docker-compose.yml");

  it("install.sh never writes a manifest URL/key itself (the official pair is built into the hub) and --no-update-checks writes the hard off", () => {
    // No installer-written manifest source: an operator's own UPDATE_MANIFEST_URL/KEY pair in .env is the only
    // way to point a hub elsewhere, and the installer must never plant one behind the operator's back.
    expect(install).not.toMatch(/(ensure_env|set_env) +UPDATE_MANIFEST_URL/);
    expect(install).not.toMatch(/(ensure_env|set_env) +UPDATE_PUBLISHER_KEY/);
    // The opt-out is a real, persisted switch (set_env so it overrides a stored value), reachable by flag and env.
    expect(install).toMatch(/--no-update-checks\)\s+NO_UPDATE_CHECKS=1/);
    expect(install).toMatch(/if \[ "\$NO_UPDATE_CHECKS" = "1" \]; then set_env TUGRA_UPDATE_CHECKS "0"/);
  });

  it("the hub applies the built-in manifest defaults only when the operator set neither value, never under TUGRA_UPDATE_CHECKS=0", () => {
    // default-on: both absent → official pair injected
    expect(applyUpdateCheckDefaults({})).toMatchObject({ UPDATE_MANIFEST_URL: OFFICIAL_UPDATE_MANIFEST_URL });
    // hard off: nothing injected, so the scheduler and the stale refresh stay inert (env.ts fail-closed)
    expect(applyUpdateCheckDefaults({ TUGRA_UPDATE_CHECKS: "0" })).toEqual({ TUGRA_UPDATE_CHECKS: "0" });
    // an operator's own source is never overridden or half-completed
    const own = { UPDATE_MANIFEST_URL: "https://mirror.example/versions.json", UPDATE_PUBLISHER_KEY: "custom" };
    expect(applyUpdateCheckDefaults(own)).toEqual(own);
    expect(applyUpdateCheckDefaults({ UPDATE_PUBLISHER_KEY: "custom" })).toEqual({ UPDATE_PUBLISHER_KEY: "custom" });
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
