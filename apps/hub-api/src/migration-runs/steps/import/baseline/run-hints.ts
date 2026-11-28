/**
 * Run hints (grup-7 safety lane): the operator- or host-attested facts the import-side steps consult and the run's own columns
 * cannot hold. Six kinds, all secret-free:
 *  - `image-pin`: key = the image ref as the plan shows it, scope = the source server uuid ("" = every server), value = `sha256:<64 hex>`;
 *  - `worker-mark`: key = the plan itemRef, scope = "", value = `job-runner` | `web`;
 *  - `service-pin`: key = `<service itemRef>#<member>`, scope = "", value = the image ref (a version tag or `repo@sha256:...` of the member's own
 *    repository) a compose stack's floating member is pinned to; a promoted run writes it into the stack's `serviceChoices.pins`;
 *  - `exact-image`: key = the plan itemRef of an app or database, or `<service itemRef>#<member>` for a stack member, scope = "", value = the
 *    exact image the source runs (`repo:tag@sha256:...`, or `repo:<version>`; then a space and the image's version label when it has one),
 *    read from the source host's running containers; the apply input carries it (see `exact-images.ts`);
 *  - `exact-off`: key = the plan itemRef, value = `off` (the owner unticked "keep the exact image" for the item) or `on` (ticked it again, which also
 *    overrides an `off` of the dry run this run was promoted from);
 *  - `warning-ack`: key = the dry-run warning key (see `WARNING_ACK_KEY`), scope = "", value = `accepted`: the operator read that
 *    warning on the dry-run result and accepts it. It changes no step: it is the record the result screen and the promoted run show.
 * They are keyed by run; a run promoted from a dry-run also reads its parent's (see {@link RunHintStore.list}).
 */
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";

/** Nest token of the {@link RunHintStore}. */
export const RUN_HINTS = Symbol("MIGRATION_RUN_HINTS");

export const HINT_KINDS = ["image-pin", "worker-mark", "warning-ack", "service-pin", "exact-image", "exact-off"] as const;
export type HintKind = (typeof HINT_KINDS)[number];
/** Who vouches for a hint. The hub verifies none of them: it cannot see the source host. */
export const HINT_EVIDENCE = ["operator-attested", "host-loop-reported", "source-api-reported"] as const;
export type HintEvidence = (typeof HINT_EVIDENCE)[number];

export interface RunHint {
  kind: HintKind;
  key: string;
  scope: string;
  value: string;
  evidence: HintEvidence;
}

export interface RunHintStore {
  /** The run's hints; with `parentRunId` (the dry-run it was promoted from) the parent's too, the run's own winning. */
  list(runId: string, parentRunId?: string | null): Promise<RunHint[]>;
  /** Insert or replace by (kind, key, scope). */
  upsert(runId: string, hints: readonly RunHint[]): Promise<void>;
  remove(runId: string, hints: ReadonlyArray<Pick<RunHint, "kind" | "key" | "scope">>): Promise<void>;
}

/** Merge a parent's hints under the run's own (same kind+key+scope: the run wins). */
export function mergeHints(own: readonly RunHint[], parent: readonly RunHint[]): RunHint[] {
  const id = (h: RunHint): string => `${h.kind}\u0000${h.key}\u0000${h.scope}`;
  const seen = new Set(own.map(id));
  return [...own, ...parent.filter((h) => !seen.has(id(h)))];
}

@Injectable()
export class PrismaRunHints implements RunHintStore {
  constructor(private readonly prisma: PrismaService) {}

  private async rows(runId: string): Promise<RunHint[]> {
    const rows = await this.prisma.migrationRunHint.findMany({ where: { runId }, orderBy: [{ kind: "asc" }, { key: "asc" }, { scope: "asc" }], take: 5000 });
    return rows.map((r) => ({ kind: r.kind as HintKind, key: r.key, scope: r.scope, value: r.value, evidence: r.evidence as HintEvidence }));
  }

  async list(runId: string, parentRunId?: string | null): Promise<RunHint[]> {
    const own = await this.rows(runId);
    return parentRunId ? mergeHints(own, await this.rows(parentRunId)) : own;
  }

  async upsert(runId: string, hints: readonly RunHint[]): Promise<void> {
    if (!hints.length) return;
    await this.prisma.$transaction(
      hints.map((h) =>
        this.prisma.migrationRunHint.upsert({
          where: { runId_kind_key_scope: { runId, kind: h.kind, key: h.key, scope: h.scope } },
          create: { runId, kind: h.kind, key: h.key, scope: h.scope, value: h.value, evidence: h.evidence },
          update: { value: h.value, evidence: h.evidence },
        }),
      ),
    );
  }

  async remove(runId: string, hints: ReadonlyArray<Pick<RunHint, "kind" | "key" | "scope">>): Promise<void> {
    if (!hints.length) return;
    await this.prisma.migrationRunHint.deleteMany({ where: { runId, OR: hints.map((h) => ({ kind: h.kind, key: h.key, scope: h.scope })) } });
  }
}

/** An in-memory store (the specs' world; also what a step uses when none is wired). */
export class InMemoryRunHints implements RunHintStore {
  readonly byRun = new Map<string, RunHint[]>();
  private id = (h: Pick<RunHint, "kind" | "key" | "scope">): string => `${h.kind}\u0000${h.key}\u0000${h.scope}`;

  async list(runId: string, parentRunId?: string | null): Promise<RunHint[]> {
    const own = this.byRun.get(runId) ?? [];
    return parentRunId ? mergeHints(own, this.byRun.get(parentRunId) ?? []) : [...own];
  }
  async upsert(runId: string, hints: readonly RunHint[]): Promise<void> {
    const cur = new Map((this.byRun.get(runId) ?? []).map((h) => [this.id(h), h]));
    for (const h of hints) cur.set(this.id(h), { ...h });
    this.byRun.set(runId, [...cur.values()]);
  }
  async remove(runId: string, hints: ReadonlyArray<Pick<RunHint, "kind" | "key" | "scope">>): Promise<void> {
    const drop = new Set(hints.map(this.id));
    this.byRun.set(runId, (this.byRun.get(runId) ?? []).filter((h) => !drop.has(this.id(h))));
  }
}
