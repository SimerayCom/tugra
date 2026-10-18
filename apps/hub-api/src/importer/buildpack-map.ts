import type { ForeignApp, ForeignBuildPack, TugraAppSource, TugraBuildType } from "./foreign-fleet";

/** How a foreign app's build pack maps onto a Tugra app source + build type. */
export interface MappedBuild {
  source: TugraAppSource;
  buildType?: TugraBuildType; // only for GIT builds
  note?: string; // a warning to surface when the mapping is lossy or approximate
}

/**
 * Map a competitor build pack to Tugra's source + build type. Pure and total: an unknown pack falls back to
 * a GIT/NIXPACKS build with a note so the planner can warn rather than silently guess.
 */
export function mapBuildPack(app: Pick<ForeignApp, "buildPack" | "git" | "image">): MappedBuild {
  switch (app.buildPack) {
    case "nixpacks":
      return { source: "GIT", buildType: "NIXPACKS" };
    case "railpack":
      return { source: "GIT", buildType: "RAILPACK" };
    case "static":
      return { source: "GIT", buildType: "STATIC" };
    case "dockerfile":
      return { source: "GIT", buildType: "DOCKERFILE" };
    case "herokuish":
    case "paketo":
      return { source: "GIT", buildType: "HEROKU" };
    case "dockercompose":
      return { source: "COMPOSE" };
    case "image":
      return { source: "IMAGE" };
    case "unknown":
    default:
      // No clean mapping — prefer a Git build if a repo exists, else an image, and always warn.
      return app.git
        ? { source: "GIT", buildType: "NIXPACKS", note: "unknown build pack — defaulted to a Nixpacks build; verify" }
        : { source: "IMAGE", note: "unknown build pack and no git repo — imported as an image; verify" };
  }
}
