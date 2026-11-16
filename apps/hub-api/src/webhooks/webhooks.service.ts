import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LIVE_RUN_STATUSES } from "../migration-runs/core/run-contract";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { ApplicationsService } from "../applications/applications.service";
import {
  hasSkipMarker,
  header,
  parseHeadCommitMessage,
  parseRef,
  refMatchesBranch,
  repoFullName,
  verifyGithubSignature,
  verifyWebhookRequest,
} from "./webhook-verify";
import { detectGitEvent, isSafePreviewBranch, normalizePullRequest, type NormalizedPr, type PrProvider } from "./pr-events";
import { parseChangedFiles, pushMatchesWatchPaths } from "./watch-paths";
import type { Application } from "@prisma/client";

type Headers = Record<string, string | string[] | undefined>;

export interface WebhookResult {
  deployed: boolean;
  reason?: string;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly apps: ApplicationsService,
  ) {}

  /**
   * Entry point for the public webhook receiver. Authenticates the request,
   * then dispatches on the git event type (detected from the provider's own headers): GitHub / GitLab / Gitea /
   * Forgejo / Bitbucket pull- or merge-request events drive preview deployments, everything else is treated as a
   * push → deploy.
   */
  async handle(
    token: string,
    headers: Headers,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    const app = await this.authenticate(token, headers, rawBody);
    const ev = detectGitEvent(headers);
    if (ev.kind === "pr" && ev.provider) return this.handlePullRequest(app, ev.provider, ev.name, rawBody);
    // Gitea/Forgejo pull_request_* siblings (review, comment, label …) must not fall into handlePush.
    if (ev.kind === "ignore") return { deployed: false, reason: `${ev.name} (ignored)` };
    return this.handlePush(app, rawBody);
  }

  /**
   * GitHub App webhook receiver: one endpoint per registered source. Verifies
   * the source's webhook secret, then fans out to every app wired to that
   * source whose repo (gitUrl) matches the event's repository.
   */
  async handleGithubApp(
    sourceId: string,
    headers: Headers,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    const source = await this.prisma.gitSource.findUnique({ where: { id: sourceId } });
    if (!source || !source.webhookSecretEnc) throw new NotFoundException("git source webhook not found");
    const secret = this.crypto.decrypt(source.webhookSecretEnc);
    const ghSig = header(headers, "x-hub-signature-256");
    if (!ghSig || !verifyGithubSignature(secret, rawBody, ghSig)) {
      throw new UnauthorizedException("invalid webhook signature");
    }
    const body = this.parseBody(rawBody) as { repository?: { full_name?: string } };
    const fullName = body.repository?.full_name?.toLowerCase();
    if (!fullName) return { deployed: false, reason: "no repository (ignored)" };

    // Preview apps copy gitSourceId and default autoDeploy on, and track the PR head branch: fanning a push out to
    // them would redeploy the preview via handlePush AND via the PR `synchronize` event (a double build).
    const apps = await this.prisma.application.findMany({ where: { gitSourceId: sourceId, isPreview: false } });
    // Exact owner/repo match — NOT a substring (a push to acme/app must not redeploy acme/app-2).
    const matched = apps.filter((a) => repoFullName(a.gitUrl) === fullName);
    if (!matched.length) return { deployed: false, reason: "no matching app (ignored)" };

    const isPr = header(headers, "x-github-event") === "pull_request";
    let deployed = false;
    for (const app of matched) {
      const r = isPr ? await this.handlePullRequest(app, "github", "pull_request", rawBody) : await this.handlePush(app, rawBody);
      deployed = deployed || r.deployed;
    }
    return { deployed };
  }

  /** Resolve the app from the token and verify the request signature. */
  private async authenticate(
    token: string,
    headers: Headers,
    rawBody: Buffer | string,
  ): Promise<Application> {
    const app = await this.prisma.application.findUnique({
      where: { webhookToken: token },
    });
    if (!app || !app.webhookSecret) {
      // A bad/unknown deploy token is an auth failure, not a routing 404 — this keeps the bare
      // (un-prefixed) webhook route provably mounted and doesn't leak whether a token exists.
      throw new UnauthorizedException("invalid webhook token");
    }
    const secret = this.crypto.decrypt(app.webhookSecret);

    // Any present scheme that verifies is accepted (see verifyWebhookRequest) — no unsigned path exists.
    const ok = verifyWebhookRequest(secret, headers, rawBody);
    if (!ok) throw new UnauthorizedException("invalid webhook signature");
    return app;
  }

  /**
   * PR / MR event (any provider) → create/update or tear down a preview. Every early return is a 202 with a
   * `reason` — providers show the response body in their delivery UI, which is the "why no preview" diagnostic.
   *
   * Fail closed: the preview clone is a BRANCH clone of the PARENT repo by name — never a PR ref, never SHA-pinned.
   * A fork's head.ref therefore either 404s or silently builds a same-named branch of the base repo (wrong code), and
   * building fork code would hand an outside author's code the parent's copied env, gitTokenEnc, deploy key and
   * registryAuthEnc. So fork / unknown-head-repo PRs are ignored. Same-repo PR authors have write access;
   * `previewExcludeKeys` stays the only mitigation for them.
   */
  private async handlePullRequest(
    app: Application,
    provider: PrProvider,
    eventName: string | null,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    if (!app.previewEnabled) {
      return { deployed: false, reason: "previews disabled (ignored)" };
    }
    const ev = normalizePullRequest(provider, this.parseBody(rawBody), eventName);
    if (!ev) return { deployed: false, reason: "not a usable PR event (ignored)" };
    if (ev.action === "ignore") {
      return {
        deployed: false,
        reason: ev.ignoreReason ?? (provider === "github" ? `PR action ${ev.rawAction} (ignored)` : `${provider} ${ev.rawAction} (ignored)`),
      };
    }
    const label = provider === "gitlab" ? "MR" : "PR";

    // Close events still tear down whatever exists; only upserts need a Git-built app.
    if (ev.action !== "close" && (app.source !== "GIT" || !app.gitUrl)) {
      return { deployed: false, reason: "previews need a Git-built app (ignored)" };
    }

    // Repo binding for non-GitHub providers (the GitHub per-app path keeps today's behaviour): a hook pointed at a
    // different repository must not clone a same-named branch of the wrong repo. Unknown on either side → skipped
    // (the fork gate below still applies to upserts).
    if (provider !== "github") {
      const mine = repoFullName(app.gitUrl);
      if (mine && ev.baseRepo && mine !== ev.baseRepo) {
        return { deployed: false, reason: "repository mismatch (ignored)" };
      }
    }

    if (ev.action === "close") {
      void this.apps.removePreviewByPr(app.id, ev.prNumber).catch((e) => this.auditPreviewFailure(app, ev, "remove", e));
      return { deployed: false, reason: `${label} closed → preview removed` };
    }

    if (!ev.sameRepo) {
      try {
        await this.audit.log({
          actor: "webhook:pr",
          action: "preview.skipped",
          target: app.id,
          meta: { provider, prNumber: ev.prNumber, reason: "fork-or-unknown-head-repo" },
        });
      } catch {
        /* an audit-write failure must not turn a safe ignore into a 500 */
      }
      return { deployed: false, reason: "fork pull request (ignored)" };
    }
    if (!ev.headRef || !isSafePreviewBranch(ev.headRef)) {
      return { deployed: false, reason: "unsupported branch name (ignored)" };
    }
    void this.apps
      .upsertPreview(app, ev.prNumber, ev.headRef, {
        provider,
        headSha: ev.headSha,
        onlyIfHeadChanged: ev.action === "upsert-if-head-changed",
      })
      .catch((e) => this.auditPreviewFailure(app, ev, "upsert", e));
    return { deployed: true, reason: `${label} #${ev.prNumber} preview` };
  }

  /** Audit a failed fire-and-forget preview op. Never throws (it is the last line of a detached promise). */
  private async auditPreviewFailure(app: Application, ev: NormalizedPr, op: "upsert" | "remove", err: unknown): Promise<void> {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      await this.audit.log({
        actor: "webhook:pr",
        action: "preview.failed",
        target: app.id,
        meta: { provider: ev.provider, prNumber: ev.prNumber, op, error: String(msg).slice(0, 300) },
      });
    } catch {
      /* the audit trail itself failing must never become an unhandled rejection */
    }
  }

  /** Is the app a resource of the import op of a live migration run that has not passed its point of no return? One cheap read when no run is live. */
  private async heldByMigrationRun(appId: string): Promise<boolean> {
    const runs = await this.prisma.migrationRun.findMany({ where: { ponrAt: null, opId: { not: null }, status: { in: [...LIVE_RUN_STATUSES] } }, select: { opId: true }, take: 100 });
    const opIds = runs.map((r) => r.opId).filter((x): x is string => !!x);
    if (!opIds.length) return false;
    return (await this.prisma.bulkTask.count({ where: { opId: { in: opIds }, kind: "app", resourceType: "application", resourceId: appId } })) > 0;
  }

  private async handlePush(
    app: Application,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    const payload = this.parseBody(rawBody);
    const ref = parseRef(payload);
    // Per-app push-to-deploy switch: when off, the push is acknowledged (so the provider sees 2xx) but no
    // deploy runs — pause auto-deploy without deleting the webhook.
    if (app.autoDeploy === false) {
      return { deployed: false, reason: "auto-deploy disabled (ignored)" };
    }
    // An app a guided migration run imported is not deployed by a push until the run passed its point of no return: while the
    // source is authoritative a push would deploy it on both sides. The run switches the per-app flag off once its import settled;
    // this closes the gap while the import is still creating apps (the flag is not set yet then).
    if (await this.heldByMigrationRun(app.id)) {
      return { deployed: false, reason: "held by a guided migration run (ignored)" };
    }
    // Only deploy when the pushed branch matches the app's tracked branch. This applies to a GIT build AND
    // a git-sourced compose (source=COMPOSE + gitUrl); a ping (no ref) or a push to another branch is
    // acknowledged but ignored.
    const gitSourced = app.source === "GIT" || (app.source === "COMPOSE" && !!app.gitUrl);
    if (gitSourced && app.gitBranch) {
      if (!ref) return { deployed: false, reason: "no ref (ignored)" };
      if (!refMatchesBranch(ref, app.gitBranch)) {
        return { deployed: false, reason: "branch mismatch (ignored)" };
      }
    }

    // Watch paths: when the app restricts deploys to certain globs, only a push that TOUCHES one of them
    // deploys (a monorepo otherwise rebuilds every app on every push). Fail-open — a push whose payload
    // lists no changed files (truncated / fileless) deploys as before, so a real change is never skipped.
    const watchPaths = app.watchPaths ?? [];
    if (watchPaths.length > 0) {
      const changed = parseChangedFiles(payload);
      if (changed && !pushMatchesWatchPaths(changed, watchPaths)) {
        await this.audit.log({
          actor: "webhook",
          action: "app.deploy.skipped",
          target: app.id,
          meta: { trigger: "git-push", ref: ref ?? null, reason: "no watched path changed" },
        });
        return { deployed: false, reason: "no watched path changed (ignored)" };
      }
    }

    // Standard CI/CD convention: a `[skip ci]`/`[skip deploy]` marker in the head
    // commit message suppresses the auto-deploy (the push is acknowledged).
    if (hasSkipMarker(parseHeadCommitMessage(payload))) {
      await this.audit.log({
        actor: "webhook",
        action: "app.deploy.skipped",
        target: app.id,
        meta: { trigger: "git-push", ref: ref ?? null, reason: "skip marker" },
      });
      return { deployed: false, reason: "skipped by commit message" };
    }

    await this.audit.log({
      actor: "webhook",
      action: "app.deploy",
      target: app.id,
      meta: { trigger: "git-push", ref: ref ?? null },
    });
    // Fire-and-forget: builds take minutes; the git provider must not wait.
    void this.apps.deployFromWebhook(app.id).catch(() => undefined);
    return { deployed: true };
  }

  private parseBody(rawBody: Buffer | string): unknown {
    try {
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }
}
