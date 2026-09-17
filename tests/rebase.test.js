import { describe, expect, it } from 'vitest';
import { rebase, same } from '../web/rebase.js';

/*
 * The editor saves an entry whole. Two edits close together are therefore two
 * copies of the same entry, each carrying the other's text as it was before —
 * and the later one wins outright. These are the shapes that actually occur
 * when that happens.
 */

const entry = () => ({
  id: 'exp_acme',
  kind: 'experience',
  title: 'Acme Co.',
  dates: '2023 — 2024',
  bullets: [
    {
      id: 'b_pipeline',
      default: 'v_base',
      variants: [
        { id: 'v_base', label: 'Base', text: 'Built a pipeline' },
        { id: 'v_kafka', label: 'Kafka', text: 'Built a Kafka pipeline' },
      ],
    },
    { id: 'b_oncall', default: 'v_1', variants: [{ id: 'v_1', label: 'Base', text: 'Ran the on-call rota' }] },
  ],
});

describe('same', () => {
  it('ignores keys that are only there holding undefined', () => {
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(same({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it('compares nested structures rather than references', () => {
    expect(same(entry(), entry())).toBe(true);
    const changed = entry();
    changed.bullets[0].variants[1].text = 'Something else';
    expect(same(entry(), changed)).toBe(false);
  });

  it('distinguishes arrays from objects with the same keys', () => {
    expect(same(['a'], { 0: 'a' })).toBe(false);
  });
});

describe('rebasing one edit onto another', () => {
  it('keeps both when they are in different fields', () => {
    const base = entry();
    const ours = { ...entry(), dates: '2023 — 2025' };
    const theirs = { ...entry(), title: 'Acme Corporation' };

    const merged = rebase(base, ours, theirs);
    expect(merged.dates).toBe('2023 — 2025');
    expect(merged.title).toBe('Acme Corporation');
  });

  /*
   * The exact loss this is for: the sentence typed a moment ago, and the date
   * fixed right after it. Sending the whole entry meant the date edit carried
   * the sentence's old text with it.
   */
  it('keeps a wording that landed while another field was being edited', () => {
    const base = entry();
    const theirs = entry();
    theirs.bullets[0].variants[0].text = 'Built a pipeline handling 2M events/day';

    const ours = { ...entry(), dates: '2023 — 2025' };

    const merged = rebase(base, ours, theirs);
    expect(merged.dates).toBe('2023 — 2025');
    expect(merged.bullets[0].variants[0].text).toBe('Built a pipeline handling 2M events/day');
  });

  it('keeps two edits to different phrasings of the same bullet', () => {
    const base = entry();
    const theirs = entry();
    theirs.bullets[0].variants[1].text = 'Built the Kafka ingest path';
    const ours = entry();
    ours.bullets[0].variants[0].text = 'Built the ingest path';

    const merged = rebase(base, ours, theirs);
    expect(merged.bullets[0].variants[0].text).toBe('Built the ingest path');
    expect(merged.bullets[0].variants[1].text).toBe('Built the Kafka ingest path');
  });

  it('gives the edit being made now the last word when both changed one thing', () => {
    const base = entry();
    const theirs = { ...entry(), title: 'Acme Corporation' };
    const ours = { ...entry(), title: 'Acme Co. (contract)' };
    expect(rebase(base, ours, theirs).title).toBe('Acme Co. (contract)');
  });

  it('keeps a bullet added by each of them', () => {
    const base = entry();
    const theirs = entry();
    theirs.bullets.push({ id: 'b_theirs', default: 'v_1', variants: [{ id: 'v_1', label: 'B', text: 'Theirs' }] });
    const ours = entry();
    ours.bullets.push({ id: 'b_ours', default: 'v_1', variants: [{ id: 'v_1', label: 'B', text: 'Ours' }] });

    const ids = rebase(base, ours, theirs).bullets.map((b) => b.id);
    expect(ids).toContain('b_theirs');
    expect(ids).toContain('b_ours');
    expect(ids).toContain('b_pipeline');
  });

  it('does not bring back a bullet the other edit deleted', () => {
    const base = entry();
    const theirs = entry();
    theirs.bullets = theirs.bullets.filter((b) => b.id !== 'b_oncall');
    const ours = { ...entry(), dates: '2023 — 2025' };

    expect(rebase(base, ours, theirs).bullets.map((b) => b.id)).toEqual(['b_pipeline']);
  });

  it('does not bring back a bullet this edit deleted', () => {
    const base = entry();
    const ours = entry();
    ours.bullets = ours.bullets.filter((b) => b.id !== 'b_oncall');
    const theirs = { ...entry(), title: 'Acme Corporation' };

    const merged = rebase(base, ours, theirs);
    expect(merged.bullets.map((b) => b.id)).toEqual(['b_pipeline']);
    expect(merged.title).toBe('Acme Corporation');
  });

  /*
   * Deleting something while it is being edited is a genuine disagreement, and
   * the text is the thing that cannot be recovered from the screen. Keep it.
   */
  it('keeps a bullet the other edit deleted while this one was rewriting it', () => {
    const base = entry();
    const theirs = entry();
    theirs.bullets = theirs.bullets.filter((b) => b.id !== 'b_oncall');
    const ours = entry();
    ours.bullets[1].variants[0].text = 'Ran the on-call rota for twelve services';

    const merged = rebase(base, ours, theirs);
    const kept = merged.bullets.find((b) => b.id === 'b_oncall');
    expect(kept?.variants[0].text).toBe('Ran the on-call rota for twelve services');
  });

  it('leaves the result alone when only one side moved', () => {
    const base = entry();
    const theirs = { ...entry(), title: 'Acme Corporation' };
    expect(rebase(base, entry(), theirs).title).toBe('Acme Corporation');
    expect(rebase(base, theirs, entry()).title).toBe('Acme Corporation');
  });

  it('handles a field that became a set of alternates on one side', () => {
    const base = { ...entry(), location: 'Boston' };
    const theirs = { ...base, location: { default: 'v_1', variants: [{ id: 'v_1', label: 'Base', text: 'Boston' }] } };
    const ours = { ...base, dates: '2023 — 2025' };

    const merged = rebase(base, ours, theirs);
    expect(merged.location.variants[0].text).toBe('Boston');
    expect(merged.dates).toBe('2023 — 2025');
  });

  it('drops a key both of them dropped, rather than reviving it as undefined', () => {
    const base = { ...entry(), note: 'temporary' };
    const ours = entry();
    const theirs = entry();
    expect('note' in rebase(base, ours, theirs)).toBe(false);
  });
});
