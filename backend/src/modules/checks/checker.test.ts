import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkUrl } from "./checker.js";

let server: http.Server;
let baseUrl: string;
let closedPortUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/ok":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        break;
      case "/500":
        res.writeHead(500);
        res.end("boom");
        break;
      case "/redirect":
        res.writeHead(302, { location: "/ok" });
        res.end();
        break;
      case "/slow":
        // Deliberately never responds so the client has to time out.
        break;
      default:
        res.writeHead(404);
        res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Open a port and close it again, so nothing is listening there and we get
  // a real ECONNREFUSED.
  const spare = http.createServer();
  await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
  const sparePort = (spare.address() as AddressInfo).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));
  closedPortUrl = `http://127.0.0.1:${sparePort}/`;
});

afterAll(async () => {
  // /slow leaves a socket hanging; drop it or close() never settles.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("checkUrl", () => {
  it("reports UP for a 200", async () => {
    const result = await checkUrl(`${baseUrl}/ok`);
    expect(result.status).toBe("UP");
    expect(result.statusCode).toBe(200);
    expect(result.errorType).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("follows a redirect through to the final 200", async () => {
    const result = await checkUrl(`${baseUrl}/redirect`);
    expect(result.status).toBe("UP");
    expect(result.statusCode).toBe(200);
  });

  it("reports DOWN with HTTP_ERROR for a 500", async () => {
    const result = await checkUrl(`${baseUrl}/500`);
    expect(result.status).toBe("DOWN");
    expect(result.statusCode).toBe(500);
    expect(result.errorType).toBe("HTTP_ERROR");
  });

  it("reports TIMEOUT when the server never responds", async () => {
    const result = await checkUrl(`${baseUrl}/slow`, { timeoutMs: 500 });
    expect(result.status).toBe("DOWN");
    expect(result.statusCode).toBeNull();
    expect(result.errorType).toBe("TIMEOUT");
    expect(result.responseMs).toBeGreaterThanOrEqual(400);
  });

  it("reports CONN_REFUSED for a closed port", async () => {
    const result = await checkUrl(closedPortUrl);
    expect(result.status).toBe("DOWN");
    expect(result.statusCode).toBeNull();
    expect(result.errorType).toBe("CONN_REFUSED");
  });
});
