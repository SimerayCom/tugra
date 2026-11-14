import { detectGitEvent, isSafePreviewBranch, isValidPrNumber, normalizePullRequest } from "./pr-events";
import { repoFullName } from "./webhook-verify";

const SHA = "e59094b8de0f2f91abbe4760a52d9137260252d8";

// ── Fixtures: field names verified against each provider's docs / schema (see pr-events.ts header) ──

function gh(action: string, over: Record<string, unknown> = {}) {
  return {
    action,
    pull_request: {
      number: 42,
      merged: false,
      head: { ref: "feature/x", sha: SHA, repo: { full_name: "Acme/App" } },
      base: { ref: "main", repo: { full_name: "acme/app" } },
      ...over,
    },
  };
}

function gitea(action: string, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    action,
    number: 5,
    pull_request: {
      number: 5,
      merged: false,
      head: { ref: "feat", sha: SHA, repo_id: 3, repo: { id: 3, full_name: "owner/repo" } },
      base: { ref: "main", repo_id: 3, repo: { id: 3, full_name: "owner/repo" } },
      ...over,
    },
    ...top,
  };
}

function gitlab(action: string, attrs: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    object_kind: "merge_request",
    project: { path_with_namespace: "flightjs/flight-management" },
    object_attributes: {
      id: 93,
      iid: 16,
      action,
      source_branch: "feature/booking-validation",
      target_branch: "main",
      source_project_id: 2,
      target_project_id: 2,
      last_commit: { id: SHA },
      source: { path_with_namespace: "flightjs/flight-management" },
      target: { path_with_namespace: "flightjs/flight-management" },
      ...attrs,
    },
    ...top,
  };
}

function bbc(state = "OPEN", over: Record<string, unknown> = {}) {
  return {
    actor: { display_name: "x" },
    repository: { full_name: "ws/repo" },
    pullrequest: {
      id: 12,
      state,
      source: {
        branch: { name: "feature/z" },
        commit: { hash: SHA },
        repository: { full_name: "ws/repo", uuid: "{aaa}" },
      },
      destination: {
        branch: { name: "main" },
        commit: { hash: "def4567" },
        repository: { full_name: "ws/repo", uuid: "{aaa}" },
      },
      ...over,
    },
  };
}

function bbs(over: Record<string, unknown> = {}) {
  return {
    eventKey: "pr:opened",
    pullRequest: {
      id: 1,
      state: "OPEN",
      fromRef: {
        id: "refs/heads/a-branch",
        displayId: "a-branch",
        latestCommit: SHA,
        repository: { slug: "repository", id: 84, project: { key: "PROJ" } },
      },
      toRef: {
        id: "refs/heads/master",
        displayId: "master",
        latestCommit: "178864a7d521b6f5e720b386b2c2b0ef8563e0dc",
        repository: { slug: "repository", id: 84, project: { key: "PROJ" } },
      },
      ...over,
    },
  };
}

