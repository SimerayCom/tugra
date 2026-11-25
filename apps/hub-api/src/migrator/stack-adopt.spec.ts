import { parseDiscovered } from "./discover-script";
import { analyzeStacks, splitConfigFiles, stackRefusalMessage } from "./stack-adopt";
import { inspectLine, STACK, CUSTOM_STACK, FOREIGN } from "./testing/demo-containers";

function line(name: string, image: string, labels: Record<string, string> = {}, extra: { state?: string; ports?: Record<string, unknown>; mounts?: unknown[] } = {}): string {
  const o = JSON.parse(inspectLine({ name, image, labels, state: extra.state })) as Record<string, unknown>;
  (o.HostConfig as Record<string, unknown>).PortBindings = extra.ports ?? {};
  o.Mounts = extra.mounts ?? [];
  return JSON.stringify(o);
}
const proj = (project: string, service: string, dir = "/srv/shop", files = `${dir}/docker-compose.yml`) => ({
  "com.docker.compose.project": project,
  "com.docker.compose.service": service,
  "com.docker.compose.project.working_dir": dir,
  "com.docker.compose.project.config_files": files,
});
const stacks = (...lines: string[]) => analyzeStacks(parseDiscovered(lines.join("\n")));

describe("splitConfigFiles", () => {
  it("splits docker's comma list", () => {
    expect(splitConfigFiles("/a/x.yml, /a/y.yml")).toEqual(["/a/x.yml", "/a/y.yml"]);
    expect(splitConfigFiles("")).toBeNull();
    expect(splitConfigFiles(null)).toBeNull();
  });
});

describe("analyzeStacks", () => {
  const shop = [
    line("shop-web-1", "node:22", proj("shop", "web"), { ports: { "3000/tcp": [{ HostPort: "8080" }] } }),
    line("shop-db-1", "postgres:16", proj("shop", "db", "/srv/shop", "/srv/shop/docker-compose.yml,/srv/shop/compose.prod.yml"), { mounts: [{ Type: "volume", Name: "shop_pgdata", Destination: "/var/lib/postgresql/data" }, { Type: "bind", Source: "/srv/x", Destination: "/x" }] }),
  ];

  it("offers a healthy project: services with images, published ports, named volumes, the first member row", () => {
    const [s] = stacks(...shop);
    expect(s).toMatchObject({ project: "shop", workingDir: "/srv/shop", adoptable: true, reason: null, firstContainer: "shop-web-1", managedBy: null });
    expect(s.configFiles).toEqual(["/srv/shop/docker-compose.yml"]);
    expect(s.services).toEqual([
      { service: "db", image: "postgres:16", ports: [], state: "running", containers: 1 },
      { service: "web", image: "node:22", ports: [8080], state: "running", containers: 1 },
    ]);
    expect(s.volumes).toEqual([{ service: "db", name: "shop_pgdata", target: "/var/lib/postgresql/data" }]);
  });

  it("refuses Tugra's own install stack and never lists it", () => {
    expect(stacks(...Object.values(STACK), ...Object.values(CUSTOM_STACK))).toEqual([]);
  });

  it("refuses a Tugra-deployed compose app and a project with a Tugra-named member", () => {
    const app = stacks(line("tugra_clx1abcdefghijklmnopqrst-web-1", "nginx", proj("tugra_clx1abcdefghijklmnopqrst", "web", "/etc/tugra/compose/clx1")));
    expect(app).toEqual([]); // hidden entirely: Tugra's own
    const mixed = stacks(line("shop-web-1", "node:22", proj("shop", "web")), line("tugra-sidecar-1", "busybox", proj("shop", "side")));
    expect(mixed[0]).toMatchObject({ adoptable: false, reason: "tugra" });
  });

  it("refuses Coolify and Dokploy projects, by label and by directory", () => {
    const coolify = stacks(line("c-web-1", "node:22", { ...proj("c1", "web", "/data/coolify/applications/abc"), "coolify.managed": "true" }));
    expect(coolify[0]).toMatchObject({ adoptable: false, reason: "managed", managedBy: "coolify" });
    const dokployDir = stacks(line("d-web-1", "node:22", proj("d1", "web", "/etc/dokploy/compose/x/code")));
    expect(dokployDir[0]).toMatchObject({ adoptable: false, reason: "managed", managedBy: "dokploy" });
    const byName = stacks(line("dokploy-postgres", "postgres:16", proj("dokploy", "postgres", "/srv/d")));
    expect(byName[0].managedBy).toBe("dokploy");
    expect(stackRefusalMessage("managed", "dokploy")).toMatch(/Dokploy import/);
    expect(stackRefusalMessage("managed", "coolify")).toMatch(/Coolify import/);
  });

  it("refuses a project without recorded files, and one in an unsafe place", () => {
    const bare = stacks(line("x-web-1", "node:22", { "com.docker.compose.project": "x", "com.docker.compose.service": "web" }));
    expect(bare[0]).toMatchObject({ adoptable: false, reason: "no_config" });
    const spaced = stacks(line("x-web-1", "node:22", proj("x", "web", "/srv/my shop", "/srv/my shop/docker-compose.yml")));
    expect(spaced[0]).toMatchObject({ adoptable: false, reason: "unsafe_path" });
    const sys = stacks(line("x-web-1", "node:22", proj("x", "web", "/usr/local/x", "/usr/local/x/c.yml")));
    expect(sys[0]).toMatchObject({ adoptable: false, reason: "unsafe_path" });
    const odd = stacks(line("x-web-1", "node:22", proj("x", "web", "/srv/x", "/srv/x/$(id).yml")));
    expect(odd[0]).toMatchObject({ adoptable: false, reason: "unsafe_path" });
  });

  it("refuses a project name compose could not have produced", () => {
    expect(stacks(line("a-web-1", "node:22", proj("Bad Name", "web")))[0]).toMatchObject({ adoptable: false, reason: "bad_name" });
  });

  it("refuses when another container's name starts with the project's (name-based tracking would mix them)", () => {
    const clash = stacks(line("shop-web-1", "node:22", proj("shop", "web")), line("shop-legacy", "nginx"), line("other-1", "nginx", proj("other", "web", "/srv/o", "/srv/o/c.yml")));
    expect(clash.find((s) => s.project === "shop")).toMatchObject({ adoptable: false, reason: "name_clash" });
    expect(clash.find((s) => s.project === "other")?.adoptable).toBe(true);
  });

  it("the demo foreign compose project is offered with its first member row", () => {
    const [s] = stacks(...Object.values(FOREIGN));
    expect(s).toMatchObject({ project: "shop", adoptable: true, firstContainer: "shop-db-1" });
  });
});
