import { describe, expect, it } from 'vitest';
import { applyInclusion, sanitizeAiPlan, sanitizeSuggestions } from '../src/jobs/aiPlan.js';
import { resolveResume } from '../src/model/resolve.js';
import type { StoreData } from '../src/model/types.js';
import {
  SAMPLE_BASE,
  SAMPLE_EDUCATION,
  SAMPLE_EXPERIENCE,
  SAMPLE_PROJECT,
  SAMPLE_SKILLS,
  makeTempStore,
} from './helpers.js';

const data = (): StoreData => {
  const t = makeTempStore();
  try {
    return t.store.load();
  } finally {
    t.cleanup();
  }
};

describe('what the AI is allowed to decide', () => {
  it('accepts a real phrasing chosen for a real bullet', () => {
    const plan = sanitizeAiPlan({ choices: { b_pipeline: 'v_kafka' } }, data());
    expect(plan.choices).toEqual({ b_pipeline: 'v_kafka' });
    expect(plan.rejected).toEqual([]);
  });

  it('accepts a real phrasing chosen for a field', () => {
    const plan = sanitizeAiPlan({ choices: { 'edu_neu.dates': 'v_dec2026' } }, data());
    expect(plan.choices).toEqual({ 'edu_neu.dates': 'v_dec2026' });
  });

  it('refuses a variant id that does not exist', () => {
    const plan = sanitizeAiPlan({ choices: { b_pipeline: 'v_invented' } }, data());
    expect(plan.choices).toEqual({});
    expect(plan.rejected[0]).toContain('not one of its phrasings');
  });

  it('refuses a variant borrowed from a different bullet', () => {
    // v_dec2026 is real, but it belongs to edu_neu.dates, not to this bullet.
    const plan = sanitizeAiPlan({ choices: { b_pipeline: 'v_dec2026' } }, data());
    expect(plan.choices).toEqual({});
  });

  it('refuses a bullet that does not exist', () => {
    const plan = sanitizeAiPlan({ choices: { b_invented: 'v_base' } }, data());
    expect(plan.choices).toEqual({});
    expect(plan.rejected[0]).toContain('no such bullet');
  });

  /** The point of the whole module. */
  it('gives it no way to write text into a resume', () => {
    const plan = sanitizeAiPlan(
      {
        choices: { b_pipeline: 'v_kafka' },
        // Everything below is the model trying to author the resume.
        bullets: { b_pipeline: 'Invented a new claim about myself' },
        text: 'Senior Staff Principal Engineer',
        entries: [{ id: 'exp_new', title: 'A job I did not have' }],
        profile: { name: 'Someone Else' },
      },
      data(),
    );
    expect(plan).toEqual({
      choices: { b_pipeline: 'v_kafka' },
      skills: {},
      enable: [],
      disable: [],
      order: {},
      entryOrder: {},
      rejected: [],
    });
  });

  it('keeps only skills that exist, in the group they belong to', () => {
    const plan = sanitizeAiPlan({ skills: { sk_lang: ['s_go', 's_invented'], sk_nope: ['x'] } }, data());
    expect(plan.skills).toEqual({ sk_lang: ['s_go'] });
    expect(plan.rejected.join(' ')).toContain('sk_nope');
  });

  it('accepts entries and bullets to show or hide, and rejects unknown ids', () => {
    const plan = sanitizeAiPlan({ enable: ['proj_thing'], disable: ['b_testing', 'nonsense'] }, data());
    expect(plan.enable).toEqual(['proj_thing']);
    expect(plan.disable).toEqual(['b_testing']);
    expect(plan.rejected[0]).toContain('no such entry or bullet');
  });

  /*
   * Retired is not a way back in. The tool path never offers an archived line
   * or entry; a reply in JSON could name one, the plan carried it as shown,
   * and the resolver then left it off with a warning — a change the card
   * reported that the document did not make.
   */
  it('refuses to show what has been archived', () => {
    const d = data();
    d.entries = d.entries.map((e) =>
      e.id === 'proj_thing'
        ? { ...e, archived: true }
        : e.id === 'exp_acme'
          ? { ...e, bullets: e.bullets!.map((b) => (b.id === 'b_testing' ? { ...b, archived: true } : b)) }
          : e,
    );
    const plan = sanitizeAiPlan({ enable: ['proj_thing', 'b_testing'], disable: ['b_testing'] }, d);
    expect(plan.enable).toEqual([]);
    expect(plan.rejected.filter((r) => r.includes('archived'))).toHaveLength(2);
    // Hiding it is harmless, and says what was asked.
    expect(plan.disable).toEqual(['b_testing']);
  });

  it('survives a reply that is not an object at all', () => {
    for (const junk of [null, undefined, 'sorry, I cannot help', 42, []]) {
      expect(sanitizeAiPlan(junk, data()).choices).toEqual({});
    }
  });
});

