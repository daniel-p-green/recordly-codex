import { describe, expect, it } from "vitest";

import { iabBrowserStartHelper, iabBrowserStopHelper } from "../../mcp/browser-iab-helper.js";

const input = {
  sessionId: "session-iab-helper",
  endpoint: "http://127.0.0.1:43123",
  mailboxRoot: "/private/tmp/recordly-iab-helper",
  origin: "https://demo.example",
};

describe("Codex in-app Browser helper", () => {
  it("emits private ESM entrypoints over the tab-scoped CDP capability", () => {
    const start = iabBrowserStartHelper(input);
    const stop = iabBrowserStopHelper(input);

    expect(start).toContain("export default async function startRecordlyIabCapture(tab)");
    expect(start).toContain('tab.capabilities.get("cdp")');
    expect(start).toContain('"Page.screencastFrame"');
    expect(start).toContain('"Runtime.consoleAPICalled"');
    expect(start).toContain('"Page.frameNavigated"');
    expect(start).toContain("cdp.readEvents");
    expect(start).toContain("consecutiveReadFailures > 10");
    expect(start).toContain("if (batch.truncated)");
    expect(start).toContain("withCdp(() => cdp.readEvents");
    expect(start).toContain("withCdp(() => cdp.send");
    expect(start).toContain("globalThis[registryKey]");
    expect(start).toContain('from "node:fs/promises"');
    expect(start).toContain('"/private/tmp/recordly-iab-helper"');
    expect(start).toContain("'request-' + id + '.json'");
    expect(start).not.toContain("requestHttp");
    expect(start).not.toContain("await fetch");
    expect(start).not.toContain("browser_run_code_unsafe");
    expect(start).not.toContain("/Users/");
    expect(stop).toContain("export default async function stopRecordlyIabCapture(tab)");
    expect(stop).toContain("await runtime.session.detach()");
    expect(stop).toContain('from "node:fs/promises"');
    expect(stop).not.toContain("/Users/");
  });

  it("binds both entrypoints to one session-specific private registry identity", () => {
    const start = iabBrowserStartHelper(input);
    const stop = iabBrowserStopHelper(input);
    for (const helper of [start, stop]) {
      expect(helper).toContain('"session-iab-helper"');
      expect(helper).toContain("recordly.codex.iab-helper.v1");
      expect(helper).toContain('"https://demo.example"');
    }
  });

  it("exposes capture-owned click and scroll actions without trusting page DOM events", () => {
    const start = iabBrowserStartHelper(input);

    expect(start).toContain("return { clickSelector, scrollBy }");
    expect(start).toContain("actions: captureActions(runtime)");
    expect(start).toContain("document.querySelectorAll(selector)");
    expect(start).toContain("matches.length !== 1");
    expect(start).toContain("Input.dispatchMouseEvent");
    expect(start).toContain("type: 'mousePressed'");
    expect(start).toContain("type: 'mouseReleased'");
    expect(start).toContain("type: 'mouseWheel'");
    expect(start).toContain("await capture.post('/observed-event'");
    expect(start).toContain("capture.state.token");
    expect(start).toContain("scroll position did not change");
    expect(start).not.toContain("isTrusted: true");
  });

  it("emits valid standalone modules with one default entrypoint each", async () => {
    for (const helper of [iabBrowserStartHelper(input), iabBrowserStopHelper(input)]) {
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(helper).toString("base64")}`
      );
      expect(Object.keys(module)).toEqual(["default"]);
      expect(module.default).toBeTypeOf("function");
    }
  });
});
