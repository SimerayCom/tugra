import type { ForeignFleet } from "./foreign-fleet";
import { analyzeService, ns } from "./import-planner";

/** Per compose stack of the plan, the image each kept member is written with (not on a digest). Names and image refs only; kept on the op so the host report can match them to the source's running containers. */
export interface StackImages {
  itemRef: string;
  images: Array<{ member: string; image: string }>;
}

const MAX_STACKS = 200;
const MAX_MEMBERS = 64;

export function stackImagesOf(fleet: Pick<ForeignFleet, "services">): StackImages[] {
  const out: StackImages[] = [];
  for (const svc of fleet.services) {
    if (out.length >= MAX_STACKS) break;
    const images = Object.entries(analyzeService(svc).result?.images ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, MAX_MEMBERS)
      .map(([member, image]) => ({ member, image }));
    if (images.length) out.push({ itemRef: ns("service", svc.serverRef, svc.sourceRef), images });
  }
  return out;
}
