import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

/** Shared limits for FFmpeg/FFprobe processes on production render and seal paths. */
export const MEDIA_PROCESS_POLICY = {
  maxConcurrent: 2,
  maxOutputBytes: 128 * 1024,
  terminateGraceMs: 2_000,
  presentationEncodeDeadlineMs: 20 * 60 * 1_000,
  sealedEncodeDeadlineMs: 15 * 60 * 1_000,
  inspectionDeadlineMs: 2 * 60 * 1_000,
} as const;

export type MediaProcessResult = { stdout: string; stderr: string };

export type MediaProcessOptions = {
  executable: string;
  args: readonly string[];
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  terminateGraceMs?: number;
  /** Called after the process is admitted. The policy owns closing and destroying stdin. */
  writeInput?: (stdin: Writable) => Promise<void>;
};

class MediaProcessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MediaProcessError";
  }
}

type Permit = () => void;
type Waiter = {
  resolve: (permit: Permit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
};

class FairSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  public constructor(private readonly limit: number) {}

  public acquire(signal?: AbortSignal): Promise<Permit> {
    if (signal?.aborted)
      return Promise.reject(new MediaProcessError("media process was cancelled"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      const cancel = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new MediaProcessError("media process was cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      const grant = (): void => {
        signal?.removeEventListener("abort", cancel);
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.advance();
        });
      };
      if (this.active < this.limit && this.waiters.length === 0) {
        grant();
      } else {
        waiter.resolve = (_permit) => grant();
        this.waiters.push(waiter);
      }
    });
  }

  private advance(): void {
    while (this.active < this.limit) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      if (waiter.signal?.aborted) {
        waiter.reject(new MediaProcessError("media process was cancelled"));
        continue;
      }
      waiter.resolve(() => undefined);
    }
  }
}

const renderSemaphore = new FairSemaphore(MEDIA_PROCESS_POLICY.maxConcurrent);

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function sanitizedDiagnostic(value: Buffer, truncated: boolean): string {
  const source = value.toString("utf8");
  let cleaned = "";
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 27 && source.charCodeAt(index + 1) === 91) {
      index += 2;
      while (index < source.length) {
        const finalCode = source.charCodeAt(index);
        if (finalCode >= 64 && finalCode <= 126) break;
        index += 1;
      }
      continue;
    }
    cleaned +=
      code < 32 || code === 127
        ? code === 9 || code === 10 || code === 13
          ? source[index]
          : " "
        : source[index];
  }
  cleaned = cleaned.trim();
  return `${cleaned}${truncated ? `${cleaned.length === 0 ? "" : " "}[output truncated]` : ""}`;
}

class BoundedOutput {
  private bytes = 0;
  private readonly chunks: Buffer[] = [];
  private truncated = false;

  public append(chunk: Buffer): boolean {
    const available = this.maximumBytes - this.bytes;
    if (available <= 0) {
      this.truncated = true;
      return false;
    }
    const retained = chunk.subarray(0, available);
    this.chunks.push(retained);
    this.bytes += retained.length;
    if (retained.length !== chunk.length) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  public diagnostic(): string {
    return sanitizedDiagnostic(Buffer.concat(this.chunks), this.truncated);
  }

  public constructor(private readonly maximumBytes: number) {}
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function describeDiagnostic(stderr: BoundedOutput, stdout: BoundedOutput): string {
  const combined = [stderr.diagnostic(), stdout.diagnostic()].filter(Boolean).join(" | ");
  return combined.length === 0 ? "" : `: ${combined}`;
}

/**
 * Runs a local FFmpeg/FFprobe command under a process-wide FIFO render budget.
 * On macOS and Linux each command starts a process group so timeout/cancellation
 * terminates its descendants before the permit is released.
 */
export async function runMediaProcess(input: MediaProcessOptions): Promise<MediaProcessResult> {
  assertPositiveInteger(input.timeoutMs, "media process timeout");
  const maximumBytes = input.maxOutputBytes ?? MEDIA_PROCESS_POLICY.maxOutputBytes;
  const terminateGraceMs = input.terminateGraceMs ?? MEDIA_PROCESS_POLICY.terminateGraceMs;
  assertPositiveInteger(maximumBytes, "media process output bound");
  assertPositiveInteger(terminateGraceMs, "media process termination grace period");

  const release = await renderSemaphore.acquire(input.signal);
  try {
    return await runAdmittedMediaProcess({
      ...input,
      maxOutputBytes: maximumBytes,
      terminateGraceMs,
    });
  } finally {
    release();
  }
}

async function runAdmittedMediaProcess(
  input: MediaProcessOptions & { maxOutputBytes: number; terminateGraceMs: number },
): Promise<MediaProcessResult> {
  const stdout = new BoundedOutput(input.maxOutputBytes);
  const stderr = new BoundedOutput(input.maxOutputBytes);
  const child = spawn(input.executable, input.args, {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let forcedFailure: string | undefined;
  let spawnFailure: Error | undefined;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;

  const terminate = (reason: string): void => {
    if (forcedFailure !== undefined || closed) return;
    forcedFailure = reason;
    try {
      signalProcessGroup(child, "SIGTERM");
    } catch (error) {
      forcedFailure = `${reason}; SIGTERM failed: ${(error as Error).message}`;
    }
    killTimer = setTimeout(() => {
      try {
        signalProcessGroup(child, "SIGKILL");
      } catch (error) {
        forcedFailure = `${forcedFailure ?? reason}; SIGKILL failed: ${(error as Error).message}`;
      }
    }, input.terminateGraceMs);
  };

  const onOutput = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const collector = stream === "stdout" ? stdout : stderr;
    if (!collector.append(chunk)) {
      terminate(
        `media process ${input.label} ${stream} output exceeded ${input.maxOutputBytes} bytes`,
      );
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => onOutput("stderr", chunk));

  const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
    child.once("error", (error: Error) => {
      spawnFailure = error;
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      const diagnostic = describeDiagnostic(stderr, stdout);
      if (forcedFailure !== undefined) {
        rejectCompleted(new MediaProcessError(`${forcedFailure}${diagnostic}`));
      } else if (spawnFailure !== undefined) {
        rejectCompleted(
          new MediaProcessError(
            `media process ${input.label} failed to start: ${spawnFailure.message}${diagnostic}`,
          ),
        );
      } else if (code !== 0) {
        rejectCompleted(
          new MediaProcessError(
            `media process ${input.label} exited with code ${code ?? "unknown"}${signal === null ? "" : ` (${signal})`}${diagnostic}`,
          ),
        );
      } else {
        resolveCompleted();
      }
    });
  });
  const deadline = setTimeout(
    () => terminate(`media process ${input.label} timed out after ${input.timeoutMs}ms`),
    input.timeoutMs,
  );
  const cancel = (): void => terminate(`media process ${input.label} was cancelled`);
  input.signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (input.signal?.aborted) cancel();
    if (input.writeInput !== undefined) {
      if (child.stdin === null) throw new MediaProcessError("media process stdin is unavailable");
      await Promise.race([
        input.writeInput(child.stdin),
        completed.then(() => {
          throw new MediaProcessError(`media process ${input.label} exited before input completed`);
        }),
      ]);
      child.stdin.end();
    }
    await completed;
    return { stdout: stdout.diagnostic(), stderr: stderr.diagnostic() };
  } catch (error) {
    child.stdin?.destroy();
    terminate(`media process ${input.label} was cancelled after input failed`);
    await completed.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", cancel);
  }
}
