import { assertSafeCompose } from "./compose-safety";

const wrap = (svcBody: string) => `services:\n  app:\n    image: nginx\n${svcBody}\n`;

describe("assertSafeCompose", () => {
  it("accepts an ordinary, contained compose (block + common safe binds)", () => {
    for (const c of [
      'services:\n  app:\n    image: "nginx:latest"\n    ports:\n      - "20001:80"\n    volumes:\n      - "app-data:/var/www"\n    cap_add:\n      - CHOWN\n      - SETUID\nvolumes:\n  app-data:\n',
      wrap("    network_mode: bridge\n    environment:\n      - TZ=UTC"),
      wrap('    volumes:\n      - "conf:/etc/app"'), // NAMED volume mounted at /etc/app — source is a name, fine
      wrap('    volumes:\n      - "/etc/localtime:/etc/localtime:ro"\n      - "/etc/timezone:/etc/timezone:ro"'), // ubiquitous + safe
      wrap('    cap_add:\n      - NET_BIND_SERVICE'),
      wrap('    security_opt:\n      - "label:type:svirt_apache_t"'), // legit SELinux type assignment
    ]) {
      expect(() => assertSafeCompose(c)).not.toThrow();
    }
  });

  it("rejects a container_name on the reserved tugra-/tugra_ prefix (can't squat/impersonate a managed container)", () => {
    for (const name of ["tugra-patch", "tugra-proxy", "tugra_db_abc", "TUGRA-agent", "tugra_myapp"]) {
      expect(() => assertSafeCompose(wrap(`    container_name: ${name}`))).toThrow(/reserved/);
    }
    // an ordinary container_name is still fine
    expect(() => assertSafeCompose(wrap("    container_name: my-app"))).not.toThrow();
  });

  it("rejects a RELATIVE bind into the Tugra-managed compose dir (the dir itself, .env, mounts, compose files)", () => {
    for (const src of ["./:/host", ".:/host", "./.env:/x", "./mounts:/x", "./mounts/0:/x", "./docker-compose.yml:/x", "./docker-compose.tugra.yml:/x"]) {
      expect(() => assertSafeCompose(wrap(`    volumes:\n      - "${src}"`))).toThrow(/sensitive host path/);
    }
  });

  it("still accepts a named volume and a fresh relative subdir bind", () => {
    expect(() => assertSafeCompose(wrap('    volumes:\n      - "mydata:/var/lib/x"'))).not.toThrow();
    expect(() => assertSafeCompose(wrap('    volumes:\n      - "./data:/var/lib/x"'))).not.toThrow();
  });

  it("rejects every compose-go truthy spelling of privileged (yes/on/y/1/t), not just `true`", () => {
    for (const val of ["true", "yes", "on", "y", "1", "t", "YES", "On"]) {
      expect(() => assertSafeCompose(wrap(`    privileged: ${val}`))).toThrow(/privileged/);
    }
    // an explicitly-false / absent privileged is fine
    for (const val of ["false", "no", "off", "n", "0"]) {
      expect(() => assertSafeCompose(wrap(`    privileged: ${val}`))).not.toThrow();
    }
  });

  it("does not reject an anonymous volume at a sensitive-looking CONTAINER path (mysql/postgres data)", () => {
    for (const c of [
      wrap('    volumes:\n      - "/var/lib/mysql"'), // anonymous volume — no host bind
      wrap('    volumes:\n      - "/var/lib/postgresql/data"'),
      wrap('    volumes:\n      - "/root/.config"'),
    ]) {
      expect(() => assertSafeCompose(c)).not.toThrow();
    }
  });

  it("rejects privileged / host namespaces in BLOCK and FLOW style", () => {
    for (const bad of [
      wrap("    privileged: true"),
      wrap('    privileged: "true"'),
      wrap("    network_mode: host"),
      wrap('    network_mode: "host"'),
      wrap("    pid: host"),
      wrap("    ipc: host"),
      wrap("    userns_mode: host"),
      wrap("    cgroup_parent: /custom"),
      // FLOW mapping — the D6 ultracode bypass: mid-line keys defeat a line-based regex
      "services:\n  app: {image: alpine, privileged: true}\n",
      "services:\n  app: {image: alpine, network_mode: host}\n",
      "services:\n  app: {image: alpine, pid: host}\n",
    ]) {
      expect(() => assertSafeCompose(bad)).toThrow(/disallowed directive/);
    }
  });

  it("cap_add is an ALLOWLIST — any non-safe cap (incl. post-5.8 BPF/PERFMON/SYSLOG) is rejected", () => {
    for (const bad of [
      wrap("    cap_add:\n      - SYS_ADMIN"),
      wrap("    cap_add:\n      - NET_ADMIN"),
      wrap('    cap_add: ["SYS_PTRACE"]'), // flow sequence
      wrap("    cap_add:\n      - ALL"),
      wrap("    cap_add:\n      - CAP_SYS_ADMIN"), // CAP_ prefix
      wrap("    cap_add:\n      - BPF"), // Linux 5.8 split-out of SYS_ADMIN
      wrap("    cap_add:\n      - PERFMON"),
      wrap("    cap_add:\n      - SYSLOG"),
      // YAML anchor/alias — parsing resolves the alias, so the danger is caught post-parse
      "x: &danger [SYS_ADMIN]\nservices:\n  app:\n    image: alpine\n    cap_add: *danger\n",
    ]) {
      expect(() => assertSafeCompose(bad)).toThrow(/cap_add/);
    }
    // safe / Docker-default caps ARE allowed
    expect(() => assertSafeCompose(wrap("    cap_add:\n      - NET_BIND_SERVICE\n      - CHOWN\n      - SYS_NICE"))).not.toThrow();
  });

  it("rejects host-file / cross-container structural keys (secrets/configs/build/extends/volumes_from, uts host)", () => {
    for (const bad of [
      "secrets:\n  s:\n    file: /etc/passwd\nservices:\n  app:\n    image: x\n    secrets:\n      - s\n",
      "configs:\n  c:\n    file: /root/.ssh/id_rsa\nservices:\n  app:\n    image: x\n    configs:\n      - c\n",
      wrap("    build:\n      context: ."),
      wrap('    extends:\n      file: /etc/other.yml\n      service: x'),
      wrap("    volumes_from:\n      - other"),
      wrap("    uts: host"),
    ]) {
      expect(() => assertSafeCompose(bad)).toThrow(/disallowed directive/);
    }
  });

  it("rejects the docker socket bind (short, long, and flow forms)", () => {
    for (const bad of [
      wrap('    volumes:\n      - "/var/run/docker.sock:/var/run/docker.sock"'),
      wrap("    volumes:\n      -\n        type: bind\n        source: /run/docker.sock\n        target: /sock"),
      'services:\n  app: {image: alpine, volumes: ["/var/run/docker.sock:/sock"]}\n', // flow
    ]) {
      expect(() => assertSafeCompose(bad)).toThrow(/docker socket/);
    }
  });

  it("rejects sensitive host-path binds in BLOCK, long, and FLOW-sequence forms", () => {
    for (const bad of [
      wrap('    volumes:\n      - "/etc:/host-etc"'),
      wrap('    volumes:\n      - "/:/host"'),
      wrap('    volumes:\n      - "/root/.ssh:/keys"'),
      wrap('    volumes:\n      - "/var/lib/docker:/vld"'),
      wrap("    volumes:\n      -\n        type: bind\n        source: /proc\n        target: /host-proc"),
      // FLOW sequence — the second D6 ultracode bypass
      'services:\n  app:\n    image: alpine\n    volumes: ["/:/host"]\n',
      'services:\n  app:\n    image: alpine\n    volumes: [{type: bind, source: /etc, target: /h}]\n',
      // env-interpolated source could smuggle a host path via envOverride at deploy
      wrap('    volumes:\n      - "${HOSTPATH}:/host"'),
    ]) {
      expect(() => assertSafeCompose(bad)).toThrow(/sensitive host path/);
    }
  });

  it("rejects a host-bound top-level named volume (driver_opts device)", () => {
    const bad = "services:\n  app:\n    image: alpine\n    volumes:\n      - etcvol:/host-etc\nvolumes:\n  etcvol:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /etc\n";
    expect(() => assertSafeCompose(bad)).toThrow(/sensitive host path/);
  });

  it("rejects devices + confinement-disabling security_opt (`:` AND `=` separators)", () => {
    for (const bad of [
      wrap("    devices:\n      - /dev/sda:/dev/sda"),
      wrap("    security_opt:\n      - seccomp:unconfined"),
      wrap("    security_opt:\n      - seccomp=unconfined"), // `=` separator — the missed HIGH finding
      wrap("    security_opt:\n      - apparmor:unconfined"),
      wrap("    security_opt:\n      - label:disable"),
    ]) {
      expect(() => assertSafeCompose(bad)).toThrow(/disallowed directive/);
    }
  });

  it("canonicalizes bind sources so `//etc`, `/./etc`, `/../etc` cannot smuggle a sensitive path", () => {
    for (const src of ["//etc", "///etc", "/./etc", "/../etc", "//root", "//sys", "//var/lib/docker", "/etc/../etc"]) {
      expect(() => assertSafeCompose(wrap(`    volumes:\n      - "${src}:/h"`))).toThrow(/sensitive host path/);
    }
    // a contained relative bind stays inside the compose dir → allowed; a `..` traversal is rejected
    expect(() => assertSafeCompose(wrap('    volumes:\n      - "./data:/data"'))).not.toThrow();
    expect(() => assertSafeCompose(wrap('    volumes:\n      - "../../../etc:/h"'))).toThrow(/sensitive host path/);
  });

  it("resolves YAML merge keys (<<) so a merged-in escape directive is not hidden from the check", () => {
    const bad = "x-evil: &evil\n  privileged: true\nservices:\n  app:\n    image: x\n    <<: *evil\n";
    expect(() => assertSafeCompose(bad)).toThrow(/privileged/);
    const badVol = "x-v: &v\n  volumes: [\"/etc:/h\"]\nservices:\n  app:\n    image: x\n    <<: *v\n";
    expect(() => assertSafeCompose(badVol)).toThrow(/sensitive host path/);
  });

  it("rejects a container/service namespace join (pid/ipc/network_mode), not just host", () => {
    expect(() => assertSafeCompose(wrap('    pid: "container:victim"'))).toThrow(/disallowed directive/);
    expect(() => assertSafeCompose(wrap('    network_mode: "container:other"'))).toThrow(/disallowed directive/);
    expect(() => assertSafeCompose(wrap('    ipc: "service:db"'))).toThrow(/disallowed directive/);
  });

  it("rejects the cgroup namespace join (`cgroup: host`, distinct from cgroup_parent)", () => {
    expect(() => assertSafeCompose(wrap("    cgroup: host"))).toThrow(/cgroup host/);
    expect(() => assertSafeCompose(wrap("    cgroup: private"))).not.toThrow(); // the safe value is fine
  });

  it("rejects device_cgroup_rules (raw host-device access even without `devices:`)", () => {
    expect(() => assertSafeCompose(wrap('    device_cgroup_rules:\n      - "b 8:0 rwm"'))).toThrow(/device_cgroup_rules/);
    expect(() => assertSafeCompose(wrap('    device_cgroup_rules: ["a *:* rwm"]'))).toThrow(/device_cgroup_rules/);
  });

  it("rejects security_opt systempaths=unconfined (un-masks host /proc paths)", () => {
    expect(() => assertSafeCompose(wrap("    security_opt:\n      - systempaths=unconfined"))).toThrow(/disallowed directive/);
    expect(() => assertSafeCompose(wrap("    security_opt:\n      - systempaths:unconfined"))).toThrow(/disallowed directive/);
  });

  it("rejects malformed YAML rather than passing it through", () => {
    expect(() => assertSafeCompose("services:\n  app:\n  - broken: : :")).toThrow();
  });
});
