import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { Store } from '../src/model/store.js';
import type { AnswerBankItem, Entry, ResumeSpec, SkillGroup } from '../src/model/types.js';

/**
 * A throwaway store on disk. Several modules read and write YAML directly, so
 * testing them against a real directory is both simpler and more honest than
 * mocking the filesystem.
 */
export interface TempStore {
  dir: string;
  store: Store;
  cleanup: () => void;
  write: (rel: string, data: unknown) => void;
  read: (rel: string) => unknown;
  exists: (rel: string) => boolean;
}

export const SAMPLE_EDUCATION: Entry = {
  id: 'edu_neu',
  kind: 'education',
  title: 'Northeastern University',
  location: 'Boston, MA',
  subtitle: 'Bachelor of Science in Computer Science',
  dates: {
    default: 'v_may2026',
    variants: [
      { id: 'v_may2026', label: 'May 2026', text: 'Sep. 2022 -- May 2026', tags: ['newgrad'] },
      { id: 'v_dec2026', label: 'Dec 2026', text: 'Sep. 2022 -- Dec. 2026', tags: ['intern'] },
    ],
  },
  bullets: [
    {
      id: 'b_course',
      default: 'v_broad',
      variants: [
        { id: 'v_broad', label: 'Broad', text: '**Coursework:** Algorithms, Databases' },
        { id: 'v_systems', label: 'Systems', text: '**Coursework:** Operating Systems, Networks', tags: ['systems'] },
      ],
    },
  ],
};

export const SAMPLE_EXPERIENCE: Entry = {
  id: 'exp_acme',
  kind: 'experience',
  title: 'Acme Co.',
  subtitle: 'Software Engineer Co-op',
  location: 'Boston, MA',
  dates: 'Jul. 2024 -- Dec. 2024',
  tags: ['backend'],
  bullets: [
    {
      id: 'b_pipeline',
      default: 'v_base',
      variants: [
        { id: 'v_base', label: 'Neutral', text: 'Built a pipeline handling **2M events/day**', tags: ['backend'] },
        { id: 'v_kafka', label: 'Kafka', text: 'Built a `Kafka` pipeline handling **2M events/day**', tags: ['kafka', 'streaming'] },
        { id: 'v_short', label: 'Short', text: 'Built a pipeline', tags: ['short'] },
      ],
    },
    {
      id: 'b_testing',
      default: 'v_base',
      variants: [{ id: 'v_base', label: 'Neutral', text: 'Raised coverage from 41% to 88%', tags: ['testing'] }],
    },
  ],
};

export const SAMPLE_PROJECT: Entry = {
  id: 'proj_thing',
  kind: 'project',
  title: 'Thing',
  subtitle: 'Go, Redis',
  dates: '2026',
  bullets: [
    {
      id: 'b_thing',
      default: 'v_base',
      variants: [{ id: 'v_base', label: 'Neutral', text: 'Built a thing that does a job' }],
    },
  ],
};

export const SAMPLE_SKILLS: SkillGroup[] = [
  {
    id: 'sk_lang',
    name: 'Languages',
    items: [
      { id: 's_py', text: 'Python', tags: ['python'] },
      { id: 's_go', text: 'Go', tags: ['go'] },
      { id: 's_ts', text: 'TypeScript', tags: ['typescript'] },
      { id: 's_php', text: 'PHP', tags: ['php'] },
    ],
  },
];

export const SAMPLE_ANSWERS: AnswerBankItem[] = [
  {
    id: 'ans_why',
    question: 'Why are you interested in this role?',
    default: 'v_1',
    variants: [{ id: 'v_1', label: 'Standard', text: 'Because the work is interesting.' }],
  },
  {
    id: 'ans_sponsor',
    question: 'Will you now or in the future require sponsorship for employment visa status?',
    default: 'v_no',
    variants: [
      { id: 'v_no', label: 'No', text: 'No' },
      { id: 'v_yes', label: 'Yes', text: 'Yes' },
    ],
  },
];

export const SAMPLE_BASE: ResumeSpec = {
  id: 'base',
  label: 'Base resume',
  sections: [
    { kind: 'education', entries: ['edu_neu'] },
    { kind: 'experience', entries: ['exp_acme'] },
    { kind: 'project', entries: ['proj_thing'] },
    { kind: 'skills', entries: [], groups: ['sk_lang'] },
  ],
};

export const SAMPLE_NEWGRAD: ResumeSpec = {
  id: 'newgrad',
  label: 'New grad',
  extends: 'base',
  choices: { 'edu_neu.dates': 'v_may2026' },
};

export const SAMPLE_INTERN: ResumeSpec = {
  id: 'intern',
  label: 'Summer intern',
  extends: 'base',
  choices: { 'edu_neu.dates': 'v_dec2026' },
};

/** Build a temp store seeded with the sample content above. */
export function makeTempStore(overrides: { config?: unknown; empty?: boolean } = {}): TempStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-test-store-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'resumes'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'letters'), { recursive: true });

  const write = (rel: string, data: unknown) => {
    const f = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof data === 'string' ? data : YAML.stringify(data, { lineWidth: 0 }), 'utf8');
  };

  if (!overrides.empty) {
    write('profile.yaml', {
      name: 'Test Person',
      email: 'test@example.com',
      phone: '555-0100',
      github: 'github.com/test',
      autofill: { first_name: 'Test', last_name: 'Person', school: 'Northeastern University' },
    });
    write('education.yaml', [SAMPLE_EDUCATION]);
    write('experience.yaml', [SAMPLE_EXPERIENCE]);
    write('projects.yaml', [SAMPLE_PROJECT]);
    write('skills.yaml', SAMPLE_SKILLS);
    write('answers.yaml', SAMPLE_ANSWERS);
    write('applications.yaml', []);
    write('voice.md', '# Voice\n\nPlain and direct.\n');
    write('resumes/base.yaml', SAMPLE_BASE);
    write('resumes/newgrad.yaml', SAMPLE_NEWGRAD);
    write('resumes/intern.yaml', SAMPLE_INTERN);
    write(
      'letters/2026-01-01-acme.md',
      '---\ntitle: SWE Co-op — Acme Co.\ncompany: Acme Co.\nrole: Software Engineer Co-op\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\nDear Acme, here is a letter I wrote before.\n',
    );
  }

  write('config.yaml', overrides.config ?? { ai: { enabled: false }, git: { autoCommit: false }, output: { dir: 'out' } });

  return {
    dir: dataDir,
    store: new Store(dataDir),
    write,
    read: (rel: string) => YAML.parse(fs.readFileSync(path.join(dataDir, rel), 'utf8')),
    exists: (rel: string) => fs.existsSync(path.join(dataDir, rel)),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** True when a LaTeX engine is installed, for gating the slow tests. */
export async function hasLatex(): Promise<boolean> {
  const { detectEngine } = await import('../src/render/compile.js');
  return detectEngine().then(
    () => true,
    () => false,
  );
}
