import { describe, it, expect } from "vitest";
import { draftFromChannel, parseTopics, toggleIn } from "./notification-routing";

describe("notification routing helpers", () => {
  it("toggleIn adds and removes", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
  });

  it("draftFromChannel reads a legacy channel (no routing fields) as an empty rule", () => {
    expect(draftFromChannel({})).toEqual({ categories: [], minSeverity: "info", topics: {} });
    expect(draftFromChannel({ categories: ["deploy"], minSeverity: "warning", topics: { deploy: 7 } })).toEqual({
      categories: ["deploy"],
      minSeverity: "warning",
      topics: { deploy: "7" },
    });
  });

  it("parseTopics keeps valid ids, drops blanks and unselected categories, reports invalid ones", () => {
    const r = parseTopics({ deploy: " 12 ", backup: "", uptime: "5", server: "abc", security: "0", updates: "1.5" }, ["deploy", "backup", "server", "security", "updates"]);
    expect(r.topics).toEqual({ deploy: 12 }); // uptime not selected → ignored
    expect(r.invalid.sort()).toEqual(["security", "server", "updates"]);
  });
});
