import {
  buildRemoveScript,
  buildRunScript,
  containerName,
  type AppSpec,
} from "./deploy-script";

const base: AppSpec = {
  id: "abc",
  image: "nginx:1.27",
  env: {},
  hostPort: null,
  containerPort: 80,
};

describe("deploy-script", () => {
  it("names the container deterministically", () => {
    expect(containerName({ id: "abc" })).toBe("tugra_abc");
  });

  it("pulls, removes old, and runs the image", () => {
    const s = buildRunScript(base);
    expect(s).toContain("docker pull 'nginx:1.27'");
    expect(s).toContain("docker rm -f tugra_abc");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped 'nginx:1.27'");
  });

  it("adds env (-e) and port (-p) flags, shell-quoting values", () => {
    const s = buildRunScript({
      ...base,
      env: { FOO: "bar baz", Q: "a'b" },
      hostPort: 8080,
      containerPort: 3000,
    });
    expect(s).toContain("-e 'FOO=bar baz'");
    expect(s).toContain("-e 'Q=a'\\''b'");
    expect(s).toContain("-p 8080:3000");
  });

  it("builds a remove script", () => {
    expect(buildRemoveScript({ id: "abc" })).toContain("docker rm -f tugra_abc");
  });
});
