'use strict';

// Runs in each frame's isolated world. Only booleans leave the document; no
// field value, page text, URL, request body or account data is returned.
const PROBE = `(() => {
  let draft = false, media = false, unknown = false, stateful = false;
  const roots = [document];
  let inspected = 0;
  for (const root of roots) {
    for (const element of root.querySelectorAll('*')) {
      if (++inspected > 30000) return { draft: true, media: true, unknown: true, stateful: true };
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (element.localName?.includes('-') && !element.shadowRoot) unknown = true;
      if (element.matches('audio, video') && !element.paused && !element.ended) media = true;
      if (element.matches('[aria-busy="true"], progress:not([value])')) unknown = true;
      if (element.matches('button, [role="button"], form, input, textarea, select, [contenteditable]')) stateful = true;
      if (element.isContentEditable && element.textContent.trim()) draft = true;
      if (element.localName === 'textarea' && element.value !== element.defaultValue) draft = true;
      if (element.localName === 'select' && [...element.options].some(o => o.selected !== o.defaultSelected)) draft = true;
      if (element.localName === 'input') {
        if (element.type === 'file' ? element.files?.length :
            ['checkbox', 'radio'].includes(element.type) ? element.checked !== element.defaultChecked :
            element.value !== element.defaultValue) draft = true;
      }
    }
  }
  return { draft, media, unknown, stateful };
})()`;

const UNSAFE = Object.freeze({ draft: true, media: true, unknown: true, stateful: true });

async function inspectPage(contents, timeout = 1200) {
  let timer;
  try {
    if (!contents || contents.isDestroyed() || contents.isCrashed()) return UNSAFE;
    const frames = [...contents.mainFrame.framesInSubtree];
    // WebFrameMain has no isolated-world evaluation API. Treat embedded frames
    // conservatively instead of trusting scripts in a third-party frame world.
    if (frames.length !== 1) return UNSAFE;
    const result = await Promise.race([
      Promise.all([contents.executeJavaScriptInIsolatedWorld(1011, [{ code: PROBE }])]),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
    ]);
    if (!result || result.some(item => !item || typeof item.draft !== 'boolean')) return UNSAFE;
    return result.reduce((all, item) => ({
      draft: all.draft || item.draft, media: all.media || item.media,
      unknown: all.unknown || item.unknown, stateful: all.stateful || item.stateful,
    }), { draft: false, media: false, unknown: false, stateful: false });
  } catch { return UNSAFE; }
  finally { clearTimeout(timer); }
}

// Electron's beforeunload gate is the final authority. Timeouts and refusals
// keep the page alive; automatic reclamation never overrides them.
const closing = new WeakMap();
function closePage(contents, { confirm = null, timeout = 8000, canClose = () => true } = {}) {
  if (!contents || contents.isDestroyed()) return Promise.resolve(true);
  if (closing.has(contents)) return closing.get(contents);
  const promise = new Promise(resolve => {
    let finished = false;
    let timer;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      contents.removeListener('destroyed', destroyed);
      contents.removeListener('will-prevent-unload', prevented);
      resolve(value);
    };
    const destroyed = () => finish(true);
    const prevented = async () => {
      // The default action keeps the page. Confirm asynchronously, then close
      // explicitly only after the user agreed and ownership is still valid.
      if (!confirm) return finish(false);
      clearTimeout(timer);
      try {
        const accepted = await confirm();
        if (finished || !accepted || !canClose()) return finish(false);
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        if (contents.isDestroyed()) finish(true);
        else timer = setTimeout(() => finish(false), timeout);
      } catch { finish(false); }
    };
    contents.once('destroyed', destroyed);
    contents.once('will-prevent-unload', prevented);
    timer = setTimeout(() => finish(false), timeout);
    try {
      if (!canClose()) return finish(false);
      contents.close({ waitForBeforeUnload: true });
    } catch { finish(contents.isDestroyed()); }
  });
  closing.set(contents, promise);
  promise.finally(() => closing.delete(contents));
  return promise;
}

module.exports = { inspectPage, closePage };
