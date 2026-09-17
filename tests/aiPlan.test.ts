import { describe, expect, it } from 'vitest';
import { applyInclusion, sanitizeAiPlan } from '../src/jobs/aiPlan.js';
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
