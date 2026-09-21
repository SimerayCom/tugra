import { redirect } from "next/navigation";

// "/resources" has no list of its own — resources (apps + databases) live under a
// project's environment. Sending a bare "/resources" hit to Projects avoids a dead
// 404 and matches the sidebar's "Resources" group, which leads to Projects.
export default function ResourcesIndex() {
  redirect("/projects");
}
