import { pinComposeMembers, pinComposeMembersDetailed } from "./exact-record";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("pinComposeMembers: every member of a stack, however many, and several members on one image", () => {
  it("pins 90 members of one stack (nothing past 64 is skipped)", () => {
    const compose = "services:\n" + Array.from({ length: 90 }, (_, i) => `  m${i}:\n    image: x/img:latest\n`).join("");
    const members = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`m${i}`, `x/img:latest@${D("a")}`]));
    const out = pinComposeMembers(compose, members)!;
    expect(out.match(/@sha256:a{64}/g)).toHaveLength(90);
  });
  it("members that share one image each get the digest their own container runs, even when the two differ", () => {
    const compose = "services:\n  web:\n    image: ghost:5\n  worker:\n    image: ghost:5\n";
    const out = pinComposeMembers(compose, { web: `ghost:5@${D("1")}`, worker: `ghost:5@${D("2")}` })!;
    expect(out).toContain(`image: ghost:5@${D("1")}`);
    expect(out).toContain(`image: ghost:5@${D("2")}`);
  });
  it("names the members the pin cannot replace (another repository) and leaves them as they are", () => {
    const r = pinComposeMembersDetailed("services:\n  db:\n    image: mariadb:11\n  web:\n    image: nginx:1\n", { db: `postgres:16@${D("1")}`, web: `nginx:1@${D("2")}` });
    expect(r.refused).toEqual(["db"]);
    expect(r.compose).toContain("image: mariadb:11");
    expect(r.compose).toContain(`image: nginx:1@${D("2")}`);
  });
});
