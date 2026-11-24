import { NotificationsController } from "./notifications.controller";
import { EVENT_TYPES } from "./dto";
import type { NotificationsService } from "./notifications.service";

describe("NotificationsController.events", () => {
  const ctrl = new NotificationsController({} as NotificationsService);

  it("serves the canonical event list (single source for the web UI)", () => {
    expect(ctrl.events().events).toEqual(EVENT_TYPES);
  });

  it("serves the routing vocabulary: categories, each event's category, severities", () => {
    const r = ctrl.events();
    expect(r.categories).toEqual(["uptime", "deploy", "backup", "server", "security", "updates"]);
    expect(r.severities).toEqual(["info", "warning", "critical"]);
    expect(r.eventCategories.deploy_failed).toBe("deploy");
    expect(Object.keys(r.eventCategories).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("includes backup_failed and excludes the orphan monitor events", () => {
    const { events } = ctrl.events();
    expect(events).toContain("backup_failed");
    expect(events).not.toContain("monitor_down");
    expect(events).not.toContain("monitor_up");
  });
});
