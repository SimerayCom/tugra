/**
 * Docker-gated LAB checks for the env-flags transport. They need a real Docker daemon, so they are OPT-IN
 * (`TUGRA_DOCKER_LAB=1`) on top of docker being on PATH; otherwise the whole block is skipped. They document the
 * assumptions the scripts rely on (see the env-flags spec, section 12):
 *   1. `docker run -e KEY` (no `=`) copies from the docker CLI process environment, empty values included.
 *   2. Compose: a shell-env variable beats `.env`/`--env-file` for interpolation and a `$` inside a shell-sourced
 *      value is NOT re-interpolated.
 *   4. A busybox image runs the multiline swarm wrapper (base64 -d, printf x, ${v%x}).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvWrapper } from "./service-script";

const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"]).status === 0;
const d = process.env.TUGRA_DOCKER_LAB === "1" && docker ? describe : describe.skip;

d("env transport lab (real docker)", () => {
  it("docker run -e KEY copies a multiline and an empty value from the CLI environment", () => {
    const r = spawnSync("sh", ["-c", 'docker run --rm -e ML -e EMPTY busybox sh -c \'printf "%s|%s" "$ML" "$EMPTY"\''], {
      env: { ...process.env, ML: "l1\nl2\n", EMPTY: "" },
      encoding: "utf8",
    });
    expect(r.stdout).toBe("l1\nl2\n|");
  });

  it("compose: shell env beats the env file and a $ in a shell-sourced value stays literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-lab-"));
    try {
      writeFileSync(join(dir, "c.yml"), 'services:\n  w:\n    image: busybox\n    command: ["sh","-c","printf %s \\"$$V\\""]\n    environment:\n      V: "${V}"\n');
      writeFileSync(join(dir, ".env"), "V=from-file\n");
      const r = spawnSync("docker", ["compose", "-f", join(dir, "c.yml"), "--env-file", join(dir, ".env"), "run", "--rm", "w"], {
        env: { ...process.env, V: "pa$$word${X}" },
        encoding: "utf8",
      });
      expect(r.stdout).toContain("pa$$word${X}");
      expect(r.stdout).not.toContain("from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("busybox runs the multiline swarm wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-lab-"));
    try {
      writeFileSync(join(dir, "app_env"), `PEM:b64=${Buffer.from("a\nb\n").toString("base64")}\nPLAIN=x=y\n`);
      const wrapper = appEnvWrapper({ ml: true }).replaceAll("/run/secrets/app_env", "/mnt/app_env");
      const r = spawnSync("docker", ["run", "--rm", "-v", `${dir}/app_env:/mnt/app_env:ro`, "busybox", "sh", "-c", wrapper, "app", "sh", "-c", 'printf "%s|%s" "$PEM" "$PLAIN"'], { encoding: "utf8" });
      expect(r.stdout).toBe("a\nb\n|x=y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
