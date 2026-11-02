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

  // Short-flag ATTACHED / BUNDLED value forms — pflag accepts `-vSRC:DST` and `-lKEY=VAL`, so these must be
  // classified as -v / -l, not slip past the switch as an unknown whole-token name (the historic bypass).
  it("blocks attached short-flag host binds (-v/:/host, -v=/:/host, docker.sock)", () => {
    bad("-v/:/host", /sensitive host path/);
    bad("-v=/:/host", /sensitive host path/);
    bad("-v/var/run/docker.sock:/var/run/docker.sock", /docker socket/);
    bad("-v/etc:/etc", /sensitive host path/);
  });
  it("blocks a traefik label in the attached short form (-ltraefik.x=…)", () => {
    bad("-ltraefik.http.routers.x.rule=Host(`victim.com`)", /traefik/);
    bad("-l=traefik.enable=true", /traefik/);
  });
  it("resolves a gated short flag hidden behind boolean shorts in a cluster (-itv/:/host)", () => {
    bad("-itv/:/host", /sensitive host path/);
  });
  it("fails closed on an unrecognized short flag in a cluster", () => {
    bad("-zv/:/host", /unrecognized short flag/);
    bad("-q /tmp", /unrecognized short flag/);
  });
  it("does not false-positive on legit attached non-gated shorts or all-boolean clusters", () => {
    ok("-emyvar=1"); // -e (env) attached value — not gated
    ok("-elower_case_value=1"); // value contains v/l letters but belongs to -e, not a volume
    ok("-dit"); // all-boolean cluster
    ok("-vmyvol:/data"); // attached named volume (no leading / → safe)
    ok("-lcom.example.k=v"); // attached non-traefik label
  });

  // --mount CSV parsing must not trust a spoofable `type=` field.
  it("blocks --mount binds regardless of type= casing / duplication / quoting", () => {
    bad("--mount Type=BIND,Source=/etc,target=/e", /sensitive host path/);
    bad("--mount type=volume,type=bind,source=/root,target=/r", /sensitive host path/);
    bad('--mount source="/root",target=/r', /sensitive host path/);
    bad("--mount type=bind,src=/var/run/docker.sock,target=/s", /docker socket/);
  });
  it("still allows a --mount of a named volume or a safe host path", () => {
    ok("--mount type=volume,source=myvol,target=/data");
    ok("--mount type=bind,source=/mnt/media,target=/media");
  });

  // --volumes-from borrows another container's mounts (incl. the agent's docker.sock) — a host escape.
  it("blocks --volumes-from in both attached and separate forms", () => {
    bad("--volumes-from other", /volumes-from/);
    bad("--volumes-from=tugra_agent", /volumes-from/);
  });
});

describe("assertSafeDockerOptions — owner privileged override", () => {
  const allow = (s: string) => expect(() => assertSafeDockerOptions(s, { allowPrivileged: true })).not.toThrow();
  const stillBad = (s: string, re?: RegExp) =>
    expect(() => assertSafeDockerOptions(s, { allowPrivileged: true })).toThrow(re ?? /disallowed flag|unterminated/);

  it("allows the whole host-escape class when the owner opted in", () => {
    allow("--privileged");
    allow("--cap-add SYS_ADMIN --device=/dev/fuse --security-opt apparmor:unconfined"); // the Coolify FUSE example
    allow("--device /dev/kvm");
    allow("--network host");
    allow("--pid host");
    allow("-v /var/run/docker.sock:/var/run/docker.sock");
    allow("-v /:/host");
    allow("-v/:/host"); // attached short form resolves to -v and is permitted under the override
    allow("-itv/:/host"); // bundled behind boolean shorts
    allow("--mount type=bind,source=/etc,target=/etc");
    allow("--volumes-from other"); // borrowing mounts is the owner's call once opted in
  });

  it("STILL blocks the Tugra-integrity class even WITH the override", () => {
    stillBad("--label traefik.http.routers.x.rule=Host(`victim.com`)", /traefik/);
    stillBad("-ltraefik.http.routers.x.rule=Host(`victim.com`)", /traefik/); // attached short form
    stillBad("--label-file /tmp/labels", /label-file/);
    stillBad("--name squatted", /name/);
    stillBad("--env-file /root/tugra/.env", /env-file/);
  });

  it("the default (no opts) stays byte-identical — still blocks the host-escape class", () => {
    bad("--privileged");
    bad("--cap-add SYS_ADMIN");
    bad("-v /var/run/docker.sock:/x");
  });

  it("still fails closed on an unterminated quote even with the override", () => stillBad('--privileged "oops', /unterminated/));
});
