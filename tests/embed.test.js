// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { embeddingOrigin, setupEmbed } from '../web/embed.js';

/*
 * The editor inside the browser extension's side panel. See web/embed.js.
 *
 * A window here is a stand-in with the parts the bridge reads: its parent,
 * the origin that framed it, and message events. The point of most of these
 * is who is *not* listened to or told anything.
 */

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function framedBy(ancestor) {
  const listeners = [];
  const parent = { postMessage: vi.fn() };
  const win = {
    parent,
    location: { ancestorOrigins: ancestor ? [ancestor] : [] },
    document: { referrer: '', documentElement: document.createElement('html') },
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
  };
  const send = async (data, { source = parent, origin = ancestor } = {}) => {
    for (const fn of listeners) await fn({ data, source, origin });
  };
  return { win, parent, send };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('who counts as the side panel', () => {
  it('nobody, at the top of its own tab', () => {
    const win = { parent: null, location: {}, document: {} };
    win.parent = win;
    expect(embeddingOrigin(win)).toBeNull();
  });

  it('an extension page that framed it', () => {
    expect(embeddingOrigin(framedBy(EXT).win)).toBe(EXT);
  });

  it('not a web page that framed it, whatever the server let through', () => {
    expect(embeddingOrigin(framedBy('https://evil.example').win)).toBeNull();
    expect(embeddingOrigin(framedBy('http://127.0.0.1:4600').win)).toBeNull();
    expect(embeddingOrigin(framedBy('chrome-extension://short').win)).toBeNull();
  });
});

describe('the bridge', () => {
  const state = { resumeId: 'newgrad', label: 'New grad', exists: true, save: 'saved' };

  it('stays off, and says nothing, when a web page framed it', async () => {
    const { win, parent, send } = framedBy('https://evil.example');
    const open = vi.fn();
    const bridge = setupEmbed({ win, getState: () => state, open, flush: vi.fn() });
    expect(bridge.embedded).toBe(false);
    await send({ rmm: 'open', id: 'intern', seq: 1 });
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('says what is on screen to the panel, and only to the panel’s origin', async () => {
    const { win, parent } = framedBy(EXT);
    const bridge = setupEmbed({ win, getState: () => state, open: vi.fn(), flush: vi.fn() });
    await settle();
    expect(bridge.embedded).toBe(true);
    expect(win.document.documentElement.classList.contains('embedded')).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({ rmm: 'state', ...state }, EXT);

    // Once per change: the same state again is not news.
    bridge.announce();
    bridge.announce();
    await settle();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it('moves when asked, and answers whether it moved', async () => {
    const { win, parent, send } = framedBy(EXT);
    let shown = 'newgrad';
    const open = vi.fn(async (id) => {
      if (id === 'gone') return 'missing';
      shown = id;
      return 'moved';
    });
    setupEmbed({ win, getState: () => ({ ...state, resumeId: shown }), open, flush: vi.fn() });
    await send({ rmm: 'open', id: 'intern', seq: 7 });
    expect(open).toHaveBeenCalledWith('intern');
    expect(parent.postMessage).toHaveBeenCalledWith({ rmm: 'opened', seq: 7, ok: true, reason: null, id: 'intern' }, EXT);

    // And why not, so the panel can say the right thing.
    await send({ rmm: 'open', id: 'gone', seq: 8 });
    expect(parent.postMessage).toHaveBeenCalledWith({ rmm: 'opened', seq: 8, ok: false, reason: 'missing', id: 'intern' }, EXT);
  });

  it('writes what is pending when asked, and says when it has', async () => {
    const { win, parent, send } = framedBy(EXT);
    let release;
    const flush = vi.fn(() => new Promise((r) => (release = r)));
    setupEmbed({ win, getState: () => state, open: vi.fn(), flush });
    const asked = send({ rmm: 'flush', seq: 3 });
    await settle();
    expect(parent.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ rmm: 'flushed' }), EXT);
    release(true);
    await asked;
    expect(parent.postMessage).toHaveBeenCalledWith({ rmm: 'flushed', seq: 3, ok: true }, EXT);
  });

  it('ignores messages from any other window or origin', async () => {
    const { win, send } = framedBy(EXT);
    const open = vi.fn(async () => true);
    const flush = vi.fn(async () => true);
    setupEmbed({ win, getState: () => state, open, flush });
    await send({ rmm: 'open', id: 'intern', seq: 1 }, { source: {} });
    await send({ rmm: 'open', id: 'intern', seq: 1 }, { origin: 'https://evil.example' });
    await send({ rmm: 'flush', seq: 2 }, { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' });
    await send('open');
    expect(open).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('passes the panel’s remembered view on to the narrow layout', async () => {
    const { win, send } = framedBy(EXT);
    const compact = { setView: vi.fn(), setFocus: vi.fn() };
    setupEmbed({ win, getState: () => state, open: vi.fn(), flush: vi.fn(), compact });
    await send({ rmm: 'view', view: 'preview', focus: true });
    expect(compact.setView).toHaveBeenCalledWith('preview');
    expect(compact.setFocus).toHaveBeenCalledWith(true);
  });

  it('takes the save again when the panel says it changed underneath', async () => {
    const { win, send } = framedBy(EXT);
    const refresh = vi.fn(async () => {});
    setupEmbed({ win, getState: () => state, open: vi.fn(), flush: vi.fn(), refresh });
    await send({ rmm: 'refresh' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
