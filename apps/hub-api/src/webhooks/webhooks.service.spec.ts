import { createHmac } from "node:crypto";
import { WebhooksService } from "./webhooks.service";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { ApplicationsService } from "../applications/applications.service";

const SECRET = "wh-secret";
const crypto = { decrypt: () => SECRET } as unknown as CryptoService;
const audit = { log: jest.fn() } as unknown as AuditService;

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function make(prisma: Partial<PrismaService>, apps: Partial<ApplicationsService>) {
  // no migration run is live unless a spec says so
  const withRuns = { migrationRun: { findMany: jest.fn().mockResolvedValue([]) }, bulkTask: { count: jest.fn().mockResolvedValue(0) }, ...prisma };
  return new WebhooksService(withRuns as PrismaService, crypto, audit, apps as ApplicationsService);
}

describe("WebhooksService.handleGithubApp", () => {
  const body = JSON.stringify({ repository: { full_name: "acme/web" }, ref: "refs/heads/main" });

  it("verifies the source secret and deploys matching apps on push", async () => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const svc = make(
      {
        gitSource: { findUnique: jest.fn().mockResolvedValue({ id: "s1", webhookSecretEnc: "enc" }) },
        application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", source: "GIT", gitBranch: "main", gitUrl: "https://github.com/acme/web.git" }]) },
      } as unknown as PrismaService,
      { deployFromWebhook },
    );
    const r = await svc.handleGithubApp("s1", { "x-hub-signature-256": sign(body), "x-github-event": "push" }, body);
    expect(r.deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });

  it("rejects an invalid signature", async () => {
    const svc = make(
      { gitSource: { findUnique: jest.fn().mockResolvedValue({ id: "s1", webhookSecretEnc: "enc" }) } } as unknown as PrismaService,
      {},
    );
    await expect(
      svc.handleGithubApp("s1", { "x-hub-signature-256": "sha256=bad", "x-github-event": "push" }, body),
    ).rejects.toThrow(/signature/);
  });

  it("ignores events with no matching app", async () => {
    const deployFromWebhook = jest.fn();
    const svc = make(
      {
        gitSource: { findUnique: jest.fn().mockResolvedValue({ id: "s1", webhookSecretEnc: "enc" }) },
        application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", source: "GIT", gitBranch: "main", gitUrl: "https://github.com/other/repo.git" }]) },
      } as unknown as PrismaService,
      { deployFromWebhook },
    );
    const r = await svc.handleGithubApp("s1", { "x-hub-signature-256": sign(body), "x-github-event": "push" }, body);
    expect(r.deployed).toBe(false);
    expect(deployFromWebhook).not.toHaveBeenCalled();
  });
});

describe("WebhooksService.handle — [skip ci]", () => {
  const appRow = { id: "a1", source: "GIT", gitBranch: "main", webhookToken: "tok", webhookSecret: "enc" };

  function pushBody(message: string): string {
    return JSON.stringify({ ref: "refs/heads/main", head_commit: { message } });
  }

  it("skips the deploy when the head commit carries a skip marker", async () => {
    const deployFromWebhook = jest.fn();
    const body = pushBody("chore: docs [skip ci]");
    const svc = make(
      { application: { findUnique: jest.fn().mockResolvedValue(appRow) } } as unknown as PrismaService,
      { deployFromWebhook },
    );
    const r = await svc.handle("tok", { "x-hub-signature-256": sign(body) }, body);
    expect(r.deployed).toBe(false);
    expect(r.reason).toMatch(/skip/);
    expect(deployFromWebhook).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.deploy.skipped" }));
  });

  it("deploys normally without a skip marker", async () => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const body = pushBody("feat: ship it");
    const svc = make(
      { application: { findUnique: jest.fn().mockResolvedValue(appRow) } } as unknown as PrismaService,
      { deployFromWebhook },
    );
    const r = await svc.handle("tok", { "x-hub-signature-256": sign(body) }, body);
    expect(r.deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });
});