describe('showing and hiding', () => {
  const store = () => data();

  it('does nothing when there is nothing to show or hide', () => {
    expect(applyInclusion(SAMPLE_BASE, store(), sanitizeAiPlan({}, store()))).toBeUndefined();
  });

  it('drops an entry from the resume it belongs to', () => {
    const d = store();
    const sections = applyInclusion(SAMPLE_BASE, d, sanitizeAiPlan({ disable: ['proj_thing'] }, d));
    const projects = sections?.find((s) => s.kind === 'project');
    expect(projects?.entries).toEqual([]);

    const resolved = resolveResume(
      { id: 'x', label: 'x', extends: 'base', sections },
      { ...d, resumes: [...d.resumes, { id: 'x', label: 'x', extends: 'base', sections }] },
    );
    expect(resolved.sections.flatMap((s) => s.entries.map((e) => e.id))).not.toContain('proj_thing');
  });

  it('drops one bullet without touching its neighbours', () => {
    const d = store();
    const sections = applyInclusion(SAMPLE_BASE, d, sanitizeAiPlan({ disable: ['b_testing'] }, d));
    expect(sections?.find((s) => s.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_pipeline']);
  });

  it('shows an entry the base left off', () => {
    const d = store();
    const withoutProjects = { ...SAMPLE_BASE, sections: SAMPLE_BASE.sections?.map((s) => (s.kind === 'project' ? { ...s, entries: [] } : s)) };
    const sections = applyInclusion(withoutProjects, d, sanitizeAiPlan({ enable: ['proj_thing'] }, d));
    expect(sections?.find((s) => s.kind === 'project')?.entries).toEqual(['proj_thing']);
  });

  it('puts a re-enabled bullet back in store order, not reply order', () => {
    const d = store();
    const hidden = applyInclusion(SAMPLE_BASE, d, sanitizeAiPlan({ disable: ['b_pipeline'] }, d));
    expect(hidden?.find((s) => s.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_testing']);

    const base = { ...SAMPLE_BASE, sections: hidden };
    const restored = applyInclusion(base, d, sanitizeAiPlan({ enable: ['b_pipeline'] }, d));
    // b_pipeline comes first in the store, so it comes first here.
    expect(restored?.find((s) => s.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_pipeline', 'b_testing']);
  });

  /*
   * Showing one thing is not permission to rearrange the rest. Both of these
   * rebuilt the whole list in the store's order, which a resume that
   * arranged its own lines or entries prints as written — so an AI run that
   * switched one bullet on quietly undid the order somebody had dragged.
   */
  it('shows a bullet without undoing lines the base arranged itself', () => {
    const d = store();
    const acme = d.entries.find((e) => e.id === 'exp_acme')!;
    const extra = { ...acme.bullets![0]!, id: 'b_extra' };
    const entries = d.entries.map((e) => (e.id === 'exp_acme' ? { ...e, bullets: [...e.bullets!, extra] } : e));
    const arranged = {
      ...SAMPLE_BASE,
      sections: SAMPLE_BASE.sections?.map((s) =>
        s.kind === 'experience'
          ? { ...s, bullets: { exp_acme: ['b_testing', 'b_pipeline'] }, bulletOrder: { exp_acme: 'manual' as const } }
          : s,
      ),
    };
    const withExtra = { ...d, entries };
    const sections = applyInclusion(arranged, withExtra, sanitizeAiPlan({ enable: ['b_extra'] }, withExtra));
    // Next to the line it follows in the store, and the arrangement kept.
    expect(sections?.find((s) => s.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_testing', 'b_extra', 'b_pipeline']);
  });

  it('shows an entry without undoing a section arranged by hand', () => {
    const d = store();
    const second = { ...d.entries.find((e) => e.id === 'proj_thing')!, id: 'proj_second' };
    const third = { ...second, id: 'proj_third' };
    const withMore = { ...d, entries: [...d.entries, second, third] };
    const arranged = {
      ...SAMPLE_BASE,
      sections: SAMPLE_BASE.sections?.map((s) =>
        s.kind === 'project' ? { ...s, entries: ['proj_third', 'proj_thing'], order: 'manual' as const } : s,
      ),
    };
    const sections = applyInclusion(arranged, withMore, sanitizeAiPlan({ enable: ['proj_second'] }, withMore));
    expect(sections?.find((s) => s.kind === 'project')?.entries).toEqual(['proj_third', 'proj_thing', 'proj_second']);
  });

  /*
   * Entries settle before lines. Every hide ran before every show, so hiding
   * a line of an entry the same plan shows found the entry off the page and
   * did nothing — and the entry then arrived with all of its lines, the one
   * the model had been told was left off among them.
   */
  it('hides a line of an entry the same plan shows', () => {
    const d = store();
    const withoutAcme = {
      ...SAMPLE_BASE,
      sections: SAMPLE_BASE.sections?.map((s) => (s.kind === 'experience' ? { ...s, entries: [], bullets: {} } : s)),
    };
    const sections = applyInclusion(withoutAcme, d, sanitizeAiPlan({ enable: ['exp_acme'], disable: ['b_testing'] }, d));
    const experience = sections?.find((s) => s.kind === 'experience');
    expect(experience?.entries).toEqual(['exp_acme']);
    expect(experience?.bullets?.exp_acme).toEqual(['b_pipeline']);
  });

  it('leaves the store itself untouched', () => {
    const d = store();
    const before = JSON.stringify(d.entries);
    applyInclusion(SAMPLE_BASE, d, sanitizeAiPlan({ disable: ['b_testing'], enable: ['proj_thing'] }, d));
    expect(JSON.stringify(d.entries)).toBe(before);
  });
});

/** Guard against the fixtures drifting out from under these tests. */
describe('fixtures', () => {
  it('has the ids these tests rely on', () => {
    expect(SAMPLE_EXPERIENCE.bullets?.map((b) => b.id)).toEqual(['b_pipeline', 'b_testing']);
    expect(SAMPLE_EDUCATION.id).toBe('edu_neu');
    expect(SAMPLE_PROJECT.id).toBe('proj_thing');
    expect(SAMPLE_SKILLS[0]?.id).toBe('sk_lang');
  });
});

/**
 * Ordering was the one move the model did not have, and it is the cheapest
 * real tailoring there is: a posting about streaming ingest wants the Kafka
 * line first, and until now the only way to get it there was to hide the
 * three above it.
 *
 * Accepting an order from a reply is only safe because it is a permutation
 * and can be nothing else — these are the tests that say so.
 */
describe('putting things in a different order', () => {
  it('takes an order for the bullets inside an entry', () => {
    const plan = sanitizeAiPlan({ order: { exp_acme: ['b_testing', 'b_pipeline'] } }, data());
    expect(plan.order).toEqual({ exp_acme: ['b_testing', 'b_pipeline'] });
    expect(plan.rejected).toEqual([]);
  });

  it('cannot add a bullet by naming it in an order', () => {
    // A bullet that belongs to another entry, and one that does not exist.
    const plan = sanitizeAiPlan({ order: { exp_acme: ['b_thing', 'b_invented', 'b_pipeline'] } }, data());
    expect(plan.order).toEqual({ exp_acme: ['b_pipeline'] });
    expect(plan.rejected.join(' ')).toContain('exp_acme');
  });

  it('cannot drop one by leaving it out', () => {
    const plan = sanitizeAiPlan({ order: { exp_acme: ['b_testing'] } }, data());
    const sections = applyInclusion(SAMPLE_BASE, data(), plan);
    const experience = sections?.find((s) => s.kind === 'experience');
    // Named first, everything else behind it, nothing lost.
    expect(experience?.bullets?.exp_acme).toEqual(['b_testing', 'b_pipeline']);
  });

  it('refuses an order for an entry that does not exist', () => {
    const plan = sanitizeAiPlan({ order: { exp_nowhere: ['b_pipeline'] } }, data());
    expect(plan.order).toEqual({});
    expect(plan.rejected.join(' ')).toContain('exp_nowhere');
  });

  it('ignores a repeated id rather than printing it twice', () => {
    const plan = sanitizeAiPlan({ order: { exp_acme: ['b_pipeline', 'b_pipeline', 'b_testing'] } }, data());
    expect(plan.order.exp_acme).toEqual(['b_pipeline', 'b_testing']);
  });

  it('reorders entries within a section, by kind', () => {
    const plan = sanitizeAiPlan({ entryOrder: { experience: ['exp_acme'] } }, data());
    expect(plan.entryOrder).toEqual({ experience: ['exp_acme'] });
  });

  it('will not move an entry into a section it does not belong to', () => {
    const plan = sanitizeAiPlan({ entryOrder: { experience: ['proj_thing'] } }, data());
    expect(plan.entryOrder).toEqual({});
    expect(plan.rejected.join(' ')).toContain('experience');
  });

  /*
   * Order is applied after showing and hiding, because reordering a list that
   * is about to lose an entry is work thrown away — and because the default
   * bullet list has to be materialised before there is anything to permute.
   */
  it('orders what is left after hiding, not what was there before', () => {
    const plan = sanitizeAiPlan(
      { disable: ['b_pipeline'], order: { exp_acme: ['b_pipeline', 'b_testing'] } },
      data(),
    );
    const sections = applyInclusion(SAMPLE_BASE, data(), plan);
    expect(sections?.find((s) => s.kind === 'experience')?.bullets?.exp_acme).toEqual(['b_testing']);
  });

  it('does nothing at all when no order is given', () => {
    const plan = sanitizeAiPlan({ choices: {} }, data());
    expect(applyInclusion(SAMPLE_BASE, data(), plan)).toBeUndefined();
  });
});

/*
 * An arrangement the AI makes has to survive the thing that decides order.
 *
 * Both of these were silent. `applyInclusion` wrote the new order down and
 * something downstream put it straight back, so every one of these tools
 * reported success, the plan showed the move, and the document did not — the
 * worst shape a bug can take in a tool an agent is trusting.
 *
 * The editor already knew: dragging an entry there turns that section's date
 * sort off in the same breath, and says so. The AI's path did neither.
 */
describe('an order the AI asks for is the order that prints', () => {
  /** The ids that will actually print, which is the only thing worth asserting. */
  const printedBullets = (d: StoreData, sections: NonNullable<ReturnType<typeof applyInclusion>>, entryId: string) => {
    const spec = { ...SAMPLE_BASE, id: 'tailored', sections };
    const out = resolveResume('tailored', { ...d, resumes: [...d.resumes, spec] });
    return out.sections.flatMap((s) => s.entries).find((e) => e.id === entryId)?.bullets.map((b) => b.id) ?? [];
  };
  const printedEntries = (d: StoreData, sections: NonNullable<ReturnType<typeof applyInclusion>>, kind: string) => {
    const spec = { ...SAMPLE_BASE, id: 'tailored', sections };
    const out = resolveResume('tailored', { ...d, resumes: [...d.resumes, spec] });
    return out.sections.find((s) => s.kind === kind)?.entries.map((e) => e.id) ?? [];
  };

  /*
   * The master now decides the order of the lines inside an entry, and a
   * resume only escapes that by saying it arranged them itself. A plan that
   * set the list without saying so was restacked into the master's order on
   * the way to the page.
   */
  it('a reordered bullet stays where the AI put it', () => {
    const d = data();
    const entry = d.entries.find((e) => (e.bullets ?? []).length >= 2)!;
    const ids = (entry.bullets ?? []).filter((b) => !b.archived).map((b) => b.id);
    const backwards = [...ids].reverse();

    const sections = applyInclusion(SAMPLE_BASE, d, sanitizeAiPlan({ order: { [entry.id]: backwards } }, d))!;
    expect(sections, 'the plan changed something').toBeDefined();
    expect(printedBullets(d, sections, entry.id)).toEqual(backwards);
  });

  /*
   * And the same for entries, against the date sort — which is on for very
   * nearly every section, because `adoptDateOrder` turns it on wherever it
   * provably changes nothing. A section still sorting by date reads the AI's
   * list, ignores it, and sorts by date.
   *
   * Built here rather than taken from the sample store, which holds one
   * experience entry: a reorder test needs two, and the first version of
   * this skipped itself on a store that could not provide them and passed
   * for it.
   */
  it('a reordered entry stays where the AI put it, date sort or not', () => {
    const d = data();
    const older = {
      id: 'exp_older',
      kind: 'experience' as const,
      title: 'Older job',
      period: { start: { year: 2019, month: 1 }, end: { year: 2019, month: 8 } },
      bullets: [],
    };
    const newer = {
      id: 'exp_newer',
      kind: 'experience' as const,
      title: 'Newer job',
      period: { start: { year: 2024, month: 7 }, end: { year: 2024, month: 12 } },
      bullets: [],
    };
    const withBoth: StoreData = { ...d, entries: [...d.entries, older, newer] };
    const base = {
      ...SAMPLE_BASE,
      id: 'dated',
      // Sorting newest first, which is what the store adopts for almost
      // everything — and what quietly discarded the AI's arrangement.
      sections: [{ kind: 'experience' as const, order: 'newest' as const, entries: ['exp_newer', 'exp_older'] }],
    };
    const store = { ...withBoth, resumes: [...withBoth.resumes, base] };

    // Oldest first: the opposite of what the date sort would do.
    const wanted = ['exp_older', 'exp_newer'];
    const sections = applyInclusion(base, store, sanitizeAiPlan({ entryOrder: { experience: wanted } }, store))!;
    expect(sections, 'the plan changed something').toBeDefined();

    const spec = { ...base, id: 'tailored', sections };
    const out = resolveResume('tailored', { ...store, resumes: [...store.resumes, spec] });
    expect(out.sections.find((s) => s.kind === 'experience')?.entries.map((e) => e.id)).toEqual(wanted);
  });

  /*
   * Saying so is the whole mechanism, so it is asserted directly too: a
   * resume that arranged its own lines says `bulletOrder`, and a section the
   * AI arranged by hand stops sorting by date.
   */
  it('writes down that it arranged them, rather than leaving it to be guessed', () => {
    const d = data();
    const entry = d.entries.find((e) => (e.bullets ?? []).length >= 2)!;
    const ids = (entry.bullets ?? []).filter((b) => !b.archived).map((b) => b.id);

    const anExperience = d.entries.find((e) => e.kind === 'experience')!.id;
    const sections = applyInclusion(
      SAMPLE_BASE,
      d,
      sanitizeAiPlan({ order: { [entry.id]: [...ids].reverse() }, entryOrder: { experience: [anExperience] } }, d),
    )!;
    const mine = sections.find((s) => (s.bullets ?? {})[entry.id]);
    expect(mine?.bulletOrder?.[entry.id]).toBe('manual');
    expect(sections.find((s) => s.kind === 'experience')?.order).toBe('manual');
  });

  /* And a plan that arranges nothing leaves both alone. */
  it('says nothing about order when the AI only hid something', () => {
    const d = data();
    const sections = applyInclusion(SAMPLE_BASE, d, sanitizeAiPlan({ disable: ['b_testing'] }, d))!;
    for (const s of sections) {
      expect(s.bulletOrder).toBeUndefined();
      expect(s.order).not.toBe('manual');
    }
  });
});

/*
 * Suggestions are the one part of a tailoring reply that carries prose.
 *
 * They are not applied — they go to the card as "a new wording for this line"
 * — but accepting one is a single click that writes it into the store, so
 * what arrives has to be something the store could honour. The tool path has
 * always checked this, in `SessionState.suggest`; the reply that arrives as
 * JSON instead was echoed through untouched, an unbounded array of arbitrary
 * objects offered beside the resume as though it had been vouched for.
 */
describe('a phrasing the model proposes', () => {
  it('is kept when it belongs to a bullet that exists', () => {
    const kept = sanitizeSuggestions(
      { suggestions: [{ bulletId: 'b_pipeline', label: 'Shorter', text: 'Built the pipeline.', why: 'fits' }] },
      data(),
    );
    expect(kept).toEqual([{ bulletId: 'b_pipeline', label: 'Shorter', text: 'Built the pipeline.', why: 'fits' }]);
  });

  it('is dropped when the bullet is not in the store', () => {
    const kept = sanitizeSuggestions({ suggestions: [{ bulletId: 'b_invented', text: 'Did a thing.' }] }, data());
    expect(kept).toEqual([]);
  });

  it('is dropped when there is no text to offer', () => {
    expect(sanitizeSuggestions({ suggestions: [{ bulletId: 'b_pipeline', text: '   ' }] }, data())).toEqual([]);
    expect(sanitizeSuggestions({ suggestions: [{ bulletId: 'b_pipeline' }] }, data())).toEqual([]);
    expect(sanitizeSuggestions({ suggestions: ['a string', null, 7] }, data())).toEqual([]);
  });

  it('stops at three, and at one for any single bullet', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ bulletId: 'b_pipeline', text: `Wording ${i}` }));
    expect(sanitizeSuggestions({ suggestions: many }, data())).toHaveLength(1);
  });

  it('says nothing at all about a reply that is not a list', () => {
    expect(sanitizeSuggestions({ suggestions: 'all of them' }, data())).toEqual([]);
    expect(sanitizeSuggestions(null, data())).toEqual([]);
  });
});
