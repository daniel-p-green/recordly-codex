/**
 * Source lines embedded inside browserStartHelper's installObserved closure.
 * Kept as generator text so the emitted helper still interpolates `marker` and
 * session keys at Browser-runtime via template literals.
 */
export function observerExpressionSourceLines(): readonly string[] {
  return [
    "    const expression = `(() => {",
    "      const nonceBytes = new Uint8Array(32); crypto.getRandomValues(nonceBytes);",
    "      const nonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits cleanup-key serialization into the Browser helper template.
    "      const debug = console.debug.bind(console); const prior = globalThis[${JSON.stringify(cleanupKey)}]; if (typeof prior === 'function') prior();",
    "      let lastX = window.scrollX; let lastY = window.scrollY; let wheelScheduled = false; let wheelAttempts = 0; let wheelRaf; let wheelTimer;",
    "      let pointerPending; let pointerRaf; let pointerTimer; let lastPointerSentAt = -Infinity;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits marker serialization into the Browser helper template.
    "      const send = (event) => debug(${JSON.stringify(marker)}, JSON.stringify({ kind: 'event', nonce, event }));",
    "      const click = (event) => { if (event.isTrusted) send({ type: 'click', data: { x: event.clientX, y: event.clientY, button: event.button } }); };",
    "      const emitPointer = () => { pointerRaf = undefined; pointerTimer = undefined; const event = pointerPending; pointerPending = undefined; if (event === undefined) return; const elapsed = performance.now() - lastPointerSentAt; if (elapsed < 33) { pointerPending = event; pointerTimer = setTimeout(emitPointer, Math.ceil(33 - elapsed)); return; } lastPointerSentAt = performance.now(); send({ type: 'pointer', data: { x: event.x, y: event.y, buttons: event.buttons, cursor: event.buttons === 0 ? 'default' : 'pressed' } }); };",
    "      const pointer = (event) => { if (!event.isTrusted || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || !Number.isSafeInteger(event.buttons) || event.buttons < 0 || event.buttons > 31) return; pointerPending = { x: event.clientX, y: event.clientY, buttons: event.buttons }; if (pointerRaf === undefined && pointerTimer === undefined) pointerRaf = requestAnimationFrame(emitPointer); };",
    "      const flushPointer = () => { if (pointerRaf !== undefined) cancelAnimationFrame(pointerRaf); if (pointerTimer !== undefined) clearTimeout(pointerTimer); pointerRaf = undefined; pointerTimer = undefined; if (pointerPending !== undefined) { lastPointerSentAt = -Infinity; emitPointer(); } };",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits marker serialization into the Browser helper template.
    "      const settleWheel = () => { wheelRaf = requestAnimationFrame(() => { const x = window.scrollX; const y = window.scrollY; const deltaX = x - lastX; const deltaY = y - lastY; if (deltaX !== 0 || deltaY !== 0) { wheelScheduled = false; lastX = x; lastY = y; debug(${JSON.stringify(marker)}, JSON.stringify({ kind: 'event', nonce, event: { type: 'scroll', data: { x, y, deltaX, deltaY } } })); return; } if (wheelAttempts++ >= 119) { wheelScheduled = false; return; } wheelTimer = setTimeout(settleWheel, 16); }); };",
    "      const wheel = (event) => { if (!event.isTrusted || wheelScheduled) return; wheelScheduled = true; wheelAttempts = 0; settleWheel(); };",
    "      window.addEventListener('pointermove', pointer, { capture: true, passive: true }); window.addEventListener('click', click, true); window.addEventListener('wheel', wheel, { capture: true, passive: true });",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits flush/cleanup key serialization into the Browser helper template.
    "      globalThis[${JSON.stringify(pointerFlushKey)}] = flushPointer; globalThis[${JSON.stringify(cleanupKey)}] = () => { flushPointer(); window.removeEventListener('pointermove', pointer, true); window.removeEventListener('click', click, true); window.removeEventListener('wheel', wheel, true); if (wheelRaf !== undefined) cancelAnimationFrame(wheelRaf); if (wheelTimer !== undefined) clearTimeout(wheelTimer); delete globalThis[${JSON.stringify(pointerFlushKey)}]; delete globalThis[${JSON.stringify(cleanupKey)}]; };",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits marker serialization into the Browser helper template.
    "      debug(${JSON.stringify(marker)}, JSON.stringify({ kind: 'ready', nonce }));",
    "    })()`;",
  ];
}

/** Runtime.evaluate expressions for cleanup/flush against a known isolated-world key. */
export function isolatedWorldKeyExpressionSource(
  keyName: "cleanupKey" | "pointerFlushKey",
): string {
  if (keyName === "cleanupKey") {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits cleanup-key serialization into the Browser helper template.
    return "(() => { const cleanup = globalThis[${JSON.stringify(cleanupKey)}]; if (typeof cleanup === 'function') cleanup(); })()";
  }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: emits pointer-flush key serialization into the Browser helper template.
  return "(() => { const flush = globalThis[${JSON.stringify(pointerFlushKey)}]; if (typeof flush === 'function') flush(); })()";
}
