import type { GitSourceKind } from "./types";

/** Human label for a git provider kind ("github" → "GitHub App", "gitea" → "Gitea"). Never the raw slug. */
export function sourceKindLabel(kind: GitSourceKind, t: (key: string) => string): string {
  return kind === "github" ? t("sources.githubApp") : kind === "gitea" ? "Gitea" : kind === "forgejo" ? "Forgejo" : "Codeberg";
}
