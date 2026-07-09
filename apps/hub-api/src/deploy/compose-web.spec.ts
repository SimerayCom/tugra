import { inferComposeWeb } from "./compose-web";

const wordpress = `services:
  wordpress:
    image: wordpress:6
    depends_on:
      - db
    ports:
      - "8080:80"
    volumes:
      - wp_data:/var/www/html
  db:
    image: mariadb:11
    volumes:
      - db_data:/var/lib/mysql
volumes:
  wp_data:
  db_data:
`;

describe("inferComposeWeb", () => {
  it("picks the first service that publishes a port + its container port", () => {
    expect(inferComposeWeb(wordpress)).toEqual({ service: "wordpress", port: 80 });
  });

  it("reads the container side of a same-number mapping", () => {
    const yml = `services:\n  n8n:\n    image: n8n\n    ports:\n      - "5678:5678"\n`;
    expect(inferComposeWeb(yml)).toEqual({ service: "n8n", port: 5678 });
  });

  it("reads a non-80 container port", () => {
    const yml = `services:\n  actual_server:\n    image: actual\n    ports:\n      - "20002:5006"\n`;
    expect(inferComposeWeb(yml)).toEqual({ service: "actual_server", port: 5006 });
  });

  it("handles the host-ip:host:container form", () => {
    const yml = `services:\n  app:\n    ports:\n      - "127.0.0.1:8080:80"\n`;
    expect(inferComposeWeb(yml)).toEqual({ service: "app", port: 80 });
  });

  it("handles a container-only port and a /tcp suffix", () => {
    expect(inferComposeWeb(`services:\n  app:\n    ports:\n      - "3000"\n`)).toEqual({ service: "app", port: 3000 });
    expect(inferComposeWeb(`services:\n  app:\n    ports:\n      - "8080:80/tcp"\n`)).toEqual({ service: "app", port: 80 });
  });

  it("supports the inline flow-list form", () => {
    expect(inferComposeWeb(`services:\n  web:\n    ports: ["8080:80", "443:443"]\n`)).toEqual({ service: "web", port: 80 });
  });

  it("handles the same-column block-sequence style (dash aligned with the ports: key)", () => {
    // valid YAML: the `- ` sits at the same indent as `ports:`
    expect(inferComposeWeb(`services:\n  web:\n    ports:\n    - "8080:80"\n`)).toEqual({ service: "web", port: 80 });
  });

  it("skips a first service with no ports and uses the next one that has them", () => {
    const yml = `services:\n  db:\n    image: postgres\n    volumes:\n      - d:/data\n  web:\n    image: app\n    ports:\n      - "9000:3000"\n`;
    expect(inferComposeWeb(yml)).toEqual({ service: "web", port: 3000 });
  });

  it("never treats depends_on / expose / volume list items as published ports", () => {
    const yml = `services:\n  worker:\n    image: worker\n    depends_on:\n      - db\n    expose:\n      - "3000"\n    volumes:\n      - "9000:9000"\n`;
    expect(inferComposeWeb(yml)).toBeNull();
  });

  it("returns null when no service publishes a port", () => {
    const yml = `services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n`;
    expect(inferComposeWeb(yml)).toBeNull();
  });

  it("returns null for empty / missing / port-less input", () => {
    expect(inferComposeWeb(null)).toBeNull();
    expect(inferComposeWeb("")).toBeNull();
    expect(inferComposeWeb("version: '3'\n")).toBeNull();
  });
});
