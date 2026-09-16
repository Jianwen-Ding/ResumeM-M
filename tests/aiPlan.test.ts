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
