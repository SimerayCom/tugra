import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Btn } from "./ui";

afterEach(cleanup);

describe("Btn", () => {
  it("defaults to type=button so it does not submit a surrounding form", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Btn onClick={onClick}>Go</Btn>
      </form>,
    );
    fireEvent.click(screen.getByText("Go"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled(); // no double-fire
  });

  it("submits the form when type=submit is set explicitly", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Btn type="submit">Save</Btn>
      </form>,
    );
    fireEvent.click(screen.getByText("Save"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
