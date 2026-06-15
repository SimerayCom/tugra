import { describe, it, expect } from "vitest";
import en from "./locales/en";
import { translate } from "./translate";

describe("i18n translate", () => {
  it("resolves a nested namespaced key", () => {
    expect(translate(en, "nav.dashboard")).toBe("Dashboard");
    expect(translate(en, "servers.title")).toBe("Servers");
  });

  it("interpolates variables", () => {
    expect(translate(en, "servers.selected", { n: 3 })).toBe("3 selected");
  });

  it("returns the key itself when missing (gaps stay visible)", () => {
    expect(translate(en, "nope.nope")).toBe("nope.nope");
  });
});
