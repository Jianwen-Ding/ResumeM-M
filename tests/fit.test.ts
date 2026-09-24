import { describe, expect, it } from 'vitest';
import { fitResumes, recommend } from '../src/jobs/fit.js';
import type { Entry, StoreData } from '../src/model/types.js';

/**
 * Which resume to start from, before anything is tailored.
 *
 * The scoring is a reading aid for a list, and every rule below exists to keep
 * it from claiming more than that: a mark on the best of a bad field, or on
 * one of two equals, reads as a judgement and is not one.
 */

const bullet = (id: string, text: string) => ({ id, variants: [{ id: `${id}_v`, text }], default: `${id}_v` });

const entry = (id: string, title: string, bullets: [string, string][]): Entry =>
  ({
    id,
    kind: 'experience',
    title,
    bullets: bullets.map(([bid, text]) => bullet(bid, text)),
  }) as unknown as Entry;

/** A store of three resumes over three entries, each about something else. */
function store(): StoreData {
  return {
    profile: { name: 'Someone', email: 'a@b.c' },
    entries: [
      entry('e_kafka', 'Streaming Co.', [['b_kafka', 'Ran Kafka and Kubernetes in Go across three regions.']]),
      entry('e_web', 'Web Co.', [['b_web', 'Built React and TypeScript interfaces for a design system.']]),
      entry('e_lab', 'Research Lab', [['b_lab', 'Wrote MATLAB for spectroscopy data.']]),
    ],
    skillGroups: [],
    resumes: [
      { id: 'platform', label: 'Platform', sections: [{ kind: 'experience', entries: ['e_kafka'] }] },
      { id: 'frontend', label: 'Frontend', sections: [{ kind: 'experience', entries: ['e_web'] }] },
      { id: 'lab', label: 'Lab', sections: [{ kind: 'experience', entries: ['e_lab'] }] },
    ],
    applications: [],
    answers: [],
    letters: [],
    config: {},
  } as unknown as StoreData;
}

const KAFKA_POSTING = ['Kafka', 'Kubernetes', 'Go', 'distributed systems'];

describe('how well each resume already suits a posting', () => {
  it('counts the posting’s own words, in the resume as it would print', () => {
    const fits = fitResumes(store(), KAFKA_POSTING);
    const by = Object.fromEntries(fits.map((f) => [f.id, f.hits]));
    expect(by.platform).toBe(3);
    expect(by.frontend).toBe(0);
    expect(by.lab).toBe(0);
  });

  it('says which words, so the card can explain the mark', () => {
    const platform = fitResumes(store(), KAFKA_POSTING).find((f) => f.id === 'platform');
    expect(platform?.because).toEqual(expect.arrayContaining(['Kafka', 'Kubernetes', 'Go']));
  });

  /*
   * `includes` over an unbroken string matched "Rust" inside "trust" and
   * "Java" across "ninja validation". A ranking built on that would order the
   * list by accident, and the mark would point at a resume for a reason that
   * is not there.
   */
  it('does not find a word inside another word', () => {
    const data = store();
    (data.resumes as { id: string; label: string; sections: unknown[] }[]).push({
      id: 'decoy',
      label: 'Decoy',
      sections: [{ kind: 'experience', entries: ['e_decoy'] }],
    });
    data.entries.push(entry('e_decoy', 'Decoy Co.', [['b_decoy', 'Built trust with ninja validation of Javanese ratios.']]));
    const decoy = fitResumes(data, ['Rust', 'Java', 'iOS']).find((f) => f.id === 'decoy');
    expect(decoy?.hits).toBe(0);
  });

  /*
   * A posting that says "Kubernetes" four times is not asking for it four
   * times. Without this a resume matching one repeated word outranks one
   * matching three distinct ones.
   */
  it('counts a repeated word once', () => {
    const fits = fitResumes(store(), ['Kafka', 'Kafka', 'Kafka', 'Kafka']);
    expect(fits.find((f) => f.id === 'platform')?.hits).toBe(1);
  });

  it('scores a resume it cannot resolve as nothing rather than throwing', () => {
    const data = store();
    (data.resumes as { id: string; label: string; extends?: string }[]).push({
      id: 'broken',
      label: 'Broken',
      extends: 'a-resume-that-is-gone',
    });
    const fits = fitResumes(data, KAFKA_POSTING);
    expect(fits.find((f) => f.id === 'broken')?.hits).toBe(0);
    // And the rest are still scored: one bad row must not take the list down.
    expect(fits.find((f) => f.id === 'platform')?.hits).toBe(3);
  });
});

