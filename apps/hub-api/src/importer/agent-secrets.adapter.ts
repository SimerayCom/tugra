import { Injectable } from "@nestjs/common";
import type { CoolifySecretClass } from "@tugra/shared";
import { CryptoService } from "../crypto/crypto.service";
import { CoolifyHostGrantService } from "../coolify-takeover/coolify-host-grant.service";
import { CoolifySecretsService } from "../coolify-takeover/coolify-secrets.service";
import { AgentSecretStores, type AgentSecretsPort } from "./sources/agent-secrets";

/**
 * The importer's door to the sealed secret pipeline (Coolify hub takeover): an agent-path import session reads Coolify's secret values
 * through `CoolifySecretsService.fetchEncrypted` under the consent that was given for THAT session (the session id is the run id), and ends
 * that consent with `finishRun` when the import is over. Everything it hands back is `tk1.` ciphertext; the plaintext exists only inside
 * `AgentSecretStore.get`, for the one setter that needs it.
 */
@Injectable()
export class AgentSecretsAdapter implements AgentSecretsPort {
  /** One store per import session in use; shared by the plan, the previews and the apply of that session. */
  readonly stores = new AgentSecretStores(this);

  constructor(
    private readonly secrets: CoolifySecretsService,
    private readonly grants: CoolifyHostGrantService,
    private readonly crypto: CryptoService,
  ) {}

  async grantedClasses(serverId: string, runId: string): Promise<CoolifySecretClass[] | null> {
    const g = await this.grants.activeSecretsGrant(serverId);
    return g && g.runId === runId ? g.classes : null;
  }

  async fetchEncrypted(input: { serverId: string; runId: string; refs: string[]; classes: CoolifySecretClass[]; userId: string }) {
    const r = await this.secrets.fetchEncrypted({ serverId: input.serverId, refs: input.refs, classes: input.classes, userId: input.userId, runId: input.runId });
    return { values: r.values, unreadable: r.unreadable, ...(r.incomplete ? { incomplete: r.incomplete } : {}) };
  }

  finishRun(serverId: string, runId: string): Promise<void> {
    return this.grants.finishRunByRunId(serverId, runId);
  }

  decrypt(enc: string): string {
    return this.crypto.decrypt(enc);
  }
}
