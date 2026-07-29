type BrowserHelperInput = {
  sessionId: string;
  endpoint: string;
};

function requestCode(input: BrowserHelperInput): string {
  return [
    `const endpoint = ${JSON.stringify(input.endpoint)};`,
    `const recordingSessionId = ${JSON.stringify(input.sessionId)};`,
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

/** Generates a Browser-runner function snippet: no imports, filesystem, process, or model paths. */
export function browserStartHelper(input: BrowserHelperInput): string {
  const stateKey = `__recordlyCapture_${input.sessionId}`;
  return [
    "async (page) => {",
    requestCode(input),
    `  const stateKey = ${JSON.stringify(stateKey)};`,
    "  if (page[stateKey] !== undefined) throw new Error('recordly capture already started');",
    "  const claim = await post('/claim', { sessionId: recordingSessionId, url: page.url() });",
    "  const token = claim.token;",
    "  if (typeof token !== 'string') throw new Error('recordly capture claim failed');",
    "  const session = await page.context().newCDPSession(page);",
    "  const state = { active: true, receivedFrames: 0, acceptedFrames: 0, ackedFrames: 0, rejectedFrames: 0, degraded: false, pending: [], token };",
    "  const listener = (frame) => {",
    "    if (!state.active) return;",
    "    state.receivedFrames += 1;",
    "    if (state.pending.length >= 120) { state.rejectedFrames += 1; state.active = false; return; }",
    "    const task = (async () => {",
    "      const result = await post('/frame', { sessionId: recordingSessionId, url: page.url(), frame }, state.token);",
    "      state.acceptedFrames += 1;",
    "      if (result.degrade === true && !state.degraded) {",
    "        state.degraded = true;",
    "        await session.send('Page.startScreencast', { format: 'jpeg', quality: 63, maxWidth: 1152, maxHeight: 720 });",
    "      }",
    "      await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId });",
    "      state.ackedFrames += 1;",
    "    })().catch(() => { state.rejectedFrames += 1; state.active = false; });",
    "    state.pending.push(task);",
    "    void task.finally(() => { state.pending = state.pending.filter((item) => item !== task); });",
    "  };",
    "  session.on('Page.screencastFrame', listener);",
    "  try { await session.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1440, maxHeight: 900 }); } catch (error) { await post('/fail', { sessionId: recordingSessionId, url: page.url() }, token).catch(() => undefined); throw error; }",
    "  page[stateKey] = { session, state, listener, post, endpoint, recordingSessionId };",
    "  return { status: 'running' };",
    "}",
    "",
  ].join("\n");
}

export function browserStopHelper(input: BrowserHelperInput): string {
  const stateKey = `__recordlyCapture_${input.sessionId}`;
  return [
    "async (page) => {",
    requestCode(input),
    `  const stateKey = ${JSON.stringify(stateKey)};`,
    "  const capture = page[stateKey];",
    "  if (capture === undefined || capture.recordingSessionId !== recordingSessionId) throw new Error('recordly capture is not active');",
    "  capture.state.active = false;",
    "  capture.session.off('Page.screencastFrame', capture.listener);",
    "  await Promise.all(capture.state.pending);",
    "  await capture.session.send('Page.stopScreencast');",
    "  if (typeof capture.state.token !== 'string') throw new Error('recordly capture token is unavailable');",
    "  const result = await post('/stop', {",
    "    sessionId: recordingSessionId,",
    "    url: page.url(),",
    "    receivedFrames: capture.state.receivedFrames,",
    "    acceptedFrames: capture.state.acceptedFrames,",
    "    ackedFrames: capture.state.ackedFrames,",
    "    rejectedFrames: capture.state.rejectedFrames,",
    "    degradationRequested: capture.state.degraded,",
    "  }, capture.state.token);",
    "  delete page[stateKey];",
    "  return result;",
    "}",
    "",
  ].join("\n");
}
