import { rewriteHostPorts } from "./install-compose";
import type { ExposePort } from "./template-manifest";

const exposure = (over: Partial<ExposePort> & { serviceName: string; containerPort: number }): ExposePort => ({
  defaultMode: "domain",
  public: true,
  ...over,
});

describe("rewriteHostPorts", () => {
  it("rewrites the baked host port in the ports line AND in localhost self-URLs, and returns the mapping", () => {
    const compose = [
      "services:",
      "  gitea:",
      "    image: gitea/gitea",
      "    environment:",
      "      - FQDN_GITEA_3000=localhost:20084",
      "      - GITEA__ROOT_URL=http://localhost:20084/",
      "    ports:",
      '      - "20084:3000"',
      "",
    ].join("\n");
    const { compose: out, portMappings } = rewriteHostPorts(compose, [exposure({ serviceName: "gitea", containerPort: 3000 })], [20500]);
    expect(out).toContain('"20500:3000"'); // ports line rewritten
    expect(out).not.toContain("20084"); // old host port gone everywhere
    expect(out).toContain("localhost:20500"); // self-URLs follow the allocated port
    expect(out).toContain("http://localhost:20500/");
    expect(portMappings).toEqual([{ serviceName: "gitea", containerPort: 3000, hostPort: 20500, mode: "domain" }]);
  });

  it("installing the same template twice yields distinct published ports", () => {
    const compose = 'services:\n  app:\n    image: x\n    ports:\n      - "20001:80"\n';
    const first = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20300]);
    const second = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20301]);
    expect(first.compose).toContain('"20300:80"');
    expect(second.compose).toContain('"20301:80"');
    expect(first.portMappings[0].hostPort).not.toBe(second.portMappings[0].hostPort);
  });

  it("does not corrupt a longer host port that shares a prefix (word boundary on localhost)", () => {
    const compose = 'services:\n  app:\n    environment:\n      - A=localhost:20084\n      - B=localhost:200849\n    ports:\n      - "20084:80"\n';
    const { compose: out } = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500]);
    expect(out).toContain("A=localhost:20500"); // rewritten
    expect(out).toContain("B=localhost:200849"); // NOT corrupted (different port)
  });

  it("anchors the container port so a shorter port never matches a longer one", () => {
    // containerPort 80 must NOT match the ":8080" line
    const compose = 'services:\n  app:\n    ports:\n      - "20001:8080"\n';
    const { compose: out, portMappings } = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500]);
    expect(out).toContain('"20001:8080"'); // untouched (no :80" match)
    expect(portMappings).toEqual([]); // nothing rewritten
  });

  it("is a no-op when there are no exposures (port-less game/system servers)", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const { compose: out, portMappings } = rewriteHostPorts(compose, [], []);
    expect(out).toBe(compose);
    expect(portMappings).toEqual([]);
  });

  it("carries the hostPort mode through from the exposure", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const { portMappings } = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80, defaultMode: "hostPort" })], [20500]);
    expect(portMappings[0].mode).toBe("hostPort");
  });
});
