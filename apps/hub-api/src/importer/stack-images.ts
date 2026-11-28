import type { ForeignFleet } from "./foreign-fleet";
import { analyzeService, ns } from "./import-planner";

/** Per compose stack of the plan, the image each kept member is written with (not on a digest). Names and image refs only; kept on the op so the host report can match them to the source's running containers. */
export interface StackImages {
  itemRef: string;
  images: Array<{ member: string; image: string }>;
}

/**
 * No count cap on purpose: a stack or a member past any limit would silently keep a moving tag. The compose of a stack is at most 256 KiB
 * (`MAX_SERVICE_COMPOSE_BYTES`), which bounds every list here.
 */
export function stackImagesOf(fleet: Pick<ForeignFleet, "services">): StackImages[] {
  const out: StackImages[] = [];
  for (const svc of fleet.services) {
    const images = Object.entries(analyzeService(svc).result?.images ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([member, image]) => ({ member, image }));
    if (images.length) out.push({ itemRef: ns("service", svc.serverRef, svc.sourceRef), images });
  }
  return out;
}
