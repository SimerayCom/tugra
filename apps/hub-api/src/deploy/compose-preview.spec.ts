import { createHash } from "node:crypto";
import { UnprocessableEntityException } from "@nestjs/common";
import { parse } from "yaml";
import { parseRenderedCompose, COMPOSE_RENDERED_MARKER, COMPOSE_SHA_MARKER } from "./compose-git";
import { composeDir } from "./compose-script";
import { composeGitDir } from "./compose-git";
import {
  buildComposePreviewScript,
  composePreviewDir,
  parsePreviewError,
  PREVIEW_ERR_MARKER,
  redactResolvedCompose,
} from "./compose-preview";
import type { AppSpec } from "./deploy-script";

const SENTINEL = "SENTINEL_s3cr3t_value";
const pasted: AppSpec = {
  id: "abc",
  source: "COMPOSE",
  composeFile: "services:\n  web:\n    image: nginx\n    environment:\n      A: ${A}\n",
  env: { SECRET: SENTINEL },
  hostPort: null,
  containerPort: null,
};
const git: AppSpec = {
  id: "abc",
  source: "COMPOSE",
  composePath: "deploy/stack.yml",
  gitUrl: "https://github.com/u/r.git",
  gitBranch: "main",
  gitToken: "ghp_tok",
  env: { SECRET: SENTINEL },
  hostPort: null,
  containerPort: null,
};
const PV = "/etc/tugra/builds/.cprev-abc";