describe("detectGitEvent", () => {
  it("gitlab Merge Request Hook is a PR; other gitlab events are untouched", () => {
    expect(detectGitEvent({ "x-gitlab-event": "Merge Request Hook" })).toEqual({ provider: "gitlab", kind: "pr", name: "Merge Request Hook" });
    expect(detectGitEvent({ "x-gitlab-event": "Push Hook" }).kind).toBe("other");
    expect(detectGitEvent({ "x-gitlab-event": "Note Hook" }).kind).toBe("other");
  });

  it("gitea / forgejo pull_request is a PR and forgejo wins over gitea", () => {
    expect(detectGitEvent({ "x-gitea-event": "pull_request" })).toMatchObject({ provider: "gitea", kind: "pr" });
    expect(detectGitEvent({ "x-gitea-event": "pull_request_sync" })).toMatchObject({ provider: "gitea", kind: "pr" });
    expect(detectGitEvent({ "x-gitea-event": "pull_request", "x-forgejo-event": "pull_request" })).toMatchObject({ provider: "forgejo", kind: "pr" });
    expect(detectGitEvent({ "x-gitea-event": "push" }).kind).toBe("other");
  });

  it("a gitea delivery that ALSO carries X-GitHub-Event is gitea, not github", () => {
    expect(detectGitEvent({ "x-gitea-event": "pull_request", "x-github-event": "pull_request" }).provider).toBe("gitea");
    expect(detectGitEvent({ "x-gitea-event": "push", "x-github-event": "push" }).provider).toBe("gitea");
  });

  it("gitea pull_request_* siblings are ignored (never reach handlePush)", () => {
    for (const n of ["pull_request_review_approved", "pull_request_comment", "pull_request_label", "pull_request_assign", "pull_request_review_request"]) {
      expect(detectGitEvent({ "x-gitea-event": n }).kind).toBe("ignore");
    }
  });

  it("bitbucket cloud / server event keys", () => {
    expect(detectGitEvent({ "x-event-key": "pullrequest:created" })).toMatchObject({ provider: "bitbucket", kind: "pr" });
    expect(detectGitEvent({ "x-event-key": "pr:opened" })).toMatchObject({ provider: "bitbucket-server", kind: "pr" });
    expect(detectGitEvent({ "x-event-key": "repo:push" }).kind).toBe("other");
    expect(detectGitEvent({ "x-event-key": "repo:refs_changed" }).kind).toBe("other");
  });

  it("github pull_request is a PR; no headers is other/null", () => {
    expect(detectGitEvent({ "x-github-event": "pull_request" })).toMatchObject({ provider: "github", kind: "pr" });
    expect(detectGitEvent({ "x-github-event": "push" }).kind).toBe("other");
    expect(detectGitEvent({})).toEqual({ provider: null, kind: "other", name: null });
  });
});

describe("normalizePullRequest: github", () => {
  it.each(["opened", "reopened", "synchronize"])("%s upserts", (a) => {
    const n = normalizePullRequest("github", gh(a));
    expect(n).toMatchObject({ action: "upsert", prNumber: 42, headRef: "feature/x", headSha: SHA, baseRepo: "acme/app", sameRepo: true });
  });
  it("closed closes; edited is ignored", () => {
    expect(normalizePullRequest("github", gh("closed"))?.action).toBe("close");
    expect(normalizePullRequest("github", gh("edited"))?.action).toBe("ignore");
  });
  it("null head.repo (deleted fork) and a different head repo are not sameRepo", () => {
    expect(normalizePullRequest("github", gh("opened", { head: { ref: "f", sha: SHA, repo: null } }))?.sameRepo).toBe(false);
    expect(normalizePullRequest("github", gh("opened", { head: { ref: "f", sha: SHA, repo: { full_name: "evil/app" } } }))?.sameRepo).toBe(false);
  });
  it("a missing sha gives headSha null; a missing ref upsert / bad number gives null", () => {
    expect(normalizePullRequest("github", gh("opened", { head: { ref: "f", repo: { full_name: "acme/app" } } }))?.headSha).toBeNull();
    expect(normalizePullRequest("github", gh("opened", { head: { sha: SHA } }))).toBeNull();
    expect(normalizePullRequest("github", gh("opened", { number: "42" }))).toBeNull();
    expect(normalizePullRequest("github", null)).toBeNull();
  });
});

describe("normalizePullRequest: gitea / forgejo", () => {
  it.each(["opened", "reopened", "synchronized", "synchronize"])("%s upserts", (a) => {
    for (const p of ["gitea", "forgejo"] as const) {
      expect(normalizePullRequest(p, gitea(a))).toMatchObject({ provider: p, action: "upsert", prNumber: 5, headRef: "feat", headSha: SHA, baseRepo: "owner/repo", sameRepo: true });
    }
  });
  it("closed closes whether merged or not; other actions ignore", () => {
    expect(normalizePullRequest("gitea", gitea("closed", { merged: true }))?.action).toBe("close");
    expect(normalizePullRequest("gitea", gitea("closed", { merged: false }))?.action).toBe("close");
    expect(normalizePullRequest("gitea", gitea("edited"))?.action).toBe("ignore");
    expect(normalizePullRequest("gitea", gitea("label_updated"))?.action).toBe("ignore");
  });
  it("a deleted fork, a different head repo or conflicting repo ids are not sameRepo", () => {
    expect(normalizePullRequest("gitea", gitea("opened", { head: { ref: "f", sha: SHA, repo: null } }))?.sameRepo).toBe(false);
    expect(normalizePullRequest("gitea", gitea("opened", { head: { ref: "f", sha: SHA, repo: { id: 3, full_name: "fork/repo" } } }))?.sameRepo).toBe(false);
    expect(normalizePullRequest("gitea", gitea("opened", { head: { ref: "f", sha: SHA, repo: { id: 9, full_name: "owner/repo" } } }))?.sameRepo).toBe(false);
  });
  it("number falls back to the top level; a conflict gives null", () => {
    const noInner = gitea("opened");
    delete (noInner.pull_request as Record<string, unknown>).number;
    expect(normalizePullRequest("gitea", noInner)?.prNumber).toBe(5);
    expect(normalizePullRequest("gitea", gitea("opened", {}, { number: 6 }))).toBeNull();
  });
});

