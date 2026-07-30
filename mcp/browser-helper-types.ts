export type BrowserHelperInput = {
  sessionId: string;
  endpoint: string;
  origin: string;
};

export type BrowserHelperSessionKeys = {
  stateKey: string;
  worldName: string;
  cleanupKey: string;
  pointerFlushKey: string;
};

export function browserHelperSessionKeys(sessionId: string): BrowserHelperSessionKeys {
  return {
    stateKey: `__recordlyCapture_${sessionId}`,
    worldName: `recordly-observed-${sessionId}`,
    cleanupKey: `__recordlyCleanup_${sessionId}`,
    pointerFlushKey: `__recordlyFlushPointer_${sessionId}`,
  };
}
