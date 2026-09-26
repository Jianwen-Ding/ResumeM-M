// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempStore } from './helpers.ts';

vi.mock('../web/preview.js', () => ({ createPreview: () => ({ show: async () => {}, clear: () => {} }) }));
vi.mock('../web/assets.js', () => ({
  setupAssets: () => ({
    init: async () => {
      for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
      return { current: '/test-save' };
    },
    load: async () => {},
  }),
}));

/* See boot-wiring.test.js: every listener a boot adds comes off after it. */
const registered = [];
for (const on of [window, document]) {
  const real = on.addEventListener.bind(on);
  on.addEventListener = (type, fn, opts) => {
    registered.push([on, type, fn, opts]);
    real(type, fn, opts);
  };
}

afterEach(() => {
  for (const [on, type, fn, opts] of registered.splice(0)) on.removeEventListener(type, fn, opts);
  delete document.visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/*
 * An edit made just before the page goes away.
 *
 * The editor walk unfolded an entry and reloaded, and with the page slowed the
 * entry came back folded. The page does write on the way out: hiding it runs
 * `flushEdits`, which starts the resume's save at once. But that save was a
 * plain `fetch`, and a browser cancels a plain request when its page unloads.
 * In Chromium, with the API held 600ms, the PUT was started and then failed
 * with net::ERR_ABORTED, three reloads of three. The commit after it had
 * `keepalive` and the save it was meant to commit did not.
 *
 * Here "the page has gone" is the first timer after the event: once a page is
 * unloading nothing on a timer runs, so a save has to have been asked for
 * before then, and asked for in the one form that outlives the page.
 */
describe('an edit made just before leaving the page', () => {
  let requests;
  let pageGone;
  // A promise the next resume PUT's reply waits on, to hold a save in flight.
  let holdPut;
  // Other requests held the same way: the next one each `match` accepts.
  let holds;
  let drafts;
  // The store's auto-commit setting, as the page is booted with it.
  let autoCommit = false;
  // How long after a reply the stand-in browser gives keepalive allowance back.
  let allowanceLag = 0;

  const fold = (id) => document.querySelector(`#editor .entry[data-drag-id="${id}"] .fold`);
  const resumePuts = () => requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/resumes/'));

  /** Hold the next request `match` accepts until the returned function is called. */
  const hold = (match) => {
    let release;
    holds.push({ match, held: new Promise((go, fail) => (release = (err) => (err ? fail(err) : go()))) });
    // Given an error, the request fails with it instead.
    return (err) => release(err);
  };

  /** Hide the page, and count it as gone at the first timer after that. */
  const leave = async () => {
    setTimeout(() => {
      pageGone = true;
    }, 0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((go) => setTimeout(go, 20));
  };

  beforeEach(async () => {
    vi.resetModules();
    document.documentElement.innerHTML = fs.readFileSync('web/index.html', 'utf8');
    location.hash = '#resumes';
    const fixture = makeTempStore();
    const data = fixture.store.load();
    fixture.cleanup();
    requests = [];
    pageGone = false;
    holdPut = null;
    holds = [];
    allowanceLag = 0;
    drafts = {
      'streamly-intern': {
        id: 'streamly-intern',
        company: 'Streamly',
        role: 'Data Platform Intern',
        resumeId: 'intern',
        coverLetter: { required: true, body: '', edited: false },
        questions: [],
        notes: '',
      },
    };

    /*
     * The browser's keepalive allowance, as Chromium keeps it: 64KB of bodies
     * in flight at once, and a request past it refused before it is sent.
     * See `fetchKeptAlive` in web/app.js.
     */
    let keptAlive = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      const size = options.keepalive ? new Blob([options.body ?? '']).size : 0;
      const refused = keptAlive + size > 64 * 1024;
      requests.push({ url, method, body, keepalive: options.keepalive === true, afterPageGone: pageGone, refused });
      if (refused) throw new TypeError('Failed to fetch');
      keptAlive += size;
      try {
        return await answer(url, method, body);
      } finally {
        // Chromium gives the allowance back a little after the reply.
        if (allowanceLag) setTimeout(() => (keptAlive -= size), allowanceLag);
        else keptAlive -= size;
      }
    }));
    const answer = async (url, method, body) => {
      const at = holds.findIndex((h) => h.match(url, method));
      if (at >= 0) await holds.splice(at, 1)[0].held;
      let result = {};
      if (url === '/api/store') result = { ...data, config: { ...data.config, git: { ...data.config.git, autoCommit } } };
      else if (url === '/api/ai/jobs') result = { jobs: [] };
      else if (url === '/api/render') result = { pages: 1, fits: true, adjustments: [], pdfUrl: '/pdf/x.pdf' };
      else if (url === '/api/workspace') result = { drafts: Object.values(drafts) };
      else if (url.startsWith('/api/workspace/') && method === 'PUT') {
        const id = decodeURIComponent(url.split('?')[0].split('/').pop());
        drafts[id] = body;
        result = body;
      } else if (url.startsWith('/api/workspace/')) result = drafts[decodeURIComponent(url.split('?')[0].split('/').pop())];
      else if (url.startsWith('/api/entries/') && method === 'PUT') {
        const i = data.entries.findIndex((e) => e.id === body.id);
        if (i >= 0) data.entries[i] = body;
        result = body;
      } else if (url.startsWith('/api/store/save')) result = { saved: true, files: [] };
      else if (url.startsWith('/api/profile') && method === 'PUT') {
        data.profile = body;
        result = body;
      }
      else if (url.startsWith('/api/resumes/') && method === 'PUT') {
        if (holdPut) {
          const held = holdPut;
          holdPut = null;
          await held;
        }
        const i = data.resumes.findIndex((r) => r.id === body.id);
        if (i >= 0) data.resumes[i] = body;
        result = body;
      }
      return { ok: true, json: async () => structuredClone(result) };
    };

    await import('../web/app.js');
    await vi.waitFor(() => expect(document.querySelector('#editor .entry .fold')).not.toBeNull());
  });

  it('asks for the save before the page has gone, in a form that outlives it', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });

    // Unfolded, and the page reloaded well inside the auto-save's wait.
    fold(id).click();
    expect(document.querySelector(`#editor .entry[data-drag-id="${id}"].folded`)).toBeNull();
    const before = resumePuts().length;
    setTimeout(() => {
      pageGone = true;
    }, 0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((go) => setTimeout(go, 20));

    const leaving = resumePuts().slice(before);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.collapsed).not.toContain(id);
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
  });

  /*
   * And the save the wait itself starts. It can still be out when the page
   * goes, and `flushEdits` then has nothing to add: the edit is no longer
   * unsaved, it is in flight. Cancelled with the page, it was lost the same
   * way.
   */
  it('lets the ordinary auto-save outlive the page too', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });
    expect(resumePuts().at(-1).keepalive).toBe(true);
  });

  /*
   * An edit made while the save before it is still out, and then the page
   * left.
   *
   * Saves of one resume go one at a time, so that the server writes them in
   * the order they were made (see `autoSave`). But leaving the page puts the
   * latest edit into that queue too, behind a save whose reply only comes
   * after the page has gone, and nothing on a gone page runs. The edit was
   * never sent. On the way out it is sent at once instead, and it carries
   * where it stands among this page's saves, so that the server can drop the
   * earlier one if that arrives later.
   */
  it('sends the latest edit on the way out, not behind a save still in flight', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    let release;
    holdPut = new Promise((go) => {
      release = go;
    });
    fold(id).click();
    await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });
    const inFlight = resumePuts().at(-1);

    // Unfolded while the fold's save is still out, and the page then left.
    fold(id).click();
    const before = resumePuts().length;
    setTimeout(() => {
      pageGone = true;
    }, 0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((go) => setTimeout(go, 20));
    // The fold's reply, which comes back after the page has gone.
    release();
    await new Promise((go) => setTimeout(go, 20));

    const leaving = resumePuts().slice(before);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.collapsed).not.toContain(id);
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
    // In order after the save still out, for the server to keep them so.
    const order = (put) => new URL(put.url, 'http://x').searchParams.get('order');
    expect(order(inFlight)).toMatch(/^[\w-]+:\d+$/);
    const [page, first] = order(inFlight).split(':');
    const [samePage, second] = order(leaving[0]).split(':');
    expect(samePage).toBe(page);
    expect(Number(second)).toBeGreaterThan(Number(first));
  });

  /*
   * The other writes `flushEdits` covers, when one of them is still out.
   *
   * On the way out it went through them in turn, waiting on each: the
   * Workspace's draft save, then every inline save, and only then the
   * resume. A draft save still in flight when the page went held the resume's
   * edit behind a reply that comes after the page has gone, so it was never
   * sent. Likewise an inline edit of a line whose save was still out.
   */
  it('does not hold the resume behind a Workspace save still in flight', async () => {
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(document.querySelector('#draft-editor .letter')).not.toBeNull());
    const release = hold((url, method) => method === 'PUT' && url.startsWith('/api/workspace/'));
    const letter = document.querySelector('#draft-editor .letter');
    letter.value = 'Dear Streamly,';
    letter.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(
      () => expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/workspace/'))).toBe(true),
      { timeout: 3000 },
    );

    // Back in the builder with the letter's save still out, an entry folded,
    // and the page left inside the auto-save's wait.
    document.querySelector('button[data-tab="resumes"]').click();
    await vi.waitFor(() => expect(document.querySelector('#editor .entry .fold')).not.toBeNull());
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    const before = resumePuts().length;
    await leave();
    release();
    await new Promise((go) => setTimeout(go, 20));

    const leaving = resumePuts().slice(before);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.collapsed).toContain(id);
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
  });

  it('does not hold the resume behind an inline save still in flight', async () => {
    const release = hold((url, method) => method === 'PUT' && url.startsWith('/api/entries/'));
    const line = document.querySelector('#editor .bullet .editable');
    line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    line.textContent = `${line.textContent} at p95`;
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/entries/'))).toBe(true),
    );
    const entryPut = requests.find((r) => r.method === 'PUT' && r.url.startsWith('/api/entries/'));

    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    const before = resumePuts().length;
    await leave();
    release();
    await new Promise((go) => setTimeout(go, 20));

    const leaving = resumePuts().slice(before);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.collapsed).toContain(id);
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
    // And the line's own save, which a plain request would lose with the page.
    expect(entryPut.keepalive).toBe(true);
  });

  /*
   * The commit that follows the save on the way out.
   *
   * It was sent after the save's reply, which on the way out comes after the
   * page has gone, so it never was. The edit reached the disk and not the
   * version history, until whatever next happened to commit. It goes now,
   * straight after the save, and says which of this page's writes it has to
   * follow: it can reach the server before the save does.
   */
  /*
   * The browser's 64KB keepalive allowance.
   *
   * A draft carries its posting, and a posting can be 40,000 characters, so a
   * draft's save can be past the allowance on its own, and leaving now sends
   * the draft and the resume together. A keepalive request that does not fit
   * is refused before it is sent, and the draft's save always had the flag:
   * a draft that large could never be saved at all.
   */
  const openDraft = async () => {
    for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
    document.querySelector('button[data-tab="workspace"]').click();
    await vi.waitFor(() => expect(document.querySelector('#draft-editor .letter')).not.toBeNull());
  };
  const typeLetter = (text) => {
    const letter = document.querySelector('#draft-editor .letter');
    letter.value = text;
    letter.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const draftPuts = () => requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/api/workspace/'));

  it('saves a draft too large for the keepalive allowance', async () => {
    drafts['streamly-intern'].jobDescription = 'Kafka. '.repeat(10_000);
    await openDraft();
    typeLetter('Dear Streamly,');
    await vi.waitFor(() => expect(drafts['streamly-intern'].coverLetter.body).toBe('Dear Streamly,'), { timeout: 3000 });
    expect(draftPuts().some((r) => !r.refused)).toBe(true);
    expect(document.querySelector('#draft-save-state').textContent).toBe('All changes saved');
  });

  /*
   * A draft that fits the allowance on its own, but not beside the resume.
   * Whichever goes first has it, and the resume goes first: it is the small
   * one, and the draft can still go as a plain request.
   */
  it('leaves with the resume and a large draft both sent, the resume kept alive', async () => {
    const draft = drafts['streamly-intern'];
    const typed = { ...draft, coverLetter: { ...draft.coverLetter, body: 'Dear Streamly,', edited: true } };
    draft.jobDescription = 'k'.repeat(64 * 1024 - 300 - JSON.stringify(typed).length);
    await openDraft();
    typeLetter('Dear Streamly,');
    document.querySelector('button[data-tab="resumes"]').click();
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    const resumesBefore = resumePuts().length;
    expect(draftPuts().length).toBe(0);
    await leave();

    const [save] = resumePuts().slice(resumesBefore);
    expect(save.afterPageGone).toBe(false);
    expect(save.keepalive).toBe(true);
    expect(save.refused).toBe(false);
    const sent = draftPuts().filter((r) => !r.refused);
    expect(sent.length).toBe(1);
    expect(sent[0].afterPageGone).toBe(false);
    expect(sent[0].body.coverLetter.body).toBe('Dear Streamly,');
    // The case it is meant to be: each fits alone, the two together do not.
    const size = (body) => new Blob([JSON.stringify(body)]).size;
    expect(size(sent[0].body)).toBeLessThanOrEqual(64 * 1024);
    expect(size(sent[0].body) + size(save.body)).toBeGreaterThan(64 * 1024);
  });

  /*
   * And one the browser refuses though the count here said it would fit:
   * the browser gives the allowance back a little after the reply, not with
   * it. Sent again, plainly.
   */
  it('sends again, plainly, a write refused for allowance not given back yet', async () => {
    allowanceLag = 5000;
    drafts['streamly-intern'].jobDescription = 'k'.repeat(40_000);
    await openDraft();
    typeLetter('Dear Streamly,');
    await vi.waitFor(() => expect(drafts['streamly-intern'].coverLetter.body).toBe('Dear Streamly,'), { timeout: 3000 });
    typeLetter('Dear Streamly, hello.');
    await vi.waitFor(() => expect(drafts['streamly-intern'].coverLetter.body).toBe('Dear Streamly, hello.'), { timeout: 3000 });
    expect(draftPuts().some((r) => r.refused)).toBe(true);
    expect(document.querySelector('#draft-save-state').textContent).toBe('All changes saved');
  });

  /*
   * Leaving by unloading, which is a reload or a closed tab rather than a
   * hidden one. Chromium then rejects every request the page still has out,
   * keepalive ones too, though those carry on to the server. A rejected
   * keepalive write was sent again as a plain one, so every write on the way
   * out went twice; and so it is not sent again there, and a write that does
   * not fit beside the rest has to be caught before it is sent.
   */
  const unload = async () => {
    window.dispatchEvent(new Event('pagehide'));
    await leave();
  };

  it('does not send a write twice when the page unloading cuts it short', async () => {
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    const release = hold((url, method) => method === 'PUT' && url.startsWith('/api/resumes/'));
    const before = resumePuts().length;
    await unload();
    release(new TypeError('Failed to fetch'));
    await new Promise((go) => setTimeout(go, 20));
    expect(resumePuts().slice(before).length).toBe(1);
  });

  it('sends a draft that does not fit beside the resume at once, when unloading', async () => {
    const draft = drafts['streamly-intern'];
    const typed = { ...draft, coverLetter: { ...draft.coverLetter, body: 'Dear Streamly,', edited: true } };
    draft.jobDescription = 'k'.repeat(64 * 1024 - 300 - JSON.stringify(typed).length);
    await openDraft();
    typeLetter('Dear Streamly,');
    document.querySelector('button[data-tab="resumes"]').click();
    const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
    fold(id).click();
    await unload();

    const sent = draftPuts();
    expect(sent.length).toBe(1);
    expect(sent[0].refused).toBe(false);
    expect(sent[0].afterPageGone).toBe(false);
    expect(resumePuts().at(-1).keepalive).toBe(true);
  });

  /*
   * A draft typed on while its last save is still out, and then the page left.
   *
   * A draft's saves go one at a time now, so the server writes them in the
   * order they were made (see `saveDraftNow`). On the way out that queue is
   * skipped, as the resume's is: the save ahead replies after the page has
   * gone, and the latest letter behind it would never be sent. It goes at once,
   * ordered after the one still out, for the server to keep them so.
   */
  it('sends the latest draft on the way out, not behind a save of it still in flight', async () => {
    await openDraft();
    const release = hold((url, method) => method === 'PUT' && url.startsWith('/api/workspace/'));
    typeLetter('Dear Streamly,');
    await vi.waitFor(() => expect(draftPuts().length).toBe(1), { timeout: 3000 });
    const [inFlight] = draftPuts();
    typeLetter('Dear Streamly, I build data pipelines.');
    await leave();
    release();
    await new Promise((go) => setTimeout(go, 20));

    const leaving = draftPuts().slice(1);
    expect(leaving.length).toBe(1);
    expect(leaving[0].body.coverLetter.body).toBe('Dear Streamly, I build data pipelines.');
    expect(leaving[0].afterPageGone).toBe(false);
    expect(leaving[0].keepalive).toBe(true);
    const order = (put) => new URL(put.url, 'http://x').searchParams.get('order');
    const [page, first] = order(inFlight).split(':');
    const [samePage, second] = order(leaving[0]).split(':');
    expect(samePage).toBe(page);
    expect(Number(second)).toBeGreaterThan(Number(first));
  });

  /*
   * And the two replies can come back either way round. The page was only
   * hidden and is back: the newer save landed, and the older one failing
   * afterwards does not mark the letter unsaved, since what it carried is on
   * the server.
   */
  it('marks nothing unsaved when the older draft save fails after the newer landed', async () => {
    await openDraft();
    const releaseFirst = hold((url, method) => method === 'PUT' && url.startsWith('/api/workspace/'));
    typeLetter('Dear Streamly,');
    await vi.waitFor(() => expect(draftPuts().length).toBe(1), { timeout: 3000 });
    typeLetter('Dear Streamly, I build data pipelines.');
    await leave();
    expect(drafts['streamly-intern'].coverLetter.body).toBe('Dear Streamly, I build data pipelines.');
    // The first fails, and so does the plain retry `fetchKeptAlive` sends.
    const releaseRetry = hold((url, method) => method === 'PUT' && url.startsWith('/api/workspace/'));
    releaseFirst(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(draftPuts().length).toBe(3));
    releaseRetry(new TypeError('Failed to fetch'));
    await new Promise((go) => setTimeout(go, 20));
    expect(document.querySelector('#draft-save-state').textContent).toBe('All changes saved');
  });

  describe('with auto-commit on', () => {
    beforeAll(() => {
      autoCommit = true;
    });
    afterAll(() => {
      autoCommit = false;
    });

    const commits = () => requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/store/save'));
    const orderOf = (put) => new URL(put.url, 'http://x').searchParams.get('order');

    it('asks for the commit before the page has gone, naming the save it follows', async () => {
      const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
      fold(id).click();
      const before = resumePuts().length;
      // Its reply, like any, takes a round trip: it comes after the page has gone.
      let release;
      holdPut = new Promise((go) => {
        release = go;
      });
      await leave();
      release();
      await new Promise((go) => setTimeout(go, 20));

      const [save] = resumePuts().slice(before);
      expect(save.afterPageGone).toBe(false);
      const sent = commits();
      expect(sent.length).toBe(1);
      expect(sent[0].afterPageGone).toBe(false);
      expect(sent[0].keepalive).toBe(true);
      expect(requests.indexOf(sent[0])).toBeGreaterThan(requests.indexOf(save));
      const [page, n] = orderOf(save).split(':');
      const asked = new URL(sent[0].url, 'http://x').searchParams;
      expect(asked.get('page')).toBe(page);
      expect(asked.get('after').split(',')).toContain(n);
    });

    // Nothing left unsaved, but the save that carries the last edit still out.
    it('names a save still in flight, when that is the one to commit', async () => {
      const id = document.querySelector('#editor .entry:has(.fold)').dataset.dragId;
      let release;
      holdPut = new Promise((go) => {
        release = go;
      });
      fold(id).click();
      await vi.waitFor(() => expect(resumePuts().at(-1)?.body.collapsed).toContain(id), { timeout: 3000 });
      const inFlight = resumePuts().at(-1);
      await leave();
      release();
      await new Promise((go) => setTimeout(go, 20));

      const sent = commits();
      expect(sent.length).toBe(1);
      expect(sent[0].afterPageGone).toBe(false);
      expect(sent[0].keepalive).toBe(true);
      const [page, n] = orderOf(inFlight).split(':');
      const asked = new URL(sent[0].url, 'http://x').searchParams;
      expect(asked.get('page')).toBe(page);
      expect(asked.get('after').split(',')).toEqual([n]);
    });

    /*
     * An inline edit of the profile is left for the commit too, like the
     * resume's saves, and can be the one still out. It takes its place in the
     * same count, so the commit can name it.
     */
    it('names an inline save of the profile still in flight', async () => {
      const release = hold((url, method) => method === 'PUT' && url.startsWith('/api/profile'));
      const line = document.querySelector('#editor .profile-grid .meta-value.editable');
      line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      line.textContent = 'someone@example.org';
      line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() =>
        expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/profile'))).toBe(true),
      );
      const profilePut = requests.find((r) => r.method === 'PUT' && r.url.startsWith('/api/profile'));
      expect(profilePut.keepalive).toBe(true);
      await leave();
      release();
      await new Promise((go) => setTimeout(go, 20));

      const sent = commits();
      expect(sent.length).toBe(1);
      expect(sent[0].afterPageGone).toBe(false);
      const [page, n] = orderOf(profilePut).split(':');
      const asked = new URL(sent[0].url, 'http://x').searchParams;
      expect(asked.get('page')).toBe(page);
      expect(asked.get('after').split(',')).toEqual([n]);
    });

    /*
     * A draft's save carries an order too, among the draft's own saves, but
     * it commits itself. The commit does not wait on it: a large draft sent
     * plainly and cut short by the unload would hold it the server's whole
     * five seconds, for nothing it covers.
     */
    it('does not name a draft save, which commits itself', async () => {
      await openDraft();
      const release = hold((url, method) => method === 'PUT' && url.startsWith('/api/workspace/'));
      typeLetter('Dear Streamly,');
      await leave();
      release();
      await new Promise((go) => setTimeout(go, 20));

      const [put] = draftPuts();
      expect(orderOf(put)).toMatch(/^[\w-]+:\d+$/);
      const sent = commits();
      expect(sent.length).toBe(1);
      expect(sent[0].afterPageGone).toBe(false);
      expect(new URL(sent[0].url, 'http://x').searchParams.get('after')).toBeNull();
    });
  });
});