describe("WebhooksService.handle — auto-deploy switch + Gitea", () => {
  const base = { id: "a1", source: "GIT", gitBranch: "main", webhookToken: "tok", webhookSecret: "enc", autoDeploy: true };
  const body = JSON.stringify({ ref: "refs/heads/main", head_commit: { message: "feat: x" } });

  it("skips (acknowledged) when auto-deploy is off", async () => {
    const deployFromWebhook = jest.fn();
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue({ ...base, autoDeploy: false }) } } as unknown as PrismaService, { deployFromWebhook });
    const r = await svc.handle("tok", { "x-hub-signature-256": sign(body) }, body);
    expect(r.deployed).toBe(false);
    expect(r.reason).toMatch(/auto-deploy disabled/);
    expect(deployFromWebhook).not.toHaveBeenCalled();
  });

  it("authenticates a Gitea signature (hex HMAC, no prefix) and deploys", async () => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue(base) } } as unknown as PrismaService, { deployFromWebhook });
    const giteaSig = createHmac("sha256", SECRET).update(body).digest("hex");
    const r = await svc.handle("tok", { "x-gitea-signature": giteaSig }, body);
    expect(r.deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });

  it("authenticates a Bitbucket push (X-Hub-Signature sha256 + push.changes branch) and deploys", async () => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const bbBody = JSON.stringify({ push: { changes: [{ new: { type: "branch", name: "main" } }] } });
    const sig = "sha256=" + createHmac("sha256", SECRET).update(bbBody).digest("hex");
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue(base) } } as unknown as PrismaService, { deployFromWebhook });
    const r = await svc.handle("tok", { "x-hub-signature": sig }, bbBody);
    expect(r.deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });

  it("ignores a Bitbucket push to a non-tracked branch", async () => {
    const deployFromWebhook = jest.fn();
    const bbBody = JSON.stringify({ push: { changes: [{ new: { type: "branch", name: "feature" } }] } });
    const sig = "sha256=" + createHmac("sha256", SECRET).update(bbBody).digest("hex");
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue(base) } } as unknown as PrismaService, { deployFromWebhook });
    const r = await svc.handle("tok", { "x-hub-signature": sig }, bbBody);
    expect(r.deployed).toBe(false);
    expect(deployFromWebhook).not.toHaveBeenCalled();
  });
});

describe("WebhooksService.handle — watch paths", () => {
  const appRow = { id: "a1", source: "GIT", gitBranch: "main", webhookToken: "tok", webhookSecret: "enc", watchPaths: ["apps/api/**"] };
  const pushWith = (files: string[]) =>
    JSON.stringify({ ref: "refs/heads/main", head_commit: { message: "feat: x" }, commits: [{ added: files, modified: [], removed: [] }] });
  const run = (body: string, app = appRow) => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService, { deployFromWebhook });
    return { deployFromWebhook, p: svc.handle("tok", { "x-hub-signature-256": sign(body) }, body) };
  };

  it("deploys when a changed file matches a watch path", async () => {
    const { deployFromWebhook, p } = run(pushWith(["apps/api/src/x.ts"]));
    expect((await p).deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });

  it("skips (acknowledged) when no changed file matches", async () => {
    const { deployFromWebhook, p } = run(pushWith(["apps/web/src/x.ts"]));
    const r = await p;
    expect(r.deployed).toBe(false);
    expect(r.reason).toMatch(/watched path/);
    expect(deployFromWebhook).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.deploy.skipped" }));
  });

  it("fail-open: a push with no changed-file list deploys anyway", async () => {
    const { deployFromWebhook, p } = run(JSON.stringify({ ref: "refs/heads/main", head_commit: { message: "feat: x" } })); // no commits[]
    expect((await p).deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });

  it("no watch paths → deploys on any push (backward-compatible)", async () => {
    const { deployFromWebhook, p } = run(pushWith(["anything/x.ts"]), { ...appRow, watchPaths: [] });
    expect((await p).deployed).toBe(true);
    expect(deployFromWebhook).toHaveBeenCalledWith("a1");
  });
});

