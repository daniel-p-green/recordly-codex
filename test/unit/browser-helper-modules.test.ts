import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { browserStartHelper, browserStopHelper } from "../../mcp/browser-helper.js";
import { observerExpressionSourceLines } from "../../mcp/browser-helper-observer.js";
import { browserHelperSessionKeys } from "../../mcp/browser-helper-types.js";

describe("browser helper modules", () => {
  const input = {
    sessionId: "session-helper-modules",
    endpoint: "http://127.0.0.1:9",
    origin: "https://example.test",
  };

  it("derives stable per-session keys", () => {
    expect(browserHelperSessionKeys(input.sessionId)).toEqual({
      stateKey: "__recordlyCapture_session-helper-modules",
      worldName: "recordly-observed-session-helper-modules",
      cleanupKey: "__recordlyCleanup_session-helper-modules",
      pointerFlushKey: "__recordlyFlushPointer_session-helper-modules",
    });
  });

  it("keeps the isolated observer expression as reviewable source lines", () => {
    const lines = observerExpressionSourceLines();
    expect(lines.some((line) => line.includes("event.isTrusted"))).toBe(true);
    expect(lines.some((line) => line.includes("kind: 'ready'"))).toBe(true);
    expect(lines.some((line) => line.includes("JSON.stringify(marker)"))).toBe(true);
  });

  it("emits start/stop helpers that bind the session keys and observer contract", () => {
    const start = browserStartHelper(input);
    const stop = browserStopHelper(input);
    expect(start).toContain("__recordlyCapture_session-helper-modules");
    expect(start).toContain("Page.createIsolatedWorld");
    expect(start).toContain("/observer-challenge");
    expect(stop).toContain("/stop");
    expect(createHash("sha256").update(start).digest("hex")).toHaveLength(64);
  });
});
