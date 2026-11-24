import { describe, it, expect } from "vitest";
import { serverDisplayName } from "./server-name";

const t = (k: string) => (k === "servers.unnamed" ? "Unnamed server" : k);

describe("serverDisplayName", () => {
  it("localizes the placeholder of an auto-named server that has not connected yet", () => {
    expect(serverDisplayName({ name: "New server", nameAuto: true }, t)).toBe("Unnamed server");
  });
  it("keeps a real name, including one a person typed that equals the placeholder", () => {
    expect(serverDisplayName({ name: "web-1", nameAuto: false }, t)).toBe("web-1");
    expect(serverDisplayName({ name: "New server", nameAuto: false }, t)).toBe("New server");
    expect(serverDisplayName({ name: "web-1" }, t)).toBe("web-1");
  });
});
