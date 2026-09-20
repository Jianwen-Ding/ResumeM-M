import { describe, expect, it } from 'vitest';
import { makeTempStore } from './helpers.js';
import { resolveResume } from '../src/model/resolve.js';
import type { Entry, ResumeSpec, SkillGroup } from '../src/model/types.js';

/**
 * Deleting something takes it out of the resumes that were using it.
 *
 * Every test here reads the resume files back off disk rather than through
 * `loadResumes`, because the question is what the save says — a fold that
 * hides a dangling id on the way past would answer the wrong question.
 */

const ENTRY: Entry = {
  id: 'exp_acme',
  kind: 'experience',
  title: 'Acme Co.',
  subtitle: {
    default: 'v_swe',
    variants: [
      { id: 'v_swe', label: 'SWE', text: 'Software Engineer' },
      { id: 'v_intern', label: 'Intern', text: 'Software Engineer Intern' },
    ],
  },
  bullets: [
    {
      id: 'b_kafka',
      default: 'v_long',
      variants: [
        { id: 'v_long', label: 'Long', text: 'Built a Kafka pipeline moving 2M events a day.' },
        { id: 'v_short', label: 'Short', text: 'Built a Kafka pipeline.' },
      ],
    },
    { id: 'b_tests', default: 'v_1', variants: [{ id: 'v_1', label: 'Only', text: 'Wrote the tests.' }] },
    { id: 'b_oncall', default: 'v_1', variants: [{ id: 'v_1', label: 'Only', text: 'Carried the pager.' }] },
  ],
};

const SKILLS: SkillGroup[] = [
  {
    id: 'sk_lang',
    name: 'Languages',
    items: [
      { id: 's_py', text: 'Python' },
      { id: 's_go', text: 'Go' },
    ],
  },
  { id: 'sk_tools', name: 'Tools', items: [{ id: 's_k8s', text: 'Kubernetes' }] },
];

/** A resume that chooses something of everything the entry and skills offer. */
const PICKY: ResumeSpec = {
  id: 'picky',
  label: 'Picky',
  sections: [
    { kind: 'experience', entries: ['exp_acme'], bullets: { exp_acme: ['b_kafka', 'b_tests'] }, bulletOrder: { exp_acme: 'manual' } },
    { kind: 'skills', entries: [], groups: ['sk_lang', 'sk_tools'], items: { sk_lang: ['s_py', 's_go'], sk_tools: ['s_k8s'] } },
  ],
  choices: { 'exp_acme.subtitle': 'v_intern', b_kafka: 'v_short', 'profile.name': 'v_formal' },
  collapsed: ['exp_acme'],
};

function seed(): ReturnType<typeof makeTempStore> {
  const t = makeTempStore({ empty: true });
  t.write('config.yaml', { ai: { enabled: false }, git: { autoCommit: false }, output: { dir: 'out' } });
  t.write('profile.yaml', {
    name: {
      default: 'v_plain',
      variants: [
        { id: 'v_plain', label: 'Plain', text: 'Test Person' },
        { id: 'v_formal', label: 'Formal', text: 'Testerson Person' },
      ],
    },
  });
  t.write('experience.yaml', [ENTRY]);
  t.write('skills.yaml', SKILLS);
  t.write('resumes/picky.yaml', PICKY);
  return t;
}

const spec = (t: ReturnType<typeof makeTempStore>): ResumeSpec => t.read('resumes/picky.yaml') as ResumeSpec;

