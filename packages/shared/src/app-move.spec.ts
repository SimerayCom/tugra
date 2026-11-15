import {
  AGENT_FEATURE_HUB_ORIGIN_ENV,
  APP_MOVE_ACKS,
  APP_MOVE_ACK_BLOCKERS,
  APP_MOVE_ACTIVE_PHASES,
  APP_MOVE_BLOCKER_CODES,
  APP_MOVE_FAILURE_REASONS,
  APP_MOVE_PHASES,
  APP_MOVE_TERMINAL_PHASES,
  APP_MOVE_WARNING_CODES,
} from "./index";

describe("app move shared constants", () => {
  it("the agent feature flag matches the Go constant", () => {
    expect(AGENT_FEATURE_HUB_ORIGIN_ENV).toBe("hub_origin_env_v1");
  });

  it("active + terminal phases partition the phase list exactly", () => {
    expect([...APP_MOVE_ACTIVE_PHASES, ...APP_MOVE_TERMINAL_PHASES].sort()).toEqual([...APP_MOVE_PHASES].sort());
  });

  it("every ack blocker maps to a known ack and is a known blocker code", () => {
    for (const [code, ack] of Object.entries(APP_MOVE_ACK_BLOCKERS)) {
      expect(APP_MOVE_ACKS).toContain(ack);
      expect(APP_MOVE_BLOCKER_CODES).toContain(code);
    }
    expect(Object.keys(APP_MOVE_ACK_BLOCKERS)).toHaveLength(APP_MOVE_ACKS.length);
  });

  it("code lists carry no duplicates", () => {
    for (const list of [APP_MOVE_BLOCKER_CODES, APP_MOVE_WARNING_CODES, APP_MOVE_FAILURE_REASONS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
