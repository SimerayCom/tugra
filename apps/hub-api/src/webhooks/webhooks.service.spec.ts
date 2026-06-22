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
  return new WebhooksService(prisma as PrismaService, crypto, audit, apps as ApplicationsService);
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