describe("WebhooksService.handle: pull requests", () => {
  const SHA = "e59094b8de0f2f91abbe4760a52d9137260252d8";
  const flush = () => new Promise((r) => setImmediate(r));
  const parent = {
    id: "a1", source: "GIT", gitUrl: "https://git.example.com/owner/repo.git", gitBranch: "main",
    webhookToken: "tok", webhookSecret: "enc", previewEnabled: true, autoDeploy: true,
  };
  const hexSig = (b: string) => createHmac("sha256", SECRET).update(b).digest("hex");

  function setup(app: Record<string, unknown> = parent) {
    const upsertPreview = jest.fn().mockResolvedValue(undefined);
    const removePreviewByPr = jest.fn().mockResolvedValue(undefined);
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue(app) } } as unknown as PrismaService, {
      upsertPreview,
      removePreviewByPr,
      deployFromWebhook,
    });
    return { svc, upsertPreview, removePreviewByPr, deployFromWebhook };
  }

  // Per-provider request builders (field names verified against provider docs; see pr-events.ts).
  const gitlabReq = (action: string, attrs: Record<string, unknown> = {}) => ({
    headers: { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": SECRET } as Record<string, string>,
    body: JSON.stringify({
      object_kind: "merge_request",
      project: { path_with_namespace: "owner/repo" },
      object_attributes: {
        iid: 16, action, source_branch: "feature/x", target_branch: "main", source_project_id: 2, target_project_id: 2,
        last_commit: { id: SHA }, target: { path_with_namespace: "owner/repo" }, ...attrs,
      },
    }),
  });
  const giteaReq = (action: string, over: Record<string, unknown> = {}, evt = "pull_request", hdr = "x-gitea-event", sigHdr = "x-gitea-signature") => {
    const body = JSON.stringify({
      action, number: 5,
      pull_request: {
        number: 5, head: { ref: "feat", sha: SHA, repo: { id: 3, full_name: "owner/repo" } },
        base: { ref: "main", repo: { id: 3, full_name: "owner/repo" } }, ...over,
      },
    });
    return { headers: { [hdr]: evt, [sigHdr]: hexSig(body), "x-github-event": evt } as Record<string, string>, body };
  };
  const bbcReq = (key: string, state = "OPEN", source: Record<string, unknown> = { full_name: "owner/repo", uuid: "{a}" }) => {
    const body = JSON.stringify({
      pullrequest: {
        id: 12, state,
        source: { branch: { name: "feature/z" }, commit: { hash: SHA }, repository: source },
        destination: { branch: { name: "main" }, repository: { full_name: "owner/repo", uuid: "{a}" } },
      },
    });
    return { headers: { "x-event-key": key, "x-hub-signature": sign(body) } as Record<string, string>, body };
  };
  const bbsReq = (key: string, fromRepoId = 84) => {
    const body = JSON.stringify({
      pullRequest: {
        id: 3,
        fromRef: { displayId: "a-branch", latestCommit: SHA, repository: { slug: "repo", id: fromRepoId, project: { key: "OWNER" } } },
        toRef: { displayId: "master", repository: { slug: "repo", id: 84, project: { key: "OWNER" } } },
      },
    });
    return { headers: { "x-event-key": key, "x-hub-signature": sign(body) } as Record<string, string>, body };
  };
  const ghReq = (action: string, headRepo: unknown = { full_name: "owner/repo" }) => {
    const body = JSON.stringify({
      action,
      pull_request: { number: 9, head: { ref: "gh-feat", sha: SHA, repo: headRepo }, base: { repo: { full_name: "owner/repo" } } },
    });
    return { headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) } as Record<string, string>, body };
  };

  type Req = { headers: Record<string, string>; body: string };
  const ok = (provider: string, branch: string, n: number, sha = SHA, onlyIfHeadChanged = false) => ({ provider, headSha: sha, onlyIfHeadChanged, branch, n });

  const upserts: [string, () => Req, ReturnType<typeof ok>][] = [
    ["gitlab open", () => gitlabReq("open"), ok("gitlab", "feature/x", 16)],
    ["gitlab update with oldrev", () => gitlabReq("update", { oldrev: "99f3ea32043ba3ecaa28de6046b420de70257d80" }), ok("gitlab", "feature/x", 16)],
    ["gitea synchronized", () => giteaReq("synchronized"), ok("gitea", "feat", 5)],
    ["forgejo opened", () => giteaReq("opened", {}, "pull_request", "x-forgejo-event", "x-forgejo-signature"), ok("forgejo", "feat", 5)],
    ["bitbucket cloud created", () => bbcReq("pullrequest:created"), ok("bitbucket", "feature/z", 12)],
    ["bitbucket cloud updated", () => bbcReq("pullrequest:updated"), ok("bitbucket", "feature/z", 12, SHA, true)],
    ["bitbucket server from_ref_updated", () => bbsReq("pr:from_ref_updated"), ok("bitbucket-server", "a-branch", 3)],
    ["github opened", () => ghReq("opened"), ok("github", "gh-feat", 9)],
  ];

  it.each(upserts)("%s upserts the preview with provider + head sha", async (_n, req, want) => {
    const { svc, upsertPreview } = setup();
    const { headers, body } = req();
    const r = await svc.handle("tok", headers, body);
    expect(r.deployed).toBe(true);
    expect(upsertPreview).toHaveBeenCalledWith(parent, want.n, want.branch, {
      provider: want.provider, headSha: want.headSha, onlyIfHeadChanged: want.onlyIfHeadChanged,
    });
  });

  it("labels a GitLab MR 'MR #n preview' and the others 'PR #n preview'", async () => {
    const a = gitlabReq("open");
    expect((await setup().svc.handle("tok", a.headers, a.body)).reason).toBe("MR #16 preview");
    const b = giteaReq("opened");
    expect((await setup().svc.handle("tok", b.headers, b.body)).reason).toBe("PR #5 preview");
  });

  const closes: [string, () => Req, number][] = [
    ["gitlab merge", () => gitlabReq("merge"), 16],
    ["gitlab close", () => gitlabReq("close"), 16],
    ["gitea closed", () => giteaReq("closed", { merged: true }), 5],
    ["forgejo closed", () => giteaReq("closed", {}, "pull_request", "x-forgejo-event", "x-forgejo-signature"), 5],
    ["bitbucket cloud fulfilled", () => bbcReq("pullrequest:fulfilled", "MERGED"), 12],
    ["bitbucket cloud rejected", () => bbcReq("pullrequest:rejected", "DECLINED"), 12],
    ["bitbucket server merged", () => bbsReq("pr:merged"), 3],
    ["bitbucket server declined", () => bbsReq("pr:declined"), 3],
    ["bitbucket server deleted", () => bbsReq("pr:deleted"), 3],
    ["github closed", () => ghReq("closed"), 9],
  ];
  it.each(closes)("%s removes the preview and never upserts", async (_n, req, num) => {
    const { svc, upsertPreview, removePreviewByPr } = setup();
    const { headers, body } = req();
    const r = await svc.handle("tok", headers, body);
    expect(r.deployed).toBe(false);
    expect(r.reason).toMatch(/closed → preview removed/);
    await flush();
    expect(removePreviewByPr).toHaveBeenCalledWith("a1", num);
    expect(upsertPreview).not.toHaveBeenCalled();
  });

  describe("gates", () => {
    it("previews disabled: ignored", async () => {
      const { svc, upsertPreview } = setup({ ...parent, previewEnabled: false });
      const { headers, body } = gitlabReq("open");
      expect(await svc.handle("tok", headers, body)).toEqual({ deployed: false, reason: "previews disabled (ignored)" });
      expect(upsertPreview).not.toHaveBeenCalled();
    });

    it("a non-GIT app ignores an upsert but a close still tears down", async () => {
      const compose = { ...parent, source: "COMPOSE" };
      const open = setup(compose);
      const o = gitlabReq("open");
      expect((await open.svc.handle("tok", o.headers, o.body)).reason).toBe("previews need a Git-built app (ignored)");
      expect(open.upsertPreview).not.toHaveBeenCalled();
      const close = setup(compose);
      const c = gitlabReq("merge");
      await close.svc.handle("tok", c.headers, c.body);
      await flush();
      expect(close.removePreviewByPr).toHaveBeenCalledWith("a1", 16);
    });

    const forks: [string, () => Req][] = [
      ["gitlab", () => gitlabReq("open", { source_project_id: 77 })],
      ["gitea", () => giteaReq("opened", { head: { ref: "feat", sha: SHA, repo: { id: 4, full_name: "fork/repo" } } })],
      ["forgejo", () => giteaReq("opened", { head: { ref: "feat", sha: SHA, repo: { id: 4, full_name: "fork/repo" } } }, "pull_request", "x-forgejo-event", "x-forgejo-signature")],
      ["bitbucket cloud", () => bbcReq("pullrequest:created", "OPEN", { full_name: "someone/repo", uuid: "{b}" })],
      ["bitbucket server", () => bbsReq("pr:opened", 99)],
      ["github", () => ghReq("opened", { full_name: "fork/repo" })],
      ["gitea unknown head repo", () => giteaReq("opened", { head: { ref: "feat", sha: SHA, repo: null } })],
      ["github unknown head repo", () => ghReq("opened", null)],
    ];
    it.each(forks)("%s fork PR: not deployed, audited as skipped", async (_n, req) => {
      (audit.log as jest.Mock).mockClear();
      const { svc, upsertPreview } = setup();
      const { headers, body } = req();
      const r = await svc.handle("tok", headers, body);
      expect(r).toEqual({ deployed: false, reason: "fork pull request (ignored)" });
      await flush();
      expect(upsertPreview).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "preview.skipped", meta: expect.objectContaining({ reason: "fork-or-unknown-head-repo" }) }));
    });

    it("repository mismatch (non-GitHub) is ignored for upsert AND close", async () => {
      const other = { ...parent, gitUrl: "https://git.example.com/other/thing.git" };
      for (const req of [gitlabReq("open"), gitlabReq("merge"), giteaReq("opened"), giteaReq("closed"), bbcReq("pullrequest:created"), bbsReq("pr:opened")]) {
        const { svc, upsertPreview, removePreviewByPr } = setup(other);
        const r = await svc.handle("tok", req.headers, req.body);
        expect(r).toEqual({ deployed: false, reason: "repository mismatch (ignored)" });
        await flush();
        expect(upsertPreview).not.toHaveBeenCalled();
        expect(removePreviewByPr).not.toHaveBeenCalled();
      }
    });

    it("an unsafe branch name is ignored", async () => {
      for (const ref of ["a b", "-rf", "x;rm", "a..b"]) {
        const { svc, upsertPreview } = setup();
        const { headers, body } = giteaReq("opened", { head: { ref, sha: SHA, repo: { id: 3, full_name: "owner/repo" } } });
        expect((await svc.handle("tok", headers, body)).reason).toBe("unsupported branch name (ignored)");
        expect(upsertPreview).not.toHaveBeenCalled();
      }
    });

    it("a GitLab update without new commits and an irrelevant action are ignored with a reason", async () => {
      const a = setup();
      const u = gitlabReq("update");
      expect((await a.svc.handle("tok", u.headers, u.body)).reason).toBe("MR update without new commits (ignored)");
      const g = setup();
      const e = ghReq("edited");
      expect((await g.svc.handle("tok", e.headers, e.body)).reason).toBe("PR action edited (ignored)");
      const b = setup();
      const m = bbsReq("pr:modified");
      expect((await b.svc.handle("tok", m.headers, m.body)).reason).toBe("bitbucket-server modified (ignored)");
      expect(a.upsertPreview).not.toHaveBeenCalled();
    });

    it("an upsertPreview rejection is audited as preview.failed; the response is still deployed:true and nothing is unhandled", async () => {
      (audit.log as jest.Mock).mockClear();
      const { svc, upsertPreview } = setup();
      upsertPreview.mockRejectedValue(new Error("agent offline"));
      const { headers, body } = gitlabReq("open");
      const r = await svc.handle("tok", headers, body);
      expect(r.deployed).toBe(true);
      await flush();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "preview.failed", meta: expect.objectContaining({ provider: "gitlab", prNumber: 16, op: "upsert", error: "agent offline" }) }),
      );
    });

    it("a failing audit write inside the failure path never becomes an unhandled rejection", async () => {
      const { svc, upsertPreview, removePreviewByPr } = setup();
      upsertPreview.mockRejectedValue(new Error("boom"));
      removePreviewByPr.mockRejectedValue(new Error("boom"));
      (audit.log as jest.Mock).mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"));
      const o = gitlabReq("open");
      const c = gitlabReq("close");
      await svc.handle("tok", o.headers, o.body);
      await svc.handle("tok", c.headers, c.body);
      await flush();
      (audit.log as jest.Mock).mockReset();
    });
  });

  describe("auth", () => {
    it("accepts Gitea with a bad sha1 X-Hub-Signature next to a valid X-Gitea-Signature", async () => {
      const { svc, upsertPreview } = setup();
      const { headers, body } = giteaReq("opened");
      const r = await svc.handle("tok", { ...headers, "x-hub-signature": "sha1=deadbeef" }, body);
      expect(r.deployed).toBe(true);
      expect(upsertPreview).toHaveBeenCalled();
    });
    it("rejects no signature header and an unknown token", async () => {
      const { svc } = setup();
      const { body } = giteaReq("opened");
      await expect(svc.handle("tok", { "x-gitea-event": "pull_request" }, body)).rejects.toThrow(/invalid webhook signature/);
      const unknown = make({ application: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService, {});
      await expect(unknown.handle("nope", { "x-gitea-signature": hexSig(body) }, body)).rejects.toThrow(/invalid webhook token/);
    });
    it("rejects a wrong GitLab token", async () => {
      const { svc } = setup();
      const { headers, body } = gitlabReq("open");
      await expect(svc.handle("tok", { ...headers, "x-gitlab-token": "wrong" }, body)).rejects.toThrow(/invalid webhook signature/);
    });
  });

  describe("existing behaviour preserved", () => {
    it("a GitLab Push Hook, a Gitea push and a Bitbucket repo:push still reach handlePush", async () => {
      const push = JSON.stringify({ ref: "refs/heads/main", head_commit: { message: "x" } });
      const cases: Record<string, string>[] = [
        { "x-gitlab-event": "Push Hook", "x-gitlab-token": SECRET },
        { "x-gitea-event": "push", "x-gitea-signature": hexSig(push) },
        { "x-event-key": "repo:push", "x-hub-signature": sign(push) },
        { "x-github-event": "push", "x-hub-signature-256": sign(push) },
      ];
      for (const headers of cases) {
        const { svc, deployFromWebhook } = setup();
        expect((await svc.handle("tok", headers, push)).deployed).toBe(true);
        expect(deployFromWebhook).toHaveBeenCalledWith("a1");
      }
    });

    it("a Gitea pull_request_review_* event does not deploy, even for an app with an empty gitBranch", async () => {
      const { svc, deployFromWebhook, upsertPreview } = setup({ ...parent, gitBranch: "" });
      const body = JSON.stringify({ action: "reviewed" });
      const r = await svc.handle("tok", { "x-gitea-event": "pull_request_review_approved", "x-gitea-signature": hexSig(body) }, body);
      expect(r.deployed).toBe(false);
      expect(deployFromWebhook).not.toHaveBeenCalled();
      expect(upsertPreview).not.toHaveBeenCalled();
    });

    it("an event with no recognised provider header (IMAGE registry webhook) still goes to handlePush", async () => {
      const { svc, deployFromWebhook } = setup({ ...parent, source: "IMAGE", gitUrl: null, gitBranch: null });
      const body = JSON.stringify({ push_data: { tag: "latest" } });
      expect((await svc.handle("tok", { "x-hub-signature-256": sign(body) }, body)).deployed).toBe(true);
      expect(deployFromWebhook).toHaveBeenCalledWith("a1");
    });
  });
});

