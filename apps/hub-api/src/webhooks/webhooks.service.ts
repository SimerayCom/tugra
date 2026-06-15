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
  parseRef,
  refMatchesBranch,
  verifyGithubSignature,
  verifyGitlabToken,
} from "./webhook-verify";

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

  async handlePush(
    token: string,
    headers: Headers,
    rawBody: Buffer | string,
  ): Promise<WebhookResult> {
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
