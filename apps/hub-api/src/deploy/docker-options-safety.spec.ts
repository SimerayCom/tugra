import { assertSafeDockerOptions } from "./docker-options-safety";

const ok = (s: string) => expect(() => assertSafeDockerOptions(s)).not.toThrow();
const bad = (s: string, re?: RegExp) => expect(() => assertSafeDockerOptions(s)).toThrow(re ?? /disallowed flag|unterminated/);

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

  it("fails closed on an unterminated quote", () => bad('--label "oops', /unterminated/));
});
