import { Pm2MoveSchema, Pm2PlanSchema } from "./dto";

const H = "a".repeat(64);
describe("pm2-move dto", () => {
  it("plan: optional items with a node major and a clean probe path", () => {
    expect(Pm2PlanSchema.safeParse({}).success).toBe(true);
    expect(Pm2PlanSchema.safeParse({ items: [{ user: "acme", name: "app", nodeMajor: 20, probePath: "/health" }] }).success).toBe(true);
    expect(Pm2PlanSchema.safeParse({ items: [{ user: "acme", name: "app", nodeMajor: 9 }] }).success).toBe(false);
    // a bad probe path is dropped from a PREVIEW (never a 400 for every row), but a MOVE still refuses it
    const bad = Pm2PlanSchema.safeParse({ items: [{ user: "acme", name: "app", probePath: "health?x=1" }] });
    expect(bad.success && bad.data.items?.[0].probePath).toBeNull();
    expect(Pm2MoveSchema.safeParse({ items: [{ user: "acme", name: "app", probePath: "/a b", planHash: H }] }).success).toBe(false);
    expect(Pm2PlanSchema.safeParse({ items: [{ user: "../x", name: "app" }] }).success).toBe(false);
  });
  it("move: needs at least one item with the plan hash of the preview", () => {
    expect(Pm2MoveSchema.safeParse({ items: [] }).success).toBe(false);
    expect(Pm2MoveSchema.safeParse({ items: [{ user: "acme", name: "app" }] }).success).toBe(false);
    expect(Pm2MoveSchema.safeParse({ items: [{ user: "acme", name: "app", planHash: "xyz" }] }).success).toBe(false);
    expect(Pm2MoveSchema.safeParse({ items: [{ user: "acme", name: "app", planHash: H }], environmentId: "e1" }).success).toBe(true);
    expect(Pm2MoveSchema.safeParse({ items: Array.from({ length: 51 }, (_, i) => ({ user: "a", name: `n${i}`, planHash: H })) }).success).toBe(false);
  });
});
