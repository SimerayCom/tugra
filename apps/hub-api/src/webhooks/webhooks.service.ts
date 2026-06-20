import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { ApplicationsService } from "../applications/applications.service";
import {
  parsePullRequest,
  parseRef,
  refMatchesBranch,
  verifyGithubSignature,
  verifyGitlabToken,
} from "./webhook-verify";
import type { Application } from "@prisma/client";

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

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
   * then dispatches on the git event type: GitHub `pull_request` events drive
   * preview deployments, everything else is treated as a push → deploy.
   */
  async handle(
    token: string,
    headers: Headers,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    const app = await this.authenticate(token, headers, rawBody);
    if (header(headers, "x-github-event") === "pull_request") {
      return this.handlePullRequest(app, rawBody);
    }
    return this.handlePush(app, rawBody);
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
      throw new NotFoundException("webhook not found");
    }
    const secret = this.crypto.decrypt(app.webhookSecret);

    const ghSig = header(headers, "x-hub-signature-256");
    const glToken = header(headers, "x-gitlab-token");
    const ok =
      ghSig != null
        ? verifyGithubSignature(secret, rawBody, ghSig)
        : glToken != null
          ? verifyGitlabToken(secret, glToken)
          : false;
    if (!ok) throw new UnauthorizedException("invalid webhook signature");
    return app;
  }

  /** GitHub pull_request event → create/update or tear down a PR preview. */
  private async handlePullRequest(
    app: Application,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    if (!app.previewEnabled) {
      return { deployed: false, reason: "previews disabled (ignored)" };
    }
    const ev = parsePullRequest(this.parseBody(rawBody));
    if (!ev) return { deployed: false, reason: "not a usable PR event (ignored)" };

    if (ev.action === "closed") {
      void this.apps.removePreviewByPr(app.id, ev.prNumber).catch(() => undefined);
      return { deployed: false, reason: "PR closed → preview removed" };
    }
    if (["opened", "synchronize", "reopened"].includes(ev.action)) {
      void this.apps.upsertPreview(app, ev.prNumber, ev.headRef).catch(() => undefined);
      return { deployed: true, reason: `PR #${ev.prNumber} preview` };
    }
    return { deployed: false, reason: `PR action ${ev.action} (ignored)` };
  }

  private async handlePush(
    app: Application,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
    const ref = parseRef(this.parseBody(rawBody));
    // Only deploy when the pushed branch matches the app's tracked branch.
    // A ping event (no ref) or a push to another branch is acknowledged but ignored.
    if (app.source === "GIT" && app.gitBranch) {
      if (!ref) return { deployed: false, reason: "no ref (ignored)" };
      if (!refMatchesBranch(ref, app.gitBranch)) {
        return { deployed: false, reason: "branch mismatch (ignored)" };
      }
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
