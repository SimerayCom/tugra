import { buildAppliedLabels, type AppliedLabelsInput } from "./applied-labels";
import { AppLabelsViewSchema } from "./dto";
import { RESERVED_LABEL_PREFIXES } from "../deploy/label-namespaces";

const label = (over: Partial<AppliedLabelsInput["label"]> = {}): AppliedLabelsInput["label"] => ({
  id: "abc",
  source: "IMAGE",
  domain: "app.example.com",
  certType: "le-http",
  containerPort: 8080,
  dbNetwork: false,
  networks: [],
  containerAlias: null,
  dockerOptions: null,
  ...over,
});
const input = (over: Partial<AppliedLabelsInput> = {}): AppliedLabelsInput => ({
  source: "IMAGE",
  clusterId: null,
  isPreview: false,
  label: label(),
  composeWebService: null,
  serviceDomains: [],
  configMounts: [],
  customLabels: null,
  rollingEligible: false,
  ...over,
});
const keys = (v: ReturnType<typeof buildAppliedLabels>) => v.tugra.map((t) => t.key);

describe("buildAppliedLabels", () => {
  it("classic with a domain: traefik routing under scope container, schema-valid, editable", () => {
    const v = buildAppliedLabels(input());
    expect(AppLabelsViewSchema.parse(v)).toEqual(v);
    expect(v).toMatchObject({ engine: "docker", editable: true, editableReason: null, applyMode: "next_deploy", fromDockerOptions: [] });
    expect(v.tugra.every((t) => t.scope === "container")).toBe(true);
    expect(v.tugra.find((t) => t.key === "traefik.enable")).toMatchObject({ value: "true", purpose: "traefik_routing", masked: false });
    expect(keys(v)).toContain("traefik.http.routers.tugra_abc.rule");
    expect(v.notes).toEqual([]);
  });

  it("classic without a domain lists nothing but the alias and notes needs_domain", () => {
    const v = buildAppliedLabels(input({ label: label({ domain: null }) }));
    expect(v.tugra).toEqual([]);
    expect(v.notes).toContain("needs_domain");
  });

  it("dbNetwork adds the proxy-network pin, an alias adds tugra.alias, a rolling-eligible app is noted", () => {
    const v = buildAppliedLabels(input({ label: label({ dbNetwork: true, containerAlias: "web" }), rollingEligible: true }));
    expect(v.tugra.find((t) => t.key === "traefik.docker.network")).toMatchObject({ value: "tugra-proxy", purpose: "proxy_network_pin" });
    expect(v.tugra.find((t) => t.key === "tugra.alias")).toMatchObject({ value: "web", purpose: "alias" });
    expect(v.notes).toContain("rolling_health_labels");
  });

  it("a raw --network in dockerOptions suppresses the alias line (same predicate as the deploy script)", () => {
    const v = buildAppliedLabels(input({ label: label({ domain: null, containerAlias: "web", dockerOptions: "--network host" }) }));
    expect(keys(v)).not.toContain("tugra.alias");
  });

  it("masks basic-auth hashes and the forward-auth address; the raw values never appear", () => {
    const v = buildAppliedLabels(
      input({ label: label({ basicAuthUsers: [{ user: "u", hash: "$2b$RAWHASH" }], forwardAuth: "https://auth/verify?tok=RAWTOKEN", redirects: [{ regex: "^/a$", replacement: "/b", permanent: true }] }) }),
    );
    const ba = v.tugra.find((t) => t.key.endsWith(".basicauth.users"))!;
    const fa = v.tugra.find((t) => t.key.endsWith(".forwardauth.address"))!;
    expect(ba).toMatchObject({ value: null, masked: true });
    expect(fa).toMatchObject({ value: null, masked: true });
    expect(JSON.stringify(v)).not.toContain("RAWHASH");
    expect(JSON.stringify(v)).not.toContain("RAWTOKEN");
    // redirect regexes are shown
    expect(v.tugra.find((t) => t.key.endsWith("redirectregex.regex"))?.value).toBe("^/a$");
  });

  it("lists custom labels sorted and the labels already in dockerOptions", () => {
    const v = buildAppliedLabels(input({ customLabels: { b: "2", a: "1" }, label: label({ dockerOptions: "--label x=1 -l y=2 --memory=64m" }) }));
    expect(v.custom).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }]);
    expect(v.fromDockerOptions).toEqual([{ key: "x", value: "1" }, { key: "y", value: "2" }]);
  });

  it("a malformed stored dockerOptions never breaks the view", () => {
    expect(() => buildAppliedLabels(input({ label: label({ dockerOptions: '--label "x' }) }))).not.toThrow();
  });

  it("compose: per-service scopes, config-mount fingerprints, not editable, unescaped $", () => {
    const v = buildAppliedLabels(
      input({
        source: "COMPOSE",
        label: label({ source: "COMPOSE", basicAuthUsers: [{ user: "u", hash: "$2b$x" }] }),
        composeWebService: "web",
        serviceDomains: [{ service: "api", hostname: "y.example.com", port: 82 }],
        configMounts: [{ serviceName: "api", target: "/c.conf", content: "hi" }],
      }),
    );
    expect(v).toMatchObject({ engine: "compose", editable: false, editableReason: "compose" });
    expect(new Set(v.tugra.map((t) => t.scope))).toEqual(new Set(["service:web", "service:api"]));
    expect(v.tugra.find((t) => t.key === "tugra.config-mount.0")).toMatchObject({ scope: "service:api", purpose: "config_mount_fp" });
    expect(v.tugra.find((t) => t.key.endsWith("basicauth.users"))).toMatchObject({ masked: true, value: null });
    expect(v.notes).toEqual(expect.arrayContaining(["compose_user_labels", "image_labels_not_shown"]));
    expect(v.custom).toEqual([]);
  });

  it("swarm: routed gets swarm-service scope, unrouted is noted; custom labels are listed; swarm notes always", () => {
    const routed = buildAppliedLabels(input({ clusterId: "c1", customLabels: { team: "core" } }));
    expect(routed.engine).toBe("swarm");
    expect(routed.editable).toBe(true);
    expect(routed.tugra.length).toBeGreaterThan(0);
    expect(routed.tugra.every((t) => t.scope === "swarm-service")).toBe(true);
    expect(routed.custom).toEqual([{ key: "team", value: "core" }]);
    expect(routed.fromDockerOptions).toEqual([]);
    expect(routed.notes).toEqual(expect.arrayContaining(["swarm_container_labels", "swarm_runtime_labels"]));
    const bare = buildAppliedLabels(input({ clusterId: "c1", label: label({ domain: null }) }));
    expect(bare.tugra).toEqual([]);
    expect(bare.notes).toContain("needs_domain");
  });

  it("a preview is read-only", () => {
    expect(buildAppliedLabels(input({ isPreview: true }))).toMatchObject({ editable: false, editableReason: "preview" });
  });

  it("always carries the reserved prefixes, limits and key pattern for the web", () => {
    const v = buildAppliedLabels(input());
    expect(v.reservedPrefixes).toEqual([...RESERVED_LABEL_PREFIXES]);
    expect(v.limits).toMatchObject({ maxCount: 32, keyMax: 128, valueMax: 1024, totalBytes: 16384 });
    expect(new RegExp(v.limits.keyPattern).test("ok.key")).toBe(true);
    expect(new RegExp(v.limits.keyPattern).test("-bad")).toBe(false);
  });
});
