// biome-ignore-all lint/complexity/useLiteralKeys: mailbox payloads are untrusted dictionary data.
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { join } from "node:path";

const REQUEST_NAME = /^request-([0-9a-f-]{36})\.json$/u;
const REQUEST_LIMIT_BYTES = 9 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 5;
const ALLOWED_PATHS = new Set([
  "/claim",
  "/fail",
  "/frame",
  "/observed-event",
  "/observer-challenge",
  "/stop",
]);

type MailboxRequest = {
  schemaVersion: 1;
  id: string;
  path: string;
  token?: string;
  data: unknown;
};

export type CaptureMailbox = {
  root: string;
  close(): Promise<void>;
};

function parseRequest(value: unknown, expectedId: string): MailboxRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_mailbox_request");
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (
    request["schemaVersion"] !== 1 ||
    request["id"] !== expectedId ||
    typeof request["path"] !== "string" ||
    !ALLOWED_PATHS.has(request["path"]) ||
    !keys.every((key) => ["schemaVersion", "id", "path", "token", "data"].includes(key)) ||
    !Object.hasOwn(request, "data") ||
    (request["token"] !== undefined &&
      (typeof request["token"] !== "string" || !/^[0-9a-f]{64}$/u.test(request["token"])))
  ) {
    throw new Error("invalid_mailbox_request");
  }
  return request as MailboxRequest;
}

async function post(
  endpoint: string,
  request: MailboxRequest,
): Promise<{ status: number; body: unknown }> {
  const target = new URL(request.path, endpoint);
  const serialized = JSON.stringify(request.data);
  return await new Promise((resolve, reject) => {
    const outgoing = requestHttp(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(serialized),
          ...(request.token === undefined ? {} : { "x-recordly-capability": request.token }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > RESPONSE_LIMIT_BYTES) {
            outgoing.destroy(new Error("mailbox_response_too_large"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            });
          } catch {
            reject(new Error("invalid_mailbox_response"));
          }
        });
      },
    );
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("mailbox_request_timeout")));
    outgoing.once("error", reject);
    outgoing.end(serialized);
  });
}

export async function createCaptureMailbox(input: {
  root: string;
  endpoint: string;
}): Promise<CaptureMailbox> {
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  let active = true;
  let processing = Promise.resolve();

  const consume = async (): Promise<void> => {
    const names = (await readdir(input.root)).filter((name) => REQUEST_NAME.test(name)).sort();
    for (const name of names) {
      const match = REQUEST_NAME.exec(name);
      if (match === null) continue;
      const id = match[1] as string;
      const requestPath = join(input.root, name);
      const status = await lstat(requestPath);
      if (!status.isFile() || status.isSymbolicLink() || status.size > REQUEST_LIMIT_BYTES) {
        await unlink(requestPath).catch(() => undefined);
        continue;
      }
      let response: { status: number; body: unknown };
      try {
        const request = parseRequest(
          JSON.parse(await readFile(requestPath, "utf8")) as unknown,
          id,
        );
        response = await post(input.endpoint, request);
      } catch {
        response = { status: 400, body: { ok: false } };
      }
      await unlink(requestPath).catch(() => undefined);
      const destination = join(input.root, `response-${id}.json`);
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, JSON.stringify(response), { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    }
  };

  const timer = setInterval(() => {
    if (!active) return;
    processing = processing.then(consume).catch(() => undefined);
  }, POLL_INTERVAL_MS);
  timer.unref();

  return {
    root: input.root,
    close: async () => {
      active = false;
      clearInterval(timer);
      await processing;
      await rm(input.root, { recursive: true, force: true });
    },
  };
}
