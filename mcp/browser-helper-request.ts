import type { BrowserHelperInput } from "./browser-helper-types.js";

/** Emits the loopback POST helper shared by start/stop Browser entrypoints. */
export function browserHelperRequestCode(input: BrowserHelperInput): string {
  return [
    `const endpoint = ${JSON.stringify(input.endpoint)};`,
    `const recordingSessionId = ${JSON.stringify(input.sessionId)};`,
    `const recordingOrigin = ${JSON.stringify(input.origin)};`,
    "const post = async (path, body, token) => {",
    `  const response = await page.request.post(\`\${endpoint}\${path}\`, {`,
    "    headers: token === undefined ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', 'x-recordly-capability': token },",
    "    data: body,",
    "  });",
    "  const result = await response.json();",
    "  if (!response.ok() || result.ok !== true) throw new Error('recordly capture broker rejected request');",
    "  return result;",
    "};",
  ].join("\n");
}
