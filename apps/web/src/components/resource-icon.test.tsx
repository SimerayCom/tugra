import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ResourceIcon } from "./resource-icon";

afterEach(cleanup);
const FB = <span data-testid="fallback">fb</span>;
const srcs = (c: HTMLElement) => Array.from(c.querySelectorAll("img")).map((i) => i.getAttribute("src"));

describe("ResourceIcon", () => {
  it("shows the uploaded icon first, even over a picked icon", () => {
    const { container } = render(<ResourceIcon iconUrl="/api/v1/apps/a/icon?v=1" iconKey="redis" faviconUrl="/fav" image="postgres:16" fallback={FB} />);
    expect(srcs(container)).toEqual(["/api/v1/apps/a/icon?v=1"]);
  });

  it("shows the picked icon before the favicon and the image brand", () => {
    const { container } = render(<ResourceIcon iconKey="redis" faviconUrl="/fav" image="postgres:16" fallback={FB} />);
    expect(srcs(container)).toEqual(["/icons/redis.svg"]);
  });

  it("ignores a picked key that is not in the set", () => {
    const { container } = render(<ResourceIcon iconKey="../../x" image="postgres:16" fallback={FB} />);
    expect(srcs(container)).toEqual(["/icons/postgresql.svg"]);
  });

  it("uses the site favicon before the image brand and the catalog brand", () => {
    const { container } = render(<ResourceIcon faviconUrl="/api/v1/apps/a/favicon?v=x.com" image="postgres:16" brand={{ slug: "wordpress" }} fallback={FB} />);
    expect(srcs(container)).toEqual(["/api/v1/apps/a/favicon?v=x.com"]);
  });

  it("falls through to the image brand when the favicon fails to load", () => {
    const { container } = render(<ResourceIcon faviconUrl="/fav" image="docker.io/library/postgres:16-alpine" fallback={FB} />);
    fireEvent.error(container.querySelector("img")!);
    expect(srcs(container)).toEqual(["/icons/postgresql.svg"]);
  });

  it("falls through to the catalog brand, then to the fallback", () => {
    const { container } = render(<ResourceIcon faviconUrl="/fav" image="ghcr.io/acme/api" brand={{ logo: "wordpress", slug: "wp" }} fallback={FB} />);
    fireEvent.error(container.querySelector("img")!);
    expect(srcs(container)).toEqual(["/icons/wordpress.svg"]);
    cleanup();
    render(<ResourceIcon faviconUrl="/fav" image="ghcr.io/acme/api" fallback={FB} />);
    fireEvent.error(document.querySelector("img")!);
    expect(screen.getByTestId("fallback")).toBeInTheDocument();
  });

  it("retries an uploaded icon when its URL changes after a failure", () => {
    const { container, rerender } = render(<ResourceIcon iconUrl="/i?v=1" fallback={FB} />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    rerender(<ResourceIcon iconUrl="/i?v=2" fallback={FB} />);
    expect(srcs(container)).toEqual(["/i?v=2"]);
  });

  it("renders every image at a fixed size and lazily, so a list does not shift", () => {
    const { container } = render(<ResourceIcon faviconUrl="/fav" size={22} fallback={FB} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("width")).toBe("22");
    expect(img.getAttribute("height")).toBe("22");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.style.width).toBe("22px");
    cleanup();
    const brand = render(<ResourceIcon image="redis:7" size={22} fallback={FB} />).container.querySelector("img")!;
    expect(brand.getAttribute("loading")).toBe("lazy");
    expect(brand.getAttribute("width")).toBe("22");
  });
});
