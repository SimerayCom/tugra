import type { CoolifySecretClass } from "@tugra/shared";
import type { AgentSecretsPort } from "../sources/agent-secrets";

const kindClass: Record<string, CoolifySecretClass> = { env: "env", shared_env: "shared_env", database: "db_credentials", service: "service_compose", application: "service_compose", scheduled_task: "task_command", notification: "notification", file_volume: "service_compose" };

/** A fake sealed pipeline: "opens" the values it is given, in `tk1.fake:` form, and records every call. */
export function fakePort(o: { granted?: CoolifySecretClass[] | null; opened?: Record<string, string>; codes?: Record<string, string>; throwOn?: CoolifySecretClass; incompleteOn?: CoolifySecretClass; delayMs?: number } = {}) {
  const calls: Array<{ classes: CoolifySecretClass[]; refs: string[]; runId: string; userId: string }> = [];
  const finished: Array<[string, string]> = [];
  const port: AgentSecretsPort & { calls: typeof calls; finished: typeof finished; granted: CoolifySecretClass[] | null } = {
    calls,
    finished,
    granted: o.granted === undefined ? ["env", "shared_env", "db_credentials", "service_compose", "task_command"] : o.granted,
    async grantedClasses() {
      return port.granted;
    },
    async fetchEncrypted(input) {
      calls.push({ classes: input.classes, refs: input.refs, runId: input.runId, userId: input.userId });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.throwOn && input.classes.includes(o.throwOn)) throw new Error("consent ended");
      const values: Array<{ ref: string; field: string; cls: CoolifySecretClass; enc: string }> = [];
      const unreadable: Array<{ itemRef: string; field: string; code: any }> = [];
      for (const ref of input.refs) {
        for (const [k, v] of Object.entries(o.opened ?? {})) {
          const [r, field] = k.split("|");
          if (r === ref) values.push({ ref, field, cls: kindClass[ref.split(":")[0]], enc: `tk1.fake:${v}` });
        }
        for (const [k, code] of Object.entries(o.codes ?? {})) {
          const [r, field] = k.split("|");
          if (r === ref) unreadable.push({ itemRef: ref, field, code });
        }
      }
      const incomplete = o.incompleteOn && input.classes.includes(o.incompleteOn) ? { code: "rate_limited", remainingRefs: input.refs.slice(1) } : undefined;
      return { values, unreadable, ...(incomplete ? { incomplete } : {}) };
    },
    async finishRun(serverId, runId) {
      finished.push([serverId, runId]);
    },
    decrypt: (enc) => enc.replace(/^tk1\.fake:/, ""),
  };
  return port;
}

