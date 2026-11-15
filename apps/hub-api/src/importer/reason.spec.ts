import { IMPORT_REASON_CODES } from "@tugra/shared";
import { LABEL_NAMESPACE_WHY } from "../deploy/label-namespaces";
import { mapCustomLabels } from "./apply-map";
import { REASON_EN, why } from "./reason";

describe("importer reasons", () => {
  it("every shared code has an English fallback text and nothing else is defined (hub table == shared list)", () => {
    expect(Object.keys(REASON_EN).sort()).toEqual([...IMPORT_REASON_CODES].sort());
  });

  it("why() carries the code and its params, and renders the English fallback from them", () => {
    expect(why("label_duplicate")).toEqual({ reason: "duplicate (label keys are case-insensitive)", reasonCode: "label_duplicate" });
    expect(why("ports_limit", { max: 20 })).toEqual({ reason: "Tugra allows at most 20 extra published ports", reasonCode: "ports_limit", reasonParams: { max: 20 } });
    expect(why("domain_port_differs", { port: 81, primaryPort: 80 }).reason).toBe("routes to container port 81, but Tugra serves one container port per app (80)");
  });

  it("a template's placeholders are exactly the params the emitters pass (no code renders a literal {x})", () => {
    for (const [code, text] of Object.entries(REASON_EN)) {
      const names = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const params = Object.fromEntries(names.map((n) => [n, "x"]));
      expect(why(code as never, params).reason).not.toMatch(/\{\w+\}/);
    }
  });

  it("the per-namespace label reasons say what the old composed text said (the namespace guard cannot drift from the table)", () => {
    const code: Record<string, keyof typeof REASON_EN> = { "traefik.": "label_reserved_traefik", "tugra.": "label_reserved_tugra", "com.docker.compose.": "label_reserved_compose", "com.docker.swarm.": "label_reserved_swarm", "com.docker.stack.": "label_reserved_stack" };
    for (const [ns, why_] of Object.entries(LABEL_NAMESPACE_WHY)) expect(REASON_EN[code[ns]]).toBe(`in the reserved ${ns}* namespace (${why_})`);
    expect(mapCustomLabels([{ key: "traefik.http.routers.x.rule", value: "v" }]).dropped[0]).toMatchObject({ reasonCode: "label_reserved_traefik" });
  });
});