describe("WebhooksService.handleGithubApp: previews", () => {
  const flush = () => new Promise((r) => setImmediate(r));
  const source = { id: "s1", webhookSecretEnc: "enc" };
  const parentApp = { id: "p1", source: "GIT", gitUrl: "https://github.com/acme/web.git", gitBranch: "main", previewEnabled: true, isPreview: false };
  const prBody = (action: string) =>
    JSON.stringify({
      action,
      repository: { full_name: "acme/web" },
      pull_request: { number: 4, head: { ref: "feat", sha: "abc1234", repo: { full_name: "acme/web" } }, base: { repo: { full_name: "acme/web" } } },
    });

  it("queries only non-preview apps for the fan-out (no double build of a preview)", async () => {
    const findMany = jest.fn().mockResolvedValue([parentApp]);
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(source) }, application: { findMany } } as unknown as PrismaService, { deployFromWebhook });
    const body = JSON.stringify({ repository: { full_name: "acme/web" }, ref: "refs/heads/main" });
    await svc.handleGithubApp("s1", { "x-hub-signature-256": sign(body), "x-github-event": "push" }, body);
    expect(findMany).toHaveBeenCalledWith({ where: { gitSourceId: "s1", isPreview: false } });
  });

  it("a parent PR event still upserts a preview (provider github)", async () => {
    const upsertPreview = jest.fn().mockResolvedValue(undefined);
    const svc = make(
      { gitSource: { findUnique: jest.fn().mockResolvedValue(source) }, application: { findMany: jest.fn().mockResolvedValue([parentApp]) } } as unknown as PrismaService,
      { upsertPreview },
    );
    const body = prBody("synchronize");
    const r = await svc.handleGithubApp("s1", { "x-hub-signature-256": sign(body), "x-github-event": "pull_request" }, body);
    expect(r.deployed).toBe(true);
    await flush();
    expect(upsertPreview).toHaveBeenCalledWith(parentApp, 4, "feat", { provider: "github", headSha: "abc1234", onlyIfHeadChanged: false });
  });

  it("a preview row in the source's app list is never handed to handlePush", async () => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    // The DB-level filter does the excluding; this guards the contract that the service only ever sees the filtered rows.
    const findMany = jest.fn().mockImplementation(({ where }: { where: { isPreview?: boolean } }) =>
      Promise.resolve([parentApp, { ...parentApp, id: "pv1", isPreview: true }].filter((a) => where.isPreview === undefined || a.isPreview === where.isPreview)),
    );
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(source) }, application: { findMany } } as unknown as PrismaService, { deployFromWebhook });
    const body = JSON.stringify({ repository: { full_name: "acme/web" }, ref: "refs/heads/main" });
    await svc.handleGithubApp("s1", { "x-hub-signature-256": sign(body), "x-github-event": "push" }, body);
    expect(deployFromWebhook).toHaveBeenCalledTimes(1);
    expect(deployFromWebhook).toHaveBeenCalledWith("p1");
  });
});

