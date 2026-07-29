import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("browser capture runtime contract", () => {
  it("exports per-session runtime functions and no generic browser-run wrappers", async () => {
    const runtime = await import(new URL("../../browser/capture-runtime.js", import.meta.url).href);
    expect(runtime.startBrowserCapture).toBeTypeOf("function");
    expect(runtime.stopBrowserCapture).toBeTypeOf("function");
    await expect(
      access(new URL("../../browser/start-browser-capture.mjs", import.meta.url)),
    ).rejects.toThrow();
    await expect(
      access(new URL("../../browser/stop-browser-capture.mjs", import.meta.url)),
    ).rejects.toThrow();
  });
});
