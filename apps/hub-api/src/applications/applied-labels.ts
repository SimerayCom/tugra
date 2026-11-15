import { dockerOptionLabels } from "../deploy/docker-options-safety";
import { CUSTOM_LABEL_KEY_RE, CUSTOM_LABEL_LIMITS, RESERVED_LABEL_PREFIXES } from "../deploy/label-namespaces";
import { composeTugraLabels } from "../deploy/compose-script";
import {
  classicAliasLabelLine,
  classicTugraLabelLines,
  hasNetworkOpt,
  PROXY_NETWORK,
  traefikLabels,
  type AppConfigMount,
  type TraefikLabelInput,
} from "../deploy/deploy-script";
import type { AppLabelsView } from "./dto";

/** Everything buildAppliedLabels needs. `label` is the NARROW TraefikLabelInput, so the compiler guarantees the
 *  view can never read env, git/registry credentials or build secrets: the only secret-bearing members are the
 *  basic-auth hashes and forward-auth address (masked in the output) and the cert PEM/key (presence only, the
 *  caller passes a placeholder). */
export interface AppliedLabelsInput {
  source: string;
  clusterId: string | null;
  isPreview: boolean;
  label: TraefikLabelInput;
  composeWebService: string | null;
  serviceDomains: { service: string; hostname: string; port: number }[];
  configMounts: Pick<AppConfigMount, "serviceName" | "target" | "content">[];
  customLabels: Record<string, string> | null;
  /** The app is eligible for a rolling (zero-downtime) deploy: the rollout container then also carries Traefik
   *  health-check labels while it overlaps the old one. */
  rollingEligible: boolean;
}

type TugraRow = AppLabelsView["tugra"][number];

const MASKED = /\.(basicauth\.users|forwardauth\.address)$/i;

function row(scope: string, line: string, purpose: TugraRow["purpose"]): TugraRow {
  const eq = line.indexOf("=");
  const key = line.slice(0, eq);
  const masked = MASKED.test(key);
  return { scope, key, value: masked ? null : line.slice(eq + 1), masked, purpose };
}

/**
 * The read-only "applied labels" view. Built from the SAME builders the deploy scripts use (classicTugraLabelLines,
 * classicAliasLabelLine, composeTugraLabels, traefikLabels), so it cannot drift from what actually gets applied.
 * Pure: no I/O, no secrets. Basic-auth hashes and the forward-auth address are masked (value null); redirect
 * regexes and everything else are shown.
 */
export function buildAppliedLabels(input: AppliedLabelsInput): AppLabelsView {
  // A stored dockerOptions that no longer tokenizes (an unterminated quote) would throw inside the network plan.
  // The deploy fails closed on it; the read-only view must still render, so treat it as "no raw --network".
  const i: AppliedLabelsInput = { ...input, label: { ...input.label, dockerOptions: usableDockerOptions(input.label.dockerOptions) } };
  const compose = i.source === "COMPOSE";
  const swarm = !!i.clusterId && !compose;
  const engine: AppLabelsView["engine"] = compose ? "compose" : swarm ? "swarm" : "docker";
  const editableReason: AppLabelsView["editableReason"] = compose ? "compose" : i.isPreview ? "preview" : null;
  const tugra: TugraRow[] = [];
  const notes: AppLabelsView["notes"] = [];
  let fromDockerOptions: { key: string; value: string }[] = [];

  if (compose) {
    const spec = { ...i.label, composeWebService: i.composeWebService, serviceDomains: i.serviceDomains, configMounts: i.configMounts as AppConfigMount[] };
    // dollarEscape false: compose un-escapes `$$` at interpolation, so the container carries the single-`$` value.
    for (const [svc, entries] of composeTugraLabels(spec, { dollarEscape: false })) {
      for (const e of entries) tugra.push(row(`service:${svc}`, e.line, e.purpose));
    }
    notes.push("compose_user_labels", "image_labels_not_shown");
  } else if (swarm) {
    // Swarm service labels (read by the swarm-mode Traefik). Custom labels are CONTAINER labels, listed separately.
    for (const l of i.label.domain ? traefikLabels(i.label) : []) tugra.push(row("swarm-service", l, "traefik_routing"));
    if (!i.label.domain) notes.push("needs_domain");
    notes.push("swarm_container_labels", "swarm_runtime_labels");
  } else {
    for (const l of classicTugraLabelLines(i.label)) {
      tugra.push(row("container", l, l === `traefik.docker.network=${PROXY_NETWORK}` ? "proxy_network_pin" : "traefik_routing"));
    }
    const alias = classicAliasLabelLine(i.label);
    if (alias) tugra.push(row("container", alias, "alias"));
    if (!i.label.domain) notes.push("needs_domain");
    else if (i.rollingEligible) notes.push("rolling_health_labels");
    fromDockerOptions = safeDockerOptionLabels(i.label.dockerOptions);
  }

  const custom = Object.keys(i.customLabels ?? {})
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => ({ key, value: (i.customLabels as Record<string, string>)[key] }));

  return {
    engine,
    editable: editableReason === null,
    editableReason,
    applyMode: "next_deploy",
    tugra,
    custom,
    fromDockerOptions,
    reservedPrefixes: [...RESERVED_LABEL_PREFIXES],
    limits: { ...CUSTOM_LABEL_LIMITS, keyPattern: CUSTOM_LABEL_KEY_RE.source },
    notes,
  };
}

function usableDockerOptions(raw: string | null | undefined): string | null {
  try {
    hasNetworkOpt(raw);
    return raw ?? null;
  } catch {
    return null;
  }
}

/** A stored dockerOptions that no longer parses must not break the read-only view. */
function safeDockerOptionLabels(raw: string | null | undefined): { key: string; value: string }[] {
  try {
    return dockerOptionLabels(raw);
  } catch {
    return [];
  }
}