describe("WebhooksService.handle: apps a guided migration run holds (R17/R64)", () => {
  const base = { id: "a1", source: "GIT", gitBranch: "main", webhookToken: "tok", webhookSecret: "enc", autoDeploy: true };
  const body = JSON.stringify({ ref: "refs/heads/main", head_commit: { message: "feat: x" } });
  const call = (svc: WebhooksService) => svc.handle("tok", { "x-hub-signature-256": sign(body) }, body);

  it("acknowledges the push and deploys nothing while the app belongs to a run's import op before the point of no return", async () => {
    const deployFromWebhook = jest.fn();
    const findMany = jest.fn().mockResolvedValue([{ opId: "op1" }]);
    const count = jest.fn().mockResolvedValue(1);
    const svc = make({ application: { findUnique: jest.fn().mockResolvedValue(base) }, migrationRun: { findMany }, bulkTask: { count } } as unknown as PrismaService, { deployFromWebhook });
    const r = await call(svc);
    expect(r).toMatchObject({ deployed: false, reason: expect.stringMatching(/guided migration run/) });
    expect(deployFromWebhook).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0].where).toMatchObject({ ponrAt: null, opId: { not: null } });
    expect(count.mock.calls[0][0].where).toMatchObject({ opId: { in: ["op1"] }, resourceId: "a1" });
  });

  it("deploys an app that is not part of the live run's op, and asks nothing more when no run is live", async () => {
    const deployFromWebhook = jest.fn().mockResolvedValue(undefined);
    const count = jest.fn().mockResolvedValue(0);
    const other = make({ application: { findUnique: jest.fn().mockResolvedValue(base) }, migrationRun: { findMany: jest.fn().mockResolvedValue([{ opId: "op1" }]) }, bulkTask: { count } } as unknown as PrismaService, { deployFromWebhook });
    expect((await call(other)).deployed).toBe(true);
    const none = jest.fn();
    const quiet = make({ application: { findUnique: jest.fn().mockResolvedValue(base) }, bulkTask: { count: none } } as unknown as PrismaService, { deployFromWebhook });
    expect((await call(quiet)).deployed).toBe(true);
    expect(none).not.toHaveBeenCalled();
  });
});
