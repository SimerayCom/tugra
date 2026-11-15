import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { LevelLog } from "./level-log";

afterEach(cleanup);

describe("LevelLog", () => {
  it("keeps the text byte-identical so copy/select yields the original log", () => {
    const text = "a\n\nERROR: x\nlast";
    const { container } = render(<pre><LevelLog text={text} /></pre>);
    expect(container.textContent).toBe(text);
  });
  it("tints error red and warn amber via the theme tokens", () => {
    const { container } = render(<pre><LevelLog text={"[ERROR] boom\n[WARN] hmm\nfine"} /></pre>);
    const spans = Array.from(container.querySelectorAll("span"));
    expect(spans[0].style.color).toBe("var(--c-r)");
    expect(spans[1].style.color).toBe("var(--c-am)");
    expect(spans[2].style.color).toBe("");
  });
});
