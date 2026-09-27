// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The preview drawn for the width it is shown at. See `createPreview`.
 *
 * pdf.js is replaced by a page of US Letter that records the scale it was
 * drawn at, and ResizeObserver by one the test fires by hand, because jsdom
 * has neither a PDF renderer nor layout.
 */

const drawn = [];
vi.mock('../web/vendor/pdf.min.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      destroy() {},
      getPage: async () => ({
        getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
        render: ({ viewport }) => {
          drawn.push(viewport.width);
          return { promise: Promise.resolve() };
        },
      }),
    }),
  }),
}));

let observed = [];
class FakeResizeObserver {
  constructor(fn) {
    this.fn = fn;
    observed.push(this);
  }
  observe() {}
}

const width = (el, px) => Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => px() });
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  drawn.length = 0;
  observed = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  HTMLCanvasElement.prototype.getContext = () => ({});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function preview(paneWidth) {
  vi.resetModules();
  const { createPreview } = await import('../web/preview.js');
  const container = document.createElement('div');
  document.body.append(container);
  const p = createPreview(container);
  const pages = container.querySelector('.pdf-pages');
  width(pages, paneWidth);
  width(container, paneWidth);
  return { p, pages };
}

describe('the preview’s width', () => {
  it('draws again once a pane that was hidden is shown', async () => {
    let now = 0; // hidden: the narrow layout shows one column at a time
    const { p, pages } = await preview(() => now);
    await p.show('/pdf/a.pdf');
    // Drawn for no width, so at the fallback, and stretched to the pane later.
    expect(drawn.at(-1)).toBeGreaterThan(0);
    const before = drawn.length;

    now = 380;
    observed[0].fn();
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(drawn.length).toBe(before + 1);
    expect(Math.round(pages.querySelector('canvas').style.width.replace('px', ''))).toBe(380);
    // In proportion: the height was worked out for the same width.
    expect(Math.round(parseFloat(pages.querySelector('canvas').style.height))).toBe(Math.floor(792 * (380 / 612)));
  });

  it('leaves alone a change too small to see, and a pane with no width', async () => {
    let now = 400;
    const { p } = await preview(() => now);
    await p.show('/pdf/a.pdf');
    const before = drawn.length;
    now = 404;
    observed[0].fn();
    now = 0;
    observed[0].fn();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(drawn.length).toBe(before);
  });

  it('shows the page at its real size when zoomed, and does not refit it on resize', async () => {
    let now = 380;
    const { p, pages } = await preview(() => now);
    await p.show('/pdf/a.pdf');
    await p.setZoom(1);
    expect(pages.classList.contains('zoomed')).toBe(true);
    expect(pages.querySelector('canvas').style.width).toBe('612px');
    const before = drawn.length;
    now = 300;
    observed[0].fn();
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(drawn.length).toBe(before);

    await p.setZoom('fit');
    expect(pages.classList.contains('zoomed')).toBe(false);
    expect(pages.querySelector('canvas').style.width).toBe('300px');
  });
});
