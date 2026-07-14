import { NotificationsController } from "./notifications.controller";
import { EVENT_TYPES } from "./dto";
import type { NotificationsService } from "./notifications.service";

describe("NotificationsController.events", () => {
  const ctrl = new NotificationsController({} as NotificationsService);

  it("serves the canonical event list (single source for the web UI)", () => {
    expect(ctrl.events()).toEqual({ events: EVENT_TYPES });
  });

  it("includes backup_failed and excludes the orphan monitor events", () => {
    const { events } = ctrl.events();
    expect(events).toContain("backup_failed");
    expect(events).not.toContain("monitor_down");
    expect(events).not.toContain("monitor_up");
  });
});