describe('which of them is worth marking', () => {
  it('marks the one that is clearly ahead', () => {
    expect([...recommend(fitResumes(store(), KAFKA_POSTING))]).toEqual(['platform']);
  });

  /*
   * The best of a bad field is not a recommendation. Marking it reads as
   * "this one suits the posting" when what happened is that it suited it
   * least badly, and the applicant acts on the mark rather than on the two
   * seconds of reading it replaced.
   */
  it('marks nothing when nothing actually suits the posting', () => {
    expect([...recommend(fitResumes(store(), ['COBOL', 'mainframe', 'JCL', 'CICS']))]).toEqual([]);
  });

  /*
   * The case the floor is actually for, and the one the test above does not
   * reach: a long posting where the best resume is clearly ahead of the rest
   * and still barely touches it. Three of twenty is a gap of three over a
   * median of nothing — enough for the flatness guard — and it is still not
   * a resume that suits this job.
   */
  it('marks nothing when the leader is ahead but barely touches the posting', () => {
    const thin = [
      { id: 'a', hits: 3, because: [], share: 3 / 20 },
      { id: 'b', hits: 0, because: [], share: 0 },
      { id: 'c', hits: 0, because: [], share: 0 },
    ];
    expect([...recommend(thin)]).toEqual([]);
  });

  it('marks nothing when the best is barely ahead of the rest', () => {
    const flat = [
      { id: 'a', hits: 5, because: [], share: 0.5 },
      { id: 'b', hits: 4, because: [], share: 0.4 },
      { id: 'c', hits: 4, because: [], share: 0.4 },
    ];
    expect([...recommend(flat)]).toEqual([]);
  });

  /*
   * A tie is not a ranking either. Two resumes level at the top are genuinely
   * interchangeable for this posting, and picking one of them would be
   * inventing a difference the numbers do not have.
   */
  it('marks both of two equals rather than choosing between them', () => {
    const tied = [
      { id: 'a', hits: 6, because: [], share: 0.6 },
      { id: 'b', hits: 6, because: [], share: 0.6 },
      { id: 'c', hits: 1, because: [], share: 0.1 },
      { id: 'd', hits: 0, because: [], share: 0 },
      { id: 'e', hits: 0, because: [], share: 0 },
      { id: 'f', hits: 0, because: [], share: 0 },
    ];
    expect([...recommend(tied)].sort()).toEqual(['a', 'b']);
  });

  /*
   * And never some of them. Taking the first three of ten equals is choosing
   * between equals by the order they were written — the same invented
   * difference, three times over — so where the mark cannot go on every one
   * of them it goes on none.
   */
  it('never marks more than three, and marks none of ten equals rather than three of them', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      hits: i < 10 ? 8 : 0,
      because: [],
      share: i < 10 ? 0.8 : 0,
    }));
    expect(recommend(many).size).toBe(0);
    // Three level at the top still fit, and all three are marked.
    const three = many.map((f, i) => (i < 10 && i >= 3 ? { ...f, hits: 1, share: 0.1 } : f));
    expect([...recommend(three)].sort()).toEqual(['r0', 'r1', 'r2']);
  });

  /*
   * The reported shape: a store of five, where only one may be marked, and
   * two resumes built for postings level at the top. The star went to the
   * first of the two in the order they were written.
   */
  it('marks neither of two equals when there is room to mark only one', () => {
    const five = [
      { id: 'helios', hits: 9, because: [], share: 0.5 },
      { id: 'other', hits: 9, because: [], share: 0.5 },
      { id: 'base', hits: 7, because: [], share: 0.4 },
      { id: 'intern', hits: 6, because: [], share: 0.3 },
      { id: 'newgrad', hits: 6, because: [], share: 0.3 },
    ];
    expect([...recommend(five)]).toEqual([]);
    // And the one clearly ahead in the same store is still marked.
    expect([...recommend(five.map((f) => (f.id === 'other' ? { ...f, hits: 5 } : f)))]).toEqual(['helios']);
  });

  it('marks nothing at all for an empty store', () => {
    expect([...recommend([])]).toEqual([]);
  });
});
