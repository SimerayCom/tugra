import { BadRequestException } from "@nestjs/common";
import type { ForeignFleet } from "./foreign-fleet";
import type { ServiceChoice } from "./dto";
import { ns } from "./import-planner";
import { transformServiceCompose } from "./import-service-map";

/**
 * Validate the per-service choices against the freshly re-planned service items. Keys are plan itemRefs of KIND service;
 * a volume key must be a volume the transform produces; a member / domain service / pin must be a member of the stack.
 * Any violation is a 400 before a single op or task row exists. Returns a null-prototype copy (a key can be anything).
 * Shared by the apply executor and the preview endpoint so both judge a choice identically.
 */
export function validateServiceChoices(fleet: ForeignFleet, items: Array<{ itemRef: string; kind: string }>, raw: Record<string, ServiceChoice> | undefined): Record<string, ServiceChoice> {
  const out: Record<string, ServiceChoice> = Object.create(null);
  if (!raw) return out;
  const svcByRef = new Map(fleet.services.map((sv) => [ns("service", sv.serverRef, sv.sourceRef), sv]));
  const serviceItems = new Set(items.filter((i) => i.kind === "service").map((i) => i.itemRef));
  for (const [ref, choice] of Object.entries(raw)) {
    const svc = svcByRef.get(ref);
    if (!serviceItems.has(ref) || !svc) throw new BadRequestException("serviceChoices has a key that is not a service in this plan");
    const members = new Set((svc.members ?? []).map((m) => m.name));
    const res = svc.composeFile ? transformServiceCompose({ svc, raw: svc.composeFile }) : undefined;
    const volumeKeys = new Set((res?.volumes ?? []).map((v) => v.key));
    for (const k of Object.keys(choice.volumes ?? {})) if (!volumeKeys.has(k)) throw new BadRequestException("serviceChoices names a volume this service does not have");
    for (const m of choice.dropMembers ?? []) if (!members.has(m)) throw new BadRequestException("serviceChoices names a member this service does not have");
    for (const d of choice.serviceDomains ?? []) if (!members.has(d.service)) throw new BadRequestException("serviceChoices routes a domain to a member this service does not have");
    for (const k of Object.keys(choice.pins ?? {})) if (!members.has(k)) throw new BadRequestException("serviceChoices pins an image of a member this service does not have");
    out[ref] = choice;
  }
  return out;
}

/**
 * Validate the exact images of apps and databases (`imagePins`, plan itemRef to `repo:tag@sha256:...`) against the freshly re-planned
 * items: a key must be an app or a database of this plan. Any other key is a 400 before a single op or task row exists. A pin of another
 * repository than the item's own is not refused here (a database the source gives no image for has none to compare): the executor only
 * writes a pin that belongs to the item's own image. Returns a null-prototype copy.
 */
export function validateImagePins(items: Array<{ itemRef: string; kind: string }>, raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw) return out;
  const known = new Map(items.filter((i) => i.kind === "app" || i.kind === "database").map((i) => [i.itemRef, i.kind]));
  for (const [ref, pin] of Object.entries(raw)) {
    if (!known.has(ref)) throw new BadRequestException("imagePins has a key that is not an app or a database in this plan");
    out[ref] = pin;
  }
  return out;
}