describe("normalizePullRequest: gitlab", () => {
  it("open and reopen upsert, using iid (not id)", () => {
    for (const a of ["open", "reopen"]) {
      expect(normalizePullRequest("gitlab", gitlab(a))).toMatchObject({
        action: "upsert", prNumber: 16, headRef: "feature/booking-validation", headSha: SHA, baseRepo: "flightjs/flight-management", sameRepo: true,
      });
    }
  });
  it("update WITH oldrev upserts; WITHOUT it is ignored with its own reason", () => {
    expect(normalizePullRequest("gitlab", gitlab("update", { oldrev: "99f3ea32043ba3ecaa28de6046b420de70257d80" }))?.action).toBe("upsert");
    const n = normalizePullRequest("gitlab", gitlab("update"));
    expect(n?.action).toBe("ignore");
    expect(n?.ignoreReason).toBe("MR update without new commits (ignored)");
    expect(normalizePullRequest("gitlab", gitlab("update", { oldrev: "" }))?.action).toBe("ignore");
  });
  it("close and merge close; approvals and unknown actions are ignored", () => {
    expect(normalizePullRequest("gitlab", gitlab("close"))?.action).toBe("close");
    expect(normalizePullRequest("gitlab", gitlab("merge"))?.action).toBe("close");
    for (const a of ["approved", "unapproved", "approval", "unapproval", "whatever"]) {
      expect(normalizePullRequest("gitlab", gitlab(a))?.action).toBe("ignore");
    }
  });
  it("differing or missing project ids are not sameRepo", () => {
    expect(normalizePullRequest("gitlab", gitlab("open", { source_project_id: 9 }))?.sameRepo).toBe(false);
    expect(normalizePullRequest("gitlab", gitlab("open", { source_project_id: undefined }))?.sameRepo).toBe(false);
    expect(normalizePullRequest("gitlab", gitlab("open", { target_project_id: "2", source_project_id: "2" }))?.sameRepo).toBe(false);
  });
  it("subgroup path gives the last two segments; falls back to project.path_with_namespace", () => {
    expect(normalizePullRequest("gitlab", gitlab("open", { target: { path_with_namespace: "G/Sub/Proj" } }))?.baseRepo).toBe("sub/proj");
    expect(normalizePullRequest("gitlab", gitlab("open", { target: undefined }, { project: { path_with_namespace: "a/b/c" } }))?.baseRepo).toBe("b/c");
  });
  it("a wrong object_kind gives null", () => {
    expect(normalizePullRequest("gitlab", { ...gitlab("open"), object_kind: "push" })).toBeNull();
  });
});

