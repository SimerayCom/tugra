import {
  buildTunnelSetupScript,
  buildTunnelStopScript,
  buildTunnelStatusScript,
  buildTunnelLogsScript,
  TUNNEL_CONTAINER_NAME,
  TUNNEL_ENV_PATH,
  DEFAULT_CLOUDFLARED_IMAGE,
} from "./tunnel-script";

describe("buildTunnelSetupScript", () => {
  it("writes the connector token to a 0600 --env-file, never as a plaintext CLI arg", () => {
    const s = buildTunnelSetupScript({ token: "cf-secret-token" });
    // The token must never appear in plaintext (it's base64-encoded into the env file),
    // so `ps aux` / `docker inspect` on the host can't reveal it.
    expect(s).not.toContain("cf-secret-token");
    expect(s).not.toContain("--token");
    expect(s).toContain(`--env-file ${TUNNEL_ENV_PATH}`);
    expect(s).toContain(`chmod 600 ${TUNNEL_ENV_PATH}`);
    // The transported base64 decodes to TUNNEL_TOKEN=<token>.
    const enc = Buffer.from("TUNNEL_TOKEN=cf-secret-token\n", "utf8").toString("base64");
    expect(s).toContain(enc);
  });

  it("runs cloudflared on the tugra-proxy network so it can reach Traefik by name", () => {
    const s = buildTunnelSetupScript({ token: "t" });
    expect(s).toContain("--network tugra-proxy");
    expect(s).toContain("tunnel --no-autoupdate run");
  });

  it("is idempotent: creates the network and removes any pre-existing connector before running", () => {
    const s = buildTunnelSetupScript({ token: "t" });
    expect(s).toContain("docker network create tugra-proxy 2>/dev/null || true");
    expect(s).toContain(`docker rm -f ${TUNNEL_CONTAINER_NAME} 2>/dev/null || true`);
    expect(s.indexOf("docker rm -f")).toBeLessThan(s.indexOf("docker run -d"));
  });

  it("uses the pinned default image, or an override when given", () => {
    expect(buildTunnelSetupScript({ token: "t" })).toContain(DEFAULT_CLOUDFLARED_IMAGE);
    expect(buildTunnelSetupScript({ token: "t", image: "cloudflare/cloudflared:pinned" })).toContain(
      "cloudflare/cloudflared:pinned",
    );
  });

  it("sets --restart unless-stopped and --no-autoupdate (Tugra controls the image, not cloudflared)", () => {
    const s = buildTunnelSetupScript({ token: "t" });
    expect(s).toContain("--restart unless-stopped");
    expect(s).toContain("--no-autoupdate");
  });
});

describe("buildTunnelStopScript", () => {
  it("removes the container and wipes the token env-file, tolerating an absent container", () => {
    const s = buildTunnelStopScript();
    expect(s).toContain(`docker rm -f ${TUNNEL_CONTAINER_NAME} 2>/dev/null || true`);
    expect(s).toContain(`rm -f ${TUNNEL_ENV_PATH}`);
  });
});

describe("buildTunnelStatusScript", () => {
  it("reports absent when the connector doesn't exist", () => {
    const s = buildTunnelStatusScript();
    expect(s).toContain(TUNNEL_CONTAINER_NAME);
    expect(s).toContain("|| echo absent");
  });
});

describe("buildTunnelLogsScript", () => {
  it("tails the connector logs, clamping tail to [1,1000]", () => {
    expect(buildTunnelLogsScript(50)).toContain("--tail 50");
    expect(buildTunnelLogsScript(99999)).toContain("--tail 1000");
    expect(buildTunnelLogsScript(0)).toContain("--tail 1");
  });
});
