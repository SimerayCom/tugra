import { containersToFleet, LocalDockerSource } from "./local-docker.source";
import type { AdoptableContainer } from "../../migrator/migrator.service";

const mk = (over: Partial<AdoptableContainer>): AdoptableContainer => ({
  id: "c1",
  name: "app",
  image: "nginx:1",
  state: "running",
  ports: [],
  env: [],
  mounts: [],
  restartPolicy: "always",
  isTugra: false,
  composeProject: null,
  adoptable: true,
  ...over,
});

describe("containersToFleet", () => {
  it("maps standalone containers to IMAGE apps — keys only, ports, named+bind volumes", () => {
    const fleet = containersToFleet("srv1", [
      mk({
        id: "c1",
        name: "web",
        image: "nginx:1",
        ports: [{ host: 8080, container: 80, protocol: "tcp" }],
        env: [{ key: "FOO", value: "SECRETVAL" }],
        mounts: [
          { type: "volume", source: "data", target: "/data" },
          { type: "bind", source: "/srv/x", target: "/x" },
          { type: "tmpfs", source: "", target: "/tmp" }, // ephemeral → dropped, not a "named" volume
        ],
      }),
    ]);
    expect(fleet.apps).toHaveLength(1);
    const a = fleet.apps[0];
    expect(a).toMatchObject({
      sourceRef: "c1",
      name: "web",
      kind: "image",
      buildPack: "image",
      image: "nginx:1",
      imageOrigin: "registry",
      serverRef: "srv1",
      ports: [80],
      replicas: 1,
    });
    expect(a.env).toEqual([{ key: "FOO" }]); // value dropped
    expect(a.volumes).toEqual([
      { name: "data", hostPath: undefined, mountPath: "/data", type: "named", ownerRef: "c1" },
      { name: undefined, hostPath: "/srv/x", mountPath: "/x", type: "bind", ownerRef: "c1" },
    ]);
    expect(fleet.databases).toEqual([]);
    expect(fleet.servers).toEqual([{ ref: "srv1" }]);
    expect(fleet.warnings).toEqual([]);
    expect(JSON.stringify(fleet)).not.toContain("SECRETVAL"); // env values never leave discover
  });

  it("skips compose-managed containers with a single warning, keeps standalone", () => {
    const fleet = containersToFleet("srv1", [
      mk({ id: "c1", adoptable: true, composeProject: null }),
      mk({ id: "c2", adoptable: false, composeProject: "stack" }),
      mk({ id: "c3", adoptable: false, composeProject: "stack" }),
    ]);
    expect(fleet.apps.map((x) => x.sourceRef)).toEqual(["c1"]);
    expect(fleet.warnings).toHaveLength(1);
    expect(fleet.warnings[0]).toContain("2 compose-managed");
  });
});

describe("LocalDockerSource", () => {
  it("discover() reuses migrator.discover(userId, serverId) and maps the result", async () => {
    const discover = jest.fn().mockResolvedValue({ containers: [mk({ id: "c1", name: "web" })] });
    const src = new LocalDockerSource({ discover } as never, "u1", "srv1");
    const fleet = await src.discover();
    expect(discover).toHaveBeenCalledWith("u1", "srv1");
    expect(fleet.apps[0]).toMatchObject({ sourceRef: "c1", name: "web" });
  });

  it("is a read-only dry-run adapter: no secrets, no data transports", async () => {
    const src = new LocalDockerSource({} as never, "u1", "srv1");
    await expect(src.verify()).resolves.toEqual({ ok: true });
    await expect(src.fetchSecrets("c1")).resolves.toEqual({ values: {}, unresolved: [] });
    expect(src.capabilities()).toEqual({ apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false });
    await expect(src.close()).resolves.toBeUndefined();
  });
});