describe("normalizePullRequest: bitbucket cloud", () => {
  it("created upserts", () => {
    expect(normalizePullRequest("bitbucket", bbc(), "pullrequest:created")).toMatchObject({
      action: "upsert", prNumber: 12, headRef: "feature/z", headSha: SHA, baseRepo: "ws/repo", sameRepo: true,
    });
  });
  it("updated + OPEN is upsert-if-head-changed; MERGED / DECLINED is ignored", () => {
    expect(normalizePullRequest("bitbucket", bbc("OPEN"), "pullrequest:updated")?.action).toBe("upsert-if-head-changed");
    expect(normalizePullRequest("bitbucket", bbc("MERGED"), "pullrequest:updated")?.action).toBe("ignore");
    expect(normalizePullRequest("bitbucket", bbc("DECLINED"), "pullrequest:updated")?.action).toBe("ignore");
  });
  it("fulfilled and rejected close; approved / comments are ignored", () => {
    expect(normalizePullRequest("bitbucket", bbc("MERGED"), "pullrequest:fulfilled")?.action).toBe("close");
    expect(normalizePullRequest("bitbucket", bbc("DECLINED"), "pullrequest:rejected")?.action).toBe("close");
    expect(normalizePullRequest("bitbucket", bbc(), "pullrequest:approved")?.action).toBe("ignore");
    expect(normalizePullRequest("bitbucket", bbc(), "pullrequest:comment_created")?.action).toBe("ignore");
  });
  it("cross-repo, differing uuid or missing repo are not sameRepo", () => {
    const fork = bbc("OPEN", { source: { branch: { name: "f" }, commit: { hash: SHA }, repository: { full_name: "someone/repo" } } });
    expect(normalizePullRequest("bitbucket", fork, "pullrequest:created")?.sameRepo).toBe(false);
    const uuid = bbc("OPEN", { source: { branch: { name: "f" }, commit: { hash: SHA }, repository: { full_name: "ws/repo", uuid: "{bbb}" } } });
    expect(normalizePullRequest("bitbucket", uuid, "pullrequest:created")?.sameRepo).toBe(false);
    const none = bbc("OPEN", { source: { branch: { name: "f" }, commit: { hash: SHA } } });
    expect(normalizePullRequest("bitbucket", none, "pullrequest:created")?.sameRepo).toBe(false);
  });
  it("needs a pullrequest: event key", () => {
    expect(normalizePullRequest("bitbucket", bbc())).toBeNull();
    expect(normalizePullRequest("bitbucket", bbc(), "repo:push")).toBeNull();
  });
});

describe("normalizePullRequest: bitbucket server", () => {
  it("opened and from_ref_updated upsert", () => {
    for (const k of ["pr:opened", "pr:from_ref_updated"]) {
      expect(normalizePullRequest("bitbucket-server", bbs(), k)).toMatchObject({
        action: "upsert", prNumber: 1, headRef: "a-branch", headSha: SHA, baseRepo: "proj/repository", sameRepo: true,
      });
    }
  });
  it("merged, declined and deleted close; modified / reviewer / comment are ignored", () => {
    for (const k of ["pr:merged", "pr:declined", "pr:deleted"]) {
      expect(normalizePullRequest("bitbucket-server", bbs(), k)?.action).toBe("close");
    }
    for (const k of ["pr:modified", "pr:reviewer:approved", "pr:comment:added"]) {
      expect(normalizePullRequest("bitbucket-server", bbs(), k)?.action).toBe("ignore");
    }
  });
  it("a different repository.id is not sameRepo; baseRepo matches repoFullName of the clone URL", () => {
    const fork = bbs({
      fromRef: { displayId: "f", latestCommit: SHA, repository: { slug: "repository", id: 99, project: { key: "~USER" } } },
    });
    expect(normalizePullRequest("bitbucket-server", fork, "pr:opened")?.sameRepo).toBe(false);
    expect(normalizePullRequest("bitbucket-server", bbs(), "pr:opened")?.baseRepo).toBe("proj/repository");
    const other = bbs({ toRef: { displayId: "m", repository: { slug: "slug", id: 1, project: { key: "KEY" } } } });
    expect(normalizePullRequest("bitbucket-server", other, "pr:opened")?.baseRepo).toBe(repoFullName("https://bb/scm/KEY/slug.git"));
  });
});

describe("isValidPrNumber", () => {
  it.each([["7"], [0], [-1], [1.5], [2147483648], [NaN], [null], [undefined]])("rejects %p", (v) => {
    expect(isValidPrNumber(v)).toBe(false);
  });
  it("accepts 1 and the Int max", () => {
    expect(isValidPrNumber(1)).toBe(true);
    expect(isValidPrNumber(2147483647)).toBe(true);
  });
});

describe("isSafePreviewBranch", () => {
  it.each(["feature/x", "fix_1", "release-1.2", "a#b"])("accepts %s", (b) => expect(isSafePreviewBranch(b)).toBe(true));
  it.each(["-rf", "a..b", "a b", "a;b", "$(x)", "x.lock", "dir/", "a".repeat(256), "ünï", ""])("rejects %p", (b) => expect(isSafePreviewBranch(b)).toBe(false));
});
