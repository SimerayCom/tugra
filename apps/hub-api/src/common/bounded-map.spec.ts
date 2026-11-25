import { setBounded } from "./bounded-map";

describe("setBounded", () => {
  it("drops the oldest entries past max and refreshes a re-inserted key", () => {
    const m = new Map<string, number>();
    setBounded(m, "a", 1, 3);
    setBounded(m, "b", 2, 3);
    setBounded(m, "c", 3, 3);
    setBounded(m, "a", 10, 3); // a becomes the newest
    setBounded(m, "d", 4, 3); // evicts b (the oldest)
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
    expect(m.get("a")).toBe(10);
  });
  it("never grows past max however many keys pass through", () => {
    const m = new Map<number, number>();
    for (let i = 0; i < 10_000; i++) setBounded(m, i, i, 50);
    expect(m.size).toBe(50);
  });
});
