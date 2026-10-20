/**
 * MCP prompt templates (prompts/list + prompts/get). A prompt is an inert, read-only recipe an MCP client
 * can surface to its user (often as a slash-command) that guides the agent through the existing Tugra
 * tools — it performs NO action and reads NO data itself; the agent still calls the scoped tools, so a
 * prompt can never bypass a scope or mutate anything. They just make common fleet/ops workflows one click.
 */
export interface McpPromptArg {
  name: string;
  description: string;
  required: boolean;
}
export interface McpPrompt {
  name: string;
  description: string;
  arguments: McpPromptArg[];
  /** Build the user-message text from the (already required-checked) args. Pure, no side effects. */
  build: (args: Record<string, unknown>) => string;
}

/** A safe string accessor — the service re-checks required args, so missing optionals collapse to "". */
function s(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

export const MCP_PROMPTS: McpPrompt[] = [
  {
    name: "diagnose_deploy",
    description: "Diagnose why an application is failing or unhealthy and propose a fix (read-only).",
    arguments: [{ name: "appId", description: "The application id to diagnose.", required: true }],
    build: (a) =>
      `Diagnose application "${s(a, "appId")}" and propose a fix. Work read-only, step by step: ` +
      `(1) get_application to see its status; (2) list its recent deployments and note the latest outcome; ` +
      `(3) get_app_logs to read the build/run output; (4) list_servers to confirm the owning server is ONLINE. ` +
      `Then summarize the most likely root cause and a concrete fix. Do NOT change anything — only report.`,
  },
  {
    name: "fleet_rollout",
    description: "Plan and, only after explicit confirmation, run one lifecycle action across every app in a cluster.",
    arguments: [
      { name: "clusterId", description: "The cluster to act across.", required: true },
      { name: "action", description: "restart | stop | start (default: restart).", required: false },
    ],
    build: (a) => {
      // Clamp to the allowlist so arbitrary client text is never echoed into the guidance as an "action".
      const raw = s(a, "action");
      const action = ["restart", "stop", "start"].includes(raw) ? raw : "restart";
      return (
        `Safely apply "${action}" to every application in cluster "${s(a, "clusterId")}". ` +
        `First call fleet_list_apps({clusterId}) to see the targets and fleet_health_rollup to note current health. ` +
        `Then PREVIEW: call fleet_app_action WITHOUT a confirmToken and show me the affected apps and the returned confirmToken. ` +
        `Only proceed by re-calling fleet_app_action with that exact confirmToken AFTER I approve. Report health before and after.`
      );
    },
  },
  {
    name: "fleet_review",
    description: "Review the health of the whole fleet (or one team) and flag anything unhealthy (read-only).",
    arguments: [{ name: "teamId", description: "Optional team id to scope the review to.", required: false }],
    build: (a) => {
      const team = s(a, "teamId");
      const call = team ? `fleet_status({teamId:"${team}"})` : "fleet_status()";
      return (
        `Review fleet health${team ? ` for team "${team}"` : ""}. Call ${call} and fleet_health_rollup, ` +
        `then list every application that is FAILED or STOPPED and every cluster with offline nodes, ` +
        `and summarize what needs attention and why. Read-only — do not change anything.`
      );
    },
  },
];
