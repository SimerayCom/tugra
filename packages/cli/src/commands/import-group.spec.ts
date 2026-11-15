import { Command } from "commander";
import * as resources from "./resources";
import * as objects from "./objects";
import * as cutover from "./cutover";

describe("the `import` command group", () => {
  it("is registered once no matter which module registers first (commander would otherwise expose two `import` commands)", () => {
    for (const order of [[resources, objects, cutover], [objects, cutover, resources], [cutover, resources, objects]]) {
      const program = new Command();
      for (const m of order) m.register(program);
      expect(program.commands.filter((c) => c.name() === "import")).toHaveLength(1);
      const imp = program.commands.find((c) => c.name() === "import")!;
      const subs = imp.commands.map((c) => c.name());
      expect(subs).toEqual(expect.arrayContaining(["cutover", "volumes", "git-links"]));
    }
  });
});
