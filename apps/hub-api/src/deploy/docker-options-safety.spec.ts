import { assertSafeDockerOptions, validateHostMounts } from "./docker-options-safety";

const ok = (s: string) => expect(() => assertSafeDockerOptions(s)).not.toThrow();
const bad = (s: string, re?: RegExp) => expect(() => assertSafeDockerOptions(s)).toThrow(re ?? /disallowed flag|unterminated/);

describe("validateHostMounts", () => {
  it("accepts a legitimate media mount (read-only by default)", () => {
    expect(validateHostMounts([{ hostPath: "/mnt/media", containerPath: "/media" }])).toEqual([
      { hostPath: "/mnt/media", containerPath: "/media", readOnly: true },
    ]);
  });
  it("keeps an explicit read-write mount", () => {
    expect(validateHostMounts([{ hostPath: "/data/x", containerPath: "/x", readOnly: false }])[0].readOnly).toBe(false);
  });
  it("rejects a sensitive host path", () => {
    for (const p of ["/etc", "/", "/var/lib/docker", "/root", "/home/user", "/proc"]) {
      expect(() => validateHostMounts([{ hostPath: p, containerPath: "/x" }])).toThrow(/protected system path|absolute/);
    }
  });
  it("rejects the docker socket", () => {
    expect(() => validateHostMounts([{ hostPath: "/var/run/docker.sock", containerPath: "/s" }])).toThrow(/docker socket|protected/);
  });
  it("rejects a path-traversal / non-absolute / colon'd path", () => {
    expect(() => validateHostMounts([{ hostPath: "/mnt/../etc", containerPath: "/x" }])).toThrow();
    expect(() => validateHostMounts([{ hostPath: "relative", containerPath: "/x" }])).toThrow(/absolute/);
    expect(() => validateHostMounts([{ hostPath: "/mnt/a:b", containerPath: "/x" }])).toThrow(/absolute/);
    expect(() => validateHostMounts([{ hostPath: "/mnt/media", containerPath: "rel" }])).toThrow(/absolute/);
  });
  it("caps the number of mounts and accepts an empty/null list", () => {
    expect(validateHostMounts(null)).toEqual([]);
    expect(validateHostMounts([])).toEqual([]);
    const many = Array.from({ length: 21 }, (_, i) => ({ hostPath: `/mnt/m${i}`, containerPath: `/m${i}` }));
    expect(() => validateHostMounts(many)).toThrow(/at most/);
  });
});

describe("assertSafeDockerOptions", () => {
  it("allows legitimate, non-escaping flags", () => {
    ok("--cap-add=NET_BIND_SERVICE --dns 1.1.1.1"); // allowlisted cap
    ok("--cap-add SYS_NICE --memory=512m --cpus 1.5");
    ok("--label foo=bar --label app='my app'");
    ok("-v myvol:/data"); // named volume
    ok("--mount type=volume,source=myvol,target=/data");
    ok("-v /etc/localtime:/etc/localtime:ro"); // ubiquitous safe host file
    ok("");
    ok("   ");
  });

  it("rejects --privileged", () => bad("--privileged", /--privileged/));

  it("rejects host / container namespaces", () => {
    bad("--network host", /host\/container/);
    bad("--network=host");
    bad("--net container:other");
    bad("--pid=host");
    bad("--ipc host");
    bad("--uts=host");
    bad("--userns=host", /--userns host/);
    bad("--cgroupns host", /--cgroupns host/);
  });

  it("rejects host device passthrough + cgroup-parent", () => {
    bad("--device /dev/sda", /host device/);
    bad("--device-cgroup-rule 'a *:* rwm'", /host device/);
    bad("--cgroup-parent /x", /--cgroup-parent/);
  });

  it("rejects a docker.sock bind (host daemon takeover)", () => {
    bad("-v /var/run/docker.sock:/var/run/docker.sock", /docker socket/);
    bad("--mount type=bind,source=/run/docker.sock,target=/x", /docker socket/);
  });

  it("rejects sensitive host-path binds (host filesystem escape)", () => {
    bad("-v /:/host", /sensitive host path/);
    bad("-v /etc:/etc", /sensitive host path/);
    bad("--mount type=bind,src=/root,dst=/r", /sensitive host path/);
    bad("-v //etc/../etc:/x", /sensitive host path/); // path-normalization bypass attempt
  });

  it("rejects non-allowlisted capabilities incl ALL and SYS_ADMIN", () => {
    bad("--cap-add=ALL", /non-allowlisted/);
    bad("--cap-add SYS_ADMIN");
    bad("--cap-add=CAP_SYS_ADMIN");
  });

  it("rejects security-opt that disables confinement", () => {
    bad("--security-opt seccomp=unconfined", /confinement/);
    bad("--security-opt apparmor=unconfined");
    bad("--security-opt label:disable");
  });

  it("rejects a traefik.* label (cross-tenant ingress hijack)", () => {
    bad("--label traefik.http.routers.evil.rule=Host(`victim.com`)", /traefik/);
    bad("-l traefik.enable=true", /traefik/);
    bad("--label=traefik.http.routers.evil.service=evil", /traefik/);
    bad("--memory=256m --label TRAEFIK.enable=true", /traefik/); // case-insensitive
  });

  it("still allows non-traefik labels (monitoring / metadata)", () => {
    ok("--label foo=bar --label app='my app'");
    ok("-l com.example.team=blue");
    ok("--label traefikish=notreally"); // only the exact `traefik.` prefix is gated
  });

  it("rejects --label-file (bypass of the traefik.* check)", () => bad("--label-file /tmp/labels", /label-file/));

  it("rejects --name (managed container name)", () => {
    bad("--name evil", /--name/);
    bad("--name=tugra_victim", /--name/);
  });

  it("rejects --env-file (host file disclosure into env)", () => {
    bad("--env-file /root/tugra/.env", /env-file/);
    bad("--env-file=/etc/secrets", /env-file/);
  });

  it("fails closed on an unterminated quote", () => bad('--label "oops', /unterminated/));
});
