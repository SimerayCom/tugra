import { RunWorld, defaultPlan } from "../../../core/testing/run-world";
import { STEP_KEYS, STEP_MANIFEST } from "../../../core/run-contract";
import { DeployDarkStep } from "../deploy-dark.step";
import { ImportStep } from "../import.step";
import { PreflightStep } from "../preflight.step";
import { RemapEnvStep } from "../remap-env.step";
import { InMemoryRunHints } from "../baseline/run-hints";

/** A plan item for the safety specs (neutral invented names only). */
export const item = (ref: string, name: string, proposed: Record<string, unknown>, dependsOn: string[] = []) => ({ itemRef: ref, kind: "app", name, proposed, risks: [], dependsOn });

/**
 * A world whose lane-A handlers share one in-memory hint store, and whose op snapshot carries the plan's domain and image (as
 * the real port does). Handlers the world does not own stay stand-ins.
 */
export function safetyWorld(items: ReturnType<typeof item>[], hints = new InMemoryRunHints(), stubs?: NonNullable<ConstructorParameters<typeof RunWorld>[0]>["stubs"]) {
  const w = new RunWorld({ laneA: false, stubKeys: STEP_KEYS.filter((k) => STEP_MANIFEST[k].lane !== "A"), ...(stubs ? { stubs } : {}) });
  w.port.plan_ = defaultPlan({ items: items as never });
  for (const h of [new PreflightStep(w.registry, w.port, hints), new ImportStep(w.registry, w.port, hints), new RemapEnvStep(w.registry, w.port), new DeployDarkStep(w.registry, w.port, hints)]) (h as unknown as { onModuleInit(): void }).onModuleInit();
  const orig = w.port.opSnapshot.bind(w.port);
  w.port.opSnapshot = async (u, op) => {
    const snap = await orig(u, op);
    return {
      ...snap,
      planItems: snap.planItems.map((p) => {
        const pr = (items.find((i) => i.itemRef === p.itemRef)?.proposed ?? {}) as { domain?: string | null; image?: string | null };
        return { ...p, ...("domain" in pr ? { domain: pr.domain ?? null } : {}), ...("image" in pr ? { image: pr.image ?? null } : {}) };
      }),
    };
  };
  return { w, hints };
}
