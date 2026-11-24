import type { ContainerMeta } from "@tugra/shared";

/** The sanitized label row persisted per (server, container). Empty string = label absent. */
export interface ContainerLabelRow {
  name: string; // coolify.name
  resource: string; // coolify.resourceName
  project: string; // coolify.projectName
  environment: string; // coolify.environmentName
  service: string; // com.docker.compose.service
}

const MAX_LEN = 120;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(CONTROL, " ").trim().slice(0, MAX_LEN);
}

/** Validate what an (untrusted) agent sent as `meta`: only the five known string fields survive, capped and
 *  stripped of control characters. Returns null when nothing usable remains. */
export function sanitizeContainerMeta(raw: ContainerMeta | undefined | null): ContainerLabelRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row: ContainerLabelRow = {
    name: clean(raw.name),
    resource: clean(raw.resource),
    project: clean(raw.project),
    environment: clean(raw.env),
    service: clean(raw.service),
  };
  return row.name || row.resource || row.project || row.environment || row.service ? row : null;
}

export function sameLabels(a: ContainerLabelRow, b: ContainerLabelRow): boolean {
  return a.name === b.name && a.resource === b.resource && a.project === b.project && a.environment === b.environment && a.service === b.service;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the machine-generated names Coolify gives containers (a uuid, or a long id such as
 *  `kgr3jx23x9ck…`, optionally followed by a `-<timestamp>` suffix): a person can't read them, so they are
 *  never used as a display name. */
export function looksOpaque(s: string): boolean {
  if (!s) return true;
  if (UUID.test(s)) return true;
  return /^[a-z0-9]{16,}(?:-\d+)?$/i.test(s) && /\d/.test(s) && /[a-z]/i.test(s);
}

export interface LabelNaming {
  label: string;
  project?: string;
  environment?: string;
  service?: string;
}

/** Readable name for a container from its labels, or null when none of them is readable (then the caller keeps
 *  the raw container name). `Resource · service` for a multi-container resource, the bare name otherwise. */
export function nameFromLabels(l: ContainerLabelRow): LabelNaming | null {
  const app = [l.resource, l.name].find((c) => c && !looksOpaque(c)) ?? "";
  const service = l.service && !looksOpaque(l.service) ? l.service : "";
  let label = "";
  if (app && service && service.toLowerCase() !== app.toLowerCase()) label = `${app} · ${service}`;
  else label = app || service;
  if (!label) return null;
  return {
    label,
    ...(l.project && { project: l.project }),
    ...(l.environment && { environment: l.environment }),
    ...(service && { service }),
  };
}