describe.each([
  ["pasted", pasted],
  ["git", git],
])("buildComposePreviewScript (%s)", (_n, app) => {
  const s = buildComposePreviewScript(app);

  it("never interpolates: --no-interpolate, guarded by a --help probe that exits 2 with the unsupported marker", () => {
    expect(s).toContain("config --no-interpolate");
    expect(s).toContain("docker compose config --help 2>&1 | grep -q -- '--no-interpolate'");
    expect(s).toContain('echo "TUGRA_PREVIEW: unsupported"; exit 2');
    expect(s).not.toMatch(/config\s+2>/); // never a bare `config` without the flag
  });

  it("works in a private 0700 temp dir registered in TUGRA_SEC_DIRS, with the shared EXIT trap", () => {
    expect(s).toContain(`PV='${PV}'`);
    expect(s).toContain('rm -rf "$PV" && mkdir -p "$PV" && chmod 700 "$PV"');
    expect(s).toContain('TUGRA_SEC_DIRS="$PV"');
    expect(s).toContain("trap 'rm -rf $TUGRA_SEC_DIRS' EXIT INT TERM HUP");
    expect(s.match(/trap '/g)?.length).toBe(s.includes("GIT_ASKPASS") ? 2 : 1); // gitCloneSteps re-installs the IDENTICAL trap
    for (const m of s.matchAll(/trap '([^']*)'/g)) expect(m[1]).toBe("rm -rf $TUGRA_SEC_DIRS");
    expect(s).toContain("-name '.cprev-*' -mmin +60"); // sweep for SIGKILLed runs
  });

  it("never touches a live compose / clone dir and never writes a .env", () => {
    expect(s).not.toContain(composeDir(app));
    expect(s).not.toContain(composeGitDir(app));
    expect(s).not.toContain("/etc/tugra/compose");
    expect(s).not.toMatch(/\.env/);
    expect(s).not.toContain("--env-file");
  });

  it("emits the render markers the existing parser reads, and the error marker", () => {
    expect(s).toContain(COMPOSE_RENDERED_MARKER);
    expect(s).toContain(COMPOSE_SHA_MARKER);
    expect(s).toContain(`${PREVIEW_ERR_MARKER}$(head -c 2000 "$PV/err" | base64 | tr -d '\\n')`);
  });

  it("canary: no env value (or token) is in the script text", () => {
    expect(s).not.toContain(SENTINEL);
    expect(s).not.toContain(Buffer.from(SENTINEL).toString("base64"));
  });
});

describe("variant specifics", () => {
  it("pasted writes the stored file from base64 into the temp dir", () => {
    const s = buildComposePreviewScript(pasted);
    expect(s).toContain(`printf %s '${Buffer.from(pasted.composeFile!).toString("base64")}' | base64 -d > "$PV/docker-compose.yml"`);
    expect(s).toContain('-f "$PV/docker-compose.yml" config --no-interpolate 2>"$PV/err"');
    expect(s).not.toContain("git clone");
  });

  it("git clones INTO the temp dir (one clone), runs the symlink guard, and reads the repo-relative path", () => {
    const s = buildComposePreviewScript(git);
    expect((s.match(/git clone/g) ?? []).length).toBe(1);
    expect(s).toContain(`CLONE='${PV}/c'`);
    expect(s).toContain(`git clone --depth 1 --branch 'main' -- 'https://x-access-token@github.com/u/r.git' ${PV}/c`);
    expect(s).toContain('find "$CLONE" -type l');
    expect(s).toContain(`-f '${PV}/c/deploy/stack.yml' config --no-interpolate`);
    expect(s).not.toContain("ghp_tok"); // the token is base64 through GIT_ASKPASS, never raw
  });

  it("composePreviewDir derives only from the app id", () => {
    expect(composePreviewDir({ id: "abc" })).toBe(PV);
  });

  it("the size preflight maps an oversized pasted file to a throw (service turns it into a 422)", () => {
    expect(() => buildComposePreviewScript({ ...pasted, composeFile: "services:\n" + "# x\n".repeat(60_000) })).toThrow(/limit/);
  });

  it("the output is parsed by the existing parseRenderedCompose, which verifies the sha", () => {
    const text = "services:\n  web:\n    image: nginx\n";
    const sha = createHash("sha256").update(text).digest("hex");
    const out = `${COMPOSE_RENDERED_MARKER}${Buffer.from(text).toString("base64")}\n${COMPOSE_SHA_MARKER}${sha}\n`;
    expect(parseRenderedCompose(out)).toEqual({ compose: text, sha });
    expect(parseRenderedCompose(out.replace(sha, "f".repeat(64)))).toBeNull(); // sha mismatch is rejected
  });

  it("parsePreviewError decodes and caps the stderr marker", () => {
    expect(parsePreviewError(`x\n${PREVIEW_ERR_MARKER}${Buffer.from("bad yaml").toString("base64")}\n`)).toBe("bad yaml");
    expect(parsePreviewError(`${PREVIEW_ERR_MARKER}${Buffer.from("e".repeat(5000)).toString("base64")}`)).toHaveLength(2000);
    expect(parsePreviewError("nothing")).toBeNull();
    expect(parsePreviewError(`${PREVIEW_ERR_MARKER}!!!`)).toBeNull();
  });
});

describe("redactResolvedCompose", () => {
  const doc = [
    "services:",
    "  web:",
    "    image: nginx",
    "    command: [serve, --token, TOPSECRET_value_xyz]",
    "    environment:",
    "      DB_PASSWORD: hunter2hunter2",
    "      PORT: 8080",
    "      REF: ${DB_URL}",
    "      REF2: $DB_URL",
    "      EMPTY: ''",
    "      NOTHING:",
    "      MIXED: prefix-${X}",
    "    build:",
    "      context: .",
    "      args:",
    "        NPM_TOKEN: npm_literal_token",
    "        FROM_REF: ${NPM}",
    "  api:",
    "    image: api",
    "    environment:",
    "      - KEY=literal-value",
    "      - REFKEY=${REFVAL}",
    "      - BARE",
    "    labels:",
    "      note: contains TOPSECRET_value_xyz inside",
    "",
  ].join("\n");

  it("redacts literal environment values (map and list) and build args, keeps key names and pure references", () => {
    const { yaml, redactions } = redactResolvedCompose(doc, []);
    const p = parse(yaml);
    expect(p.services.web.environment).toEqual({
      DB_PASSWORD: "<redacted>",
      PORT: "<redacted>",
      REF: "${DB_URL}",
      REF2: "$DB_URL",
      EMPTY: "",
      NOTHING: null,
      MIXED: "<redacted>", // an interpolation embedded in other text is a literal pattern -> redacted
    });
    expect(p.services.web.build.args).toEqual({ NPM_TOKEN: "<redacted>", FROM_REF: "${NPM}" });
    expect(p.services.api.environment).toEqual(["KEY=<redacted>", "REFKEY=${REFVAL}", "BARE"]);
    expect(yaml).not.toContain("hunter2");
    expect(yaml).not.toContain("npm_literal_token");
    expect(yaml).not.toContain("literal-value");
    expect(redactions).toBe(5); // DB_PASSWORD, PORT, MIXED, NPM_TOKEN, KEY
  });

  it("scrubs a known env value found ANYWHERE else (command, labels) and counts it; ignores short values", () => {
    const { yaml, redactions } = redactResolvedCompose(doc, ["TOPSECRET_value_xyz", "abc"]);
    const p = parse(yaml);
    expect(p.services.web.command).toEqual(["serve", "--token", "<redacted>"]);
    expect(p.services.api.labels.note).toBe("contains <redacted> inside");
    expect(yaml).not.toContain("TOPSECRET_value_xyz");
    expect(redactions).toBe(7);
  });

  it("scrubs longest values first so an overlapping shorter secret cannot leave a tail", () => {
    const { yaml } = redactResolvedCompose("services:\n  s:\n    image: x\n    command: aaaaaabbbbbb\n", ["aaaaaa", "aaaaaabbbbbb"]);
    expect(parse(yaml).services.s.command).toBe("<redacted>");
  });

  it("anchors and merge keys are resolved (no &a / *a left behind)", () => {
    const { yaml } = redactResolvedCompose("x-base: &b\n  image: nginx\nservices:\n  a: *b\n  c:\n    <<: *b\n", []);
    expect(yaml).not.toMatch(/[&*][a-z]/);
    expect(parse(yaml).services.c.image).toBe("nginx");
  });

  it("throws 422 on unparseable input", () => {
    expect(() => redactResolvedCompose("services: [unclosed", [])).toThrow(UnprocessableEntityException);
    expect(() => redactResolvedCompose("- just\n- a list\n", [])).toThrow(UnprocessableEntityException);
  });
});