describe('a delete reaches every resume that was using it', () => {
  it('takes a deleted entry out of the section, the selections and the choices', () => {
    const t = seed();
    try {
      expect(t.store.deleteEntry('exp_acme')).toBe(true);

      const after = spec(t);
      expect(after.sections?.[0]?.entries).toEqual([]);
      expect(after.sections?.[0]?.bullets).toEqual({});
      expect(after.sections?.[0]?.bulletOrder).toEqual({});
      expect(after.choices).not.toHaveProperty('exp_acme.subtitle');
      expect(after.choices).not.toHaveProperty('b_kafka');
      expect(after.collapsed).toEqual([]);

      // And the resume no longer has anything to complain about.
      const resolved = resolveResume(after.id, t.store.load());
      expect(resolved.lost ?? []).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('keeps a name pinned on the resume, which is neither an entry nor a skill', () => {
    const t = seed();
    try {
      t.store.deleteEntry('exp_acme');
      expect(spec(t).choices?.['profile.name']).toBe('v_formal');
    } finally {
      t.cleanup();
    }
  });

  it('takes a deleted line out of every resume that had picked it', () => {
    const t = seed();
    try {
      t.store.saveEntry({ ...ENTRY, bullets: ENTRY.bullets!.filter((b) => b.id !== 'b_kafka') });

      const after = spec(t);
      expect(after.sections?.[0]?.bullets?.exp_acme).toEqual(['b_tests']);
      // The wording chosen for that line goes with it.
      expect(after.choices).not.toHaveProperty('b_kafka');
      // Everything else about the resume is untouched.
      expect(after.sections?.[0]?.entries).toEqual(['exp_acme']);
      expect(after.choices?.['exp_acme.subtitle']).toBe('v_intern');
    } finally {
      t.cleanup();
    }
  });

  it('leaves a selection that has lost every line empty, not absent', () => {
    const t = seed();
    try {
      // The resume showed b_kafka and b_tests out of three. Both go; b_oncall
      // stays in the store, switched off on this resume. An absent list would
      // mean "show them all", which would put a line somebody had turned off
      // onto the page.
      t.store.saveEntry({ ...ENTRY, bullets: ENTRY.bullets!.filter((b) => b.id === 'b_oncall') });

      const after = spec(t);
      expect(after.sections?.[0]?.bullets?.exp_acme).toEqual([]);
      expect(after.sections?.[0]?.bullets).toHaveProperty('exp_acme');

      const resolved = resolveResume('picky', t.store.load());
      expect(resolved.sections[0]?.entries[0]?.bullets ?? []).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('takes a deleted wording out of the resumes that pinned it', () => {
    const t = seed();
    try {
      t.store.saveEntry({
        ...ENTRY,
        subtitle: { default: 'v_swe', variants: [{ id: 'v_swe', label: 'SWE', text: 'Software Engineer' }] },
      });
      expect(spec(t).choices).not.toHaveProperty('exp_acme.subtitle');
      // The line's own chosen wording is a different id and survives.
      expect(spec(t).choices?.b_kafka).toBe('v_short');
    } finally {
      t.cleanup();
    }
  });

  it('takes a deleted skill out of every resume, and a deleted group with it', () => {
    const t = seed();
    try {
      t.store.saveSkillGroups([{ ...SKILLS[0]!, items: [{ id: 's_py', text: 'Python' }] }]);

      const after = spec(t);
      expect(after.sections?.[1]?.items?.sk_lang).toEqual(['s_py']);
      expect(after.sections?.[1]?.groups).toEqual(['sk_lang']);
      expect(after.sections?.[1]?.items).not.toHaveProperty('sk_tools');

      const resolved = resolveResume('picky', t.store.load());
      expect(resolved.lost ?? []).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('takes a deleted list item out of the resume that had chosen it', () => {
    const t = seed();
    try {
      const listy: Entry = {
        ...ENTRY,
        bullets: [
          {
            id: 'b_course',
            default: 'v_1',
            variants: [{ id: 'v_1', label: 'Only', text: '' }],
            prefix: '**Coursework:**',
            items: [
              { id: 'i_algo', text: 'Algorithms' },
              { id: 'i_db', text: 'Databases' },
            ],
          },
        ],
      };
      t.write('experience.yaml', [listy]);
      t.write('resumes/picky.yaml', {
        ...PICKY,
        sections: [{ kind: 'experience', entries: ['exp_acme'], bullets: { exp_acme: ['b_course'] } }],
        lists: { b_course: ['i_algo', 'i_db'] },
        choices: {},
      });

      t.store.saveEntry({ ...listy, bullets: [{ ...listy.bullets![0]!, items: [{ id: 'i_algo', text: 'Algorithms' }] }] });

      expect(spec(t).lists?.b_course).toEqual(['i_algo']);
    } finally {
      t.cleanup();
    }
  });

  it('does not rewrite the resumes for a save that only adds', () => {
    const t = seed();
    try {
      // A reference that was already dangling before this save. The pass would
      // clear it; the gate in front of the pass means a save that removes
      // nothing never reaches it, which is what keeps an entry saved on every
      // idle in the editor from walking every resume in the save.
      t.write('resumes/picky.yaml', { ...PICKY, collapsed: ['exp_acme', 'exp_gone'] });

      t.store.saveEntry({
        ...ENTRY,
        bullets: [...ENTRY.bullets!, { id: 'b_new', default: 'v_1', variants: [{ id: 'v_1', label: 'Only', text: 'Something new.' }] }],
      });

      expect(spec(t).collapsed).toEqual(['exp_acme', 'exp_gone']);
    } finally {
      t.cleanup();
    }
  });
});
