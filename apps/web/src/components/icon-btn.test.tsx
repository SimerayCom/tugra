import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IconBtn } from "./icon-btn";

afterEach(cleanup);

describe("IconBtn", () => {
  it("exposes an accessible label and fires onClick", () => {
    const onClick = vi.fn();
    render(<IconBtn label="Remove member" onClick={onClick}>×</IconBtn>);
    const btn = screen.getByRole("button", { name: "Remove member" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    render(<IconBtn label="Delete" onClick={onClick} disabled>×</IconBtn>);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
