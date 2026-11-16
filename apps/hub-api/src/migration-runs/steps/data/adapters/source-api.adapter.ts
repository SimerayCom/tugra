import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";
import { CryptoService } from "../../../../crypto/crypto.service";
import { ControlError, CoolifyControl } from "../../../../importer/sources/coolify-control";
import type { RunSnapshot } from "../../../core/run-contract";
import type { ApiFailure, ApiResourceKind, ApiState, SourceApiPort } from "../data-contract";

/** Builds the write client for one instance (a seam so specs never open a socket). */
export type ControlFactory = (baseUrl: string, token: string) => CoolifyControl;
export const CONTROL_FACTORY = Symbol("MIGRATION_RUN_COOLIFY_CONTROL_FACTORY");

/**
 * The Coolify write API bound to the run's import session. The session's token is decrypted in memory for the duration of
 * one call and never stored, logged or returned. Only Coolify has a control client: a Dokploy run answers `unsupported`, and
 * the freeze falls back to the `manual` controller. A session that expired answers `session-expired` (the operator re-enters
 * the token through `POST /:id/source-session`).
 */
@Injectable()
export class CoolifySourceApi implements SourceApiPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @Optional() @Inject(CONTROL_FACTORY) private readonly factory: ControlFactory = (b, t) => CoolifyControl.http(b, t),
  ) {}

  private async client(run: RunSnapshot): Promise<{ ok: true; control: CoolifyControl } | { ok: false; reason: ApiFailure }> {
    if (run.sourceKind !== "coolify") return { ok: false, reason: "unsupported" };
    if (!run.sessionId) return { ok: false, reason: "session-expired" };
    const s = await this.prisma.importSession.findUnique({ where: { id: run.sessionId } });
    if (!s || s.actorId !== run.actorId || s.sourceKind !== "coolify" || s.status !== "active" || s.expiresAt.getTime() < Date.now()) return { ok: false, reason: "session-expired" };
    try {
      return { ok: true, control: this.factory(s.baseUrl, this.crypto.decrypt(s.tokenEnc)) };
    } catch {
      return { ok: false, reason: "unreachable" }; // an SSRF-refused base URL or an undecryptable token: fixed code, nothing echoed
    }
  }

  private async call<T>(run: RunSnapshot, fn: (c: CoolifyControl) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: ApiFailure }> {
    const c = await this.client(run);
    if (!c.ok) return c;
    try {
      return { ok: true, value: await fn(c.control) };
    } catch (e) {
      return { ok: false, reason: e instanceof ControlError ? e.code : "unreachable" };
    }
  }

  async available(run: RunSnapshot): Promise<{ ok: true } | { ok: false; reason: ApiFailure }> {
    const c = await this.client(run);
    return c.ok ? { ok: true } : c;
  }

  async state(run: RunSnapshot, kind: ApiResourceKind, uuid: string): Promise<{ ok: true; state: ApiState } | { ok: false; reason: ApiFailure }> {
    const r = await this.call(run, (c) => c.state(kind, uuid));
    return r.ok ? { ok: true, state: r.value } : r;
  }

  async stop(run: RunSnapshot, kind: ApiResourceKind, uuid: string): Promise<{ ok: true } | { ok: false; reason: ApiFailure }> {
    const r = await this.call(run, (c) => c.stop(kind, uuid));
    return r.ok ? { ok: true } : r;
  }

  async start(run: RunSnapshot, kind: ApiResourceKind, uuid: string): Promise<{ ok: true } | { ok: false; reason: ApiFailure }> {
    const r = await this.call(run, (c) => c.start(kind, uuid));
    return r.ok ? { ok: true } : r;
  }
}
