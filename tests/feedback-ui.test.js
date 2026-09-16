// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';
import { renderFeedbackMarkdown } from '../web/feedback.js';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {} }) }));
vi.mock('../web/assets.js', () => ({ setupAssets: () => ({ init: async () => ({ current: '/test-save' }), load: async () => {} }) }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('feedback Markdown', () => {
  it('renders headings, emphasis, nested lists, quotes, code, links, and tables', () => {
    const fragment = renderFeedbackMarkdown('# Review\n\n**Strong** and *specific*.\n\n- Evidence\n  - Detail\n\n> Quote\n\n```text\nexample\n```\n\n| Point | Note |\n| --- | --- |\n| A | B |\n\n[Source](https://example.com)');
    expect(fragment.querySelector('h1').textContent).toBe('Review');
    expect(fragment.querySelector('strong').textContent).toBe('Strong');
    expect(fragment.querySelector('em').textContent).toBe('specific');
    expect(fragment.querySelector('li ul li').textContent).toBe('Detail');
    expect(fragment.querySelector('blockquote').textContent).toContain('Quote');
    expect(fragment.querySelector('pre code').textContent).toContain('example');
    expect(fragment.querySelectorAll('td')).toHaveLength(2);
    expect(fragment.querySelector('a').getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('removes scripts, event handlers, embedded content, and unsafe or local links', () => {
    const fragment = renderFeedbackMarkdown('<script>alert(1)</script>\n<img src="https://example.com/tracker" onerror="alert(1)"><iframe src="/api/store"></iframe>\n<p onclick="alert(1)">Text</p>\n\n[Bad](javascript:alert%281%29) [Local](/api/store) [Good](https://example.com)');
    expect(fragment.querySelector('script, img, iframe, [onclick], [onerror]')).toBeNull();
    const links = [...fragment.querySelectorAll('a')];
    expect(links.filter(link => link.hasAttribute('href'))).toHaveLength(1);
    expect(links.find(link => link.hasAttribute('href')).textContent).toBe('Good');
  });
});

describe('feedback while editing', () => {
  let data;
  let jobs;
  let requests;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    const fixture = makeTempStore();
    data = fixture.store.load();
    fixture.cleanup();
    jobs = [];
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      let result = {};
      if (url === '/api/store') result = data;
      else if (url === '/api/ai/feedback') {
        const job = { id: `job-${jobs.length}`, kind: 'feedback', about: body.variantId ?? 'Master Document', status: 'running', unread: false };
        jobs.unshift(job);
        result = { job };
      } else if (url === '/api/ai/jobs') result = { jobs };
      else if (url.startsWith('/api/ai/jobs/')) {
        result = jobs.find(job => url.endsWith(`/${job.id}`));
        result.unread = false;
      } else if (url === '/api/render') result = { pages: 3, fits: true, adjustments: [], pdfUrl: '/pdf/master.pdf' };
      else if (url.startsWith('/api/entries/') && options.method === 'PUT') {
        data.entries = data.entries.map(entry => entry.id === body.id ? body : entry);
        result = body;
      }
      return { ok: true, json: async () => structuredClone(result) };
    }));
    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#btn-feedback').onclick).toBeTypeOf('function'));
    const selector = document.querySelector('#resume-select');
    selector.value = '__master__';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.master-source-variant')).not.toBeNull());
  });

  it('targets one phrase, renders its result below the PDF, and keeps editing and earlier results available', async () => {
    const row = [...document.querySelectorAll('.master-source-variant')].find(node => node.querySelector('.text').textContent === 'Built a pipeline');
    expect(row.querySelector('.phrase-feedback').hidden).toBe(true);
    row.querySelector('.editable').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(row.querySelector('.phrase-feedback').hidden).toBe(false);
    row.querySelector('.phrase-feedback').click();
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    await vi.waitFor(() => expect(document.querySelector('#feedback-panel').hidden).toBe(false));
    expect(requests.find(request => request.url === '/api/ai/feedback').body).toEqual({ entryId: 'exp_acme', bulletId: 'b_pipeline', variantId: 'v_short', background: true });
    expect(document.querySelector('#modal').classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#preview-pane').nextElementSibling.id).toBe('feedback-panel');

    jobs[0].status = 'done';
    jobs[0].unread = true;
    jobs[0].result = { executed: true, output: '## Phrase review\n\n- Add **evidence**.' };
    await vi.advanceTimersByTimeAsync(3100);
    expect(document.querySelector('#feedback-content h2').textContent).toBe('Phrase review');
    expect(document.querySelector('#feedback-content strong').textContent).toBe('evidence');
    const text = row.querySelector('.editable');
    text.dispatchEvent(new MouseEvent('dblclick'));
    text.textContent = 'Built a documented pipeline';
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(requests.some(request => request.url.startsWith('/api/entries/') && request.body)).toBe(true));
    expect(document.querySelector('#feedback-content h2').textContent).toBe('Phrase review');
    document.querySelector('#feedback-close').click();
    expect(document.querySelector('#feedback-panel').hidden).toBe(true);
    document.querySelector('#jobs-chip').click();
    await vi.waitFor(() => expect(document.querySelector('#feedback-content h2')).not.toBeNull());
    expect(document.querySelector('#feedback-panel').hidden).toBe(false);

    document.querySelector('#btn-feedback').click();
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    document.querySelector('#tabs button[data-tab="save"]').click();
    jobs[0].status = 'done';
    jobs[0].result = { executed: true, output: '# Master review' };
    await vi.advanceTimersByTimeAsync(3100);
    expect(document.querySelector('#tab-save').classList.contains('active')).toBe(true);
    const picker = document.querySelector('#feedback-select');
    picker.value = jobs[1].id;
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('#feedback-content h2')?.textContent).toBe('Phrase review'));
  });

  it('reveals one master bullet at a time and collapses its actions with Escape', () => {
    const [first, second] = document.querySelectorAll('.master-source-bullet');
    const firstActions = [...first.querySelectorAll('[data-bullet-action]')];
    expect(firstActions.length).toBeGreaterThan(0);
    expect(firstActions.every(action => action.hidden)).toBe(true);
    first.querySelector('.bullet-more').click();
    expect(firstActions.every(action => !action.hidden)).toBe(true);
    expect(first.querySelector('.bullet-more').getAttribute('aria-expanded')).toBe('true');
    second.querySelector('.editable').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(firstActions.every(action => action.hidden)).toBe(true);
    expect(second.classList.contains('tools-open')).toBe(true);
    second.querySelector('.editable').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(second.classList.contains('tools-open')).toBe(false);
    expect(document.activeElement).toBe(second.querySelector('.bullet-more'));
    expect(requests.some(request => request.url === '/api/ai/feedback')).toBe(false);
  });

  it('requests complete-entry feedback from master and tailored entry headers', async () => {
    const master = [...document.querySelectorAll('.master-source-entry')]
      .find(node => node.textContent.includes('Built a pipeline'));
    master.querySelector('.entry-feedback').click();
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    expect(requests.filter(request => request.url === '/api/ai/feedback')[0].body)
      .toEqual({ entryId: 'exp_acme', background: true });
    expect(document.querySelector('#feedback-panel').hidden).toBe(false);

    const selector = document.querySelector('#resume-select');
    selector.value = 'newgrad';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.entry .entry-feedback')).not.toBeNull());
    const entry = [...document.querySelectorAll('.entry')].find(node => node.textContent.includes('Acme Co.'));
    expect(entry.querySelector('.entry-feedback').closest('[data-bullet-action]')).toBeNull();
    entry.querySelector('.entry-feedback').click();
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    expect(requests.filter(request => request.url === '/api/ai/feedback')[1].body)
      .toEqual({ entryId: 'exp_acme', background: true });
  });

  it('keeps tailored bullet choices hidden until requested and keeps actions open after cycling wording', async () => {
    const selector = document.querySelector('#resume-select');
    selector.value = 'newgrad';
    selector.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.bullet-disclosure .stepper')).not.toBeNull());
    const block = [...document.querySelectorAll('.bullet-disclosure')].find(node => node.dataset.toolsKey.endsWith('/b_pipeline'));
    expect(block.querySelector('.variant-row').hidden).toBe(true);
    expect(block.querySelector('.bullet-quick-actions').hidden).toBe(true);
    expect(block.querySelector('.toggle input').checked).toBe(true);
    block.querySelector('.bullet-more').click();
    const previousText = block.querySelector('.editable').textContent;
    block.querySelector('.stepper button:last-child').click();
    const updated = [...document.querySelectorAll('.bullet-disclosure')].find(node => node.dataset.toolsKey.endsWith('/b_pipeline'));
    expect(updated.querySelector('.editable').textContent).not.toBe(previousText);
    expect(updated.querySelector('.variant-row').hidden).toBe(false);
    expect(updated.querySelector('.bullet-more').getAttribute('aria-label')).toBe('Hide bullet actions');
    updated.querySelector('.bullet-more').click();
    expect(updated.querySelector('.variant-row').hidden).toBe(true);
    expect(updated.querySelector('.editable').textContent).not.toBe(previousText);
  });
});
