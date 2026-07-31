// biome-ignore-all lint/complexity/useLiteralKeys: mailbox payloads are untrusted dictionaries.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCaptureMailbox } from "../../mcp/capture-mailbox.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function endpoint(): Promise<{ endpoint: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ data, token: request.headers["x-recordly-capability"] });
      if (data["mode"] === "invalid-response") {
        response.end("not json");
        return;
      }
      if (data["mode"] === "large-response") {
        response.end(JSON.stringify({ value: "x".repeat(70 * 1024) }));
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, echoed: data["value"] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server unavailable");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

async function response(
  root: string,
  id: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = join(root, `response-${id}.json`);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        status: number;
        body: Record<string, unknown>;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("mailbox response timed out");
}

async function request(
  root: string,
  value: unknown,
  id = randomUUID(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  await writeFile(join(root, `request-${id}.json`), JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  return response(root, id);
}

describe("capture mailbox", () => {
  it("forwards bounded valid requests and capability tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-mailbox-"));
    roots.push(root);
    const upstream = await endpoint();
    const mailbox = await createCaptureMailbox({
      root: join(root, "mailbox"),
      endpoint: upstream.endpoint,
    });
    const id = randomUUID();
    const token = "a".repeat(64);

    await expect(
      request(
        mailbox.root,
        { schemaVersion: 1, id, path: "/claim", token, data: { value: "safe" } },
        id,
      ),
    ).resolves.toEqual({ status: 201, body: { ok: true, echoed: "safe" } });
    expect(upstream.requests).toEqual([{ data: { value: "safe" }, token }]);
    await mailbox.close();
  });

  it("rejects every malformed envelope shape without forwarding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-mailbox-invalid-"));
    roots.push(root);
    const upstream = await endpoint();
    const mailbox = await createCaptureMailbox({
      root: join(root, "mailbox"),
      endpoint: upstream.endpoint,
    });
    const id = randomUUID();
    const base = { schemaVersion: 1, id, path: "/claim", data: {} };
    const invalid = [
      null,
      [],
      { ...base, schemaVersion: 2 },
      { ...base, id: randomUUID() },
      { ...base, path: "/unknown" },
      { ...base, extra: true },
      { schemaVersion: 1, id, path: "/claim" },
      { ...base, token: 1 },
      { ...base, token: "bad" },
    ];

    for (const [index, value] of invalid.entries()) {
      const requestId = index === 3 ? id : randomUUID();
      const envelope =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? { ...value, id: index === 3 ? randomUUID() : requestId }
          : value;
      await expect(request(mailbox.root, envelope, requestId)).resolves.toEqual({
        status: 400,
        body: { ok: false },
      });
    }
    expect(upstream.requests).toEqual([]);
    await mailbox.close();
  });

  it("bounds malformed upstream responses and removes unsafe request files", async () => {
    const root = await mkdtemp(join(tmpdir(), "recordly-mailbox-errors-"));
    roots.push(root);
    const upstream = await endpoint();
    const mailbox = await createCaptureMailbox({
      root: join(root, "mailbox"),
      endpoint: upstream.endpoint,
    });

    for (const mode of ["invalid-response", "large-response"]) {
      const id = randomUUID();
      await expect(
        request(mailbox.root, { schemaVersion: 1, id, path: "/claim", data: { mode } }, id),
      ).resolves.toEqual({ status: 400, body: { ok: false } });
    }

    const malformedId = randomUUID();
    await writeFile(join(mailbox.root, `request-${malformedId}.json`), "{", { mode: 0o600 });
    await expect(response(mailbox.root, malformedId)).resolves.toEqual({
      status: 400,
      body: { ok: false },
    });

    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    const symlinkId = randomUUID();
    await symlink(target, join(mailbox.root, `request-${symlinkId}.json`));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(readFile(join(mailbox.root, `request-${symlinkId}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await mailbox.close();
  });
});
