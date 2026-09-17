import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/model/store.js';
import { makeTempStore, type TempStore } from './helpers.js';

let t: TempStore;
beforeEach(() => {
  t = makeTempStore();
});
afterEach(() => {
  delete process.env.RMM_AUTOCOMMIT;
  delete process.env.RMM_AI;
  delete process.env.RMM_LATEX_ENGINE;
  t.cleanup();
});

describe('loading', () => {
  it('reads every file into one object', () => {
    const data = t.store.load();
    expect(data.profile.name).toBe('Test Person');
    expect(data.entries.map((e) => e.id)).toEqual(['edu_neu', 'exp_acme', 'proj_thing']);
    expect(data.skillGroups).toHaveLength(1);
    expect(data.resumes.map((r) => r.id).sort()).toEqual(['base', 'intern', 'newgrad']);
    expect(data.answers).toHaveLength(2);
    expect(data.coverLetters).toHaveLength(1);
    expect(data.voice).toContain('Plain and direct');
  });

  it('survives a store with nothing in it', () => {
    const empty = makeTempStore({ empty: true });
    const data = empty.store.load();
    expect(data.entries).toEqual([]);
    expect(data.resumes).toEqual([]);
    expect(data.profile.name).toBe('Your Name');
    empty.cleanup();
  });

  it('treats an empty file as absent rather than throwing', () => {
    t.write('experience.yaml', '');
    expect(t.store.load().entries.map((e) => e.id)).not.toContain('exp_acme');
  });

  it('takes the resume id from the filename, so the two cannot diverge', () => {
    /*
     * The title was always the rule; the body asserted the opposite, and so did
     * the code — the id inside the file won. That is how two files came to
     * claim one id: copy base.yaml to base-old.yaml, and the copy sorted first
     * and answered every lookup for `base`, while edits went on being written
     * to base.yaml and appeared to be thrown away.
     */
    t.write('resumes/renamed.yaml', { id: 'something-else', label: 'Renamed' });
    const ids = t.store.loadResumes().map((r) => r.id);
    expect(ids).toContain('renamed');
    expect(ids).not.toContain('something-else');

    // A file without one loads under its filename too, as it always did.
    t.write('resumes/no-id.yaml', { label: 'No id' });
    expect(t.store.loadResumes().map((r) => r.id)).toContain('no-id');

    // And a copied file is its own resume rather than a second claim on one.
    t.write('resumes/base-old.yaml', { id: 'base', label: 'Old copy' });
    expect(t.store.getResume('base')?.label).toBe('Base resume');
    expect(t.store.getResume('base-old')?.label).toBe('Old copy');
  });
});

describe('config', () => {
  it('fills in defaults for anything the file omits', () => {
    const config = t.store.loadConfig();
    expect(config.ai.command).toBe('claude');
    expect(config.ai.enabled).toBe(false);
    expect(config.output.dir).toBe('out');
    expect(config.latex.engine).toBeUndefined();
  });

  it('lets the environment force auto-commit off for automated runs', () => {
    const on = makeTempStore({ config: { git: { autoCommit: true } } });
    expect(on.store.loadConfig().git.autoCommit).toBe(true);
    process.env.RMM_AUTOCOMMIT = '0';
    expect(on.store.loadConfig().git.autoCommit).toBe(false);
    on.cleanup();
  });

  it('lets the environment force the AI off and pick an engine', () => {
    const on = makeTempStore({ config: { ai: { enabled: true } } });
    expect(on.store.loadConfig().ai.enabled).toBe(true);
    process.env.RMM_AI = '0';
    process.env.RMM_LATEX_ENGINE = 'tectonic';
    expect(on.store.loadConfig().ai.enabled).toBe(false);
    expect(on.store.loadConfig().latex.engine).toBe('tectonic');
    on.cleanup();
  });
});

describe('writing entries', () => {
  it('routes an entry back to the file its kind belongs in', () => {
    t.store.saveEntry({ id: 'exp_new', kind: 'experience', title: 'New Co.' });
    expect((t.read('experience.yaml') as { id: string }[]).map((e) => e.id)).toContain('exp_new');
    expect((t.read('education.yaml') as { id: string }[]).map((e) => e.id)).not.toContain('exp_new');
  });

  it('routes an unrecognised kind to custom.yaml', () => {
    t.store.saveEntry({ id: 'x', kind: 'custom', title: 'Extra' });
    expect(t.exists('custom.yaml')).toBe(true);
  });

  it('updates in place rather than appending a duplicate', () => {
    t.store.saveEntry({ ...{ id: 'exp_acme', kind: 'experience' as const, title: 'Renamed Co.' } });
    const list = t.read('experience.yaml') as { id: string; title: string }[];
    expect(list.filter((e) => e.id === 'exp_acme')).toHaveLength(1);
    expect(list[0]?.title).toBe('Renamed Co.');
  });

  it('deletes from whichever file holds it, and reports when nothing matched', () => {
    expect(t.store.deleteEntry('exp_acme')).toBe(true);
    expect(t.store.deleteEntry('exp_acme')).toBe(false);
    expect(t.store.load().entries.map((e) => e.id)).not.toContain('exp_acme');
  });

  it('keeps long bullet text on one line so diffs stay per-bullet', () => {
    const long = 'x'.repeat(400);
    t.store.saveEntry({
      id: 'exp_long',
      kind: 'experience',
      title: 'Long',
      bullets: [{ id: 'b', default: 'v', variants: [{ id: 'v', label: 'L', text: long }] }],
    });
    const raw = fs.readFileSync(path.join(t.dir, 'experience.yaml'), 'utf8');
    expect(raw).toContain(long);
  });
});

describe('resumes', () => {
  it('round-trips a spec', () => {
    t.store.saveResume({ id: 'custom', label: 'Custom', extends: 'base', choices: { b_pipeline: 'v_kafka' } });
    expect(t.store.getResume('custom')?.choices).toEqual({ b_pipeline: 'v_kafka' });
  });

  it('deletes both .yaml and .yml spellings', () => {
    t.write('resumes/oldstyle.yml', { id: 'oldstyle', label: 'Old' });
    expect(t.store.loadResumes().map((r) => r.id)).toContain('oldstyle');
    t.store.deleteResume('oldstyle');
    expect(t.store.loadResumes().map((r) => r.id)).not.toContain('oldstyle');
  });

  it('ignores files that are not yaml', () => {
    fs.writeFileSync(path.join(t.dir, 'resumes', 'notes.txt'), 'not a resume');
    expect(() => t.store.loadResumes()).not.toThrow();
  });

  it('returns undefined for a resume that does not exist', () => {
    expect(t.store.getResume('nope')).toBeUndefined();
  });
});

describe('cover letters', () => {
  it('parses front matter and body', () => {
    const [letter] = t.store.loadCoverLetters();
    expect(letter?.company).toBe('Acme Co.');
    expect(letter?.role).toBe('Software Engineer Co-op');
    expect(letter?.body).toContain('here is a letter I wrote before');
  });

  it('handles a letter with no front matter at all', () => {
    t.write('letters/bare.md', 'Just a body, no header.');
    const bare = t.store.loadCoverLetters().find((l) => l.id === 'bare');
    expect(bare?.title).toBe('bare');
    expect(bare?.body).toContain('Just a body');
  });

  it('round-trips through save and load', () => {
    t.store.saveCoverLetter({
      id: 'new-letter',
      title: 'New',
      company: 'Beta',
      role: 'Intern',
      createdAt: '2026-02-02T00:00:00.000Z',
      body: 'Body text',
    });
    const saved = t.store.loadCoverLetters().find((l) => l.id === 'new-letter');
    expect(saved?.company).toBe('Beta');
    expect(saved?.body.trim()).toBe('Body text');
  });

  it('returns nothing when there is no letters directory', () => {
    const empty = makeTempStore({ empty: true });
    fs.rmSync(path.join(empty.dir, 'letters'), { recursive: true, force: true });
    expect(empty.store.loadCoverLetters()).toEqual([]);
    empty.cleanup();
  });
});

describe('applications, answers, profile, voice', () => {
  it('upserts an application by id', () => {
    t.store.upsertApplication({ id: 'a1', company: 'Acme', role: 'SWE', status: 'applied' });
    t.store.upsertApplication({ id: 'a1', company: 'Acme', role: 'SWE', status: 'interview' });
    const apps = t.store.load().applications;
    expect(apps).toHaveLength(1);
    expect(apps[0]?.status).toBe('interview');
  });

  it('saves answers, profile, and voice', () => {
    t.store.saveAnswers([{ id: 'a', question: 'Q?', default: 'v', variants: [{ id: 'v', label: 'V', text: 'A' }] }]);
    t.store.saveProfile({ name: 'Renamed' });
    t.store.saveVoice('New voice notes');
    const data = t.store.load();
    expect(data.answers).toHaveLength(1);
    expect(data.profile.name).toBe('Renamed');
    expect(data.voice).toBe('New voice notes');
  });

  it('returns an empty string when there are no voice notes', () => {
    const empty = makeTempStore({ empty: true });
    expect(empty.store.loadVoice()).toBe('');
    empty.cleanup();
  });
});

describe('output directory', () => {
  it('is created beside the store on demand', () => {
    const out = t.store.outDir();
    expect(fs.existsSync(out)).toBe(true);
    expect(path.basename(out)).toBe('out');
  });

  it('honours a configured directory name', () => {
    const custom = makeTempStore({ config: { output: { dir: 'artifacts' } } });
    expect(path.basename(custom.store.outDir())).toBe('artifacts');
    custom.cleanup();
  });
});

describe('construction', () => {
  it('resolves a relative root to an absolute path', () => {
    expect(path.isAbsolute(new Store('data').root)).toBe(true);
  });
});

describe('files a person edited by hand', () => {
  it('reads a sample with no front matter as an untitled note', () => {
    t.write('corpus/scratch.md', 'Something I wrote and never labelled.');
    const sample = t.store.loadSamples().find((s) => s.id === 'scratch');
    expect(sample?.title).toBe('scratch');
    expect(sample?.kind).toBe('other');
    expect(sample?.text).toContain('never labelled');
  });

  it('fills in what a half-written header left out', () => {
    t.write('corpus/half.md', '---\ntags: [old]\n---\nThe body.');
    const sample = t.store.loadSamples().find((s) => s.id === 'half');
    expect(sample?.title).toBe('half');
    expect(sample?.kind).toBe('other');
    expect(sample?.createdAt).toBe('');
    expect(sample?.tags).toEqual(['old']);
  });

  it('reads an empty header rather than tripping over it', () => {
    t.write('corpus/empty-head.md', '---\n\n---\nJust the body.');
    expect(t.store.loadSamples().find((s) => s.id === 'empty-head')?.text).toContain('Just the body');
    t.write('letters/empty-head.md', '---\n\n---\nJust the body.');
    expect(t.store.loadCoverLetters().find((l) => l.id === 'empty-head')?.title).toBe('empty-head');
  });

  it('has no corpus when the folder was never made', () => {
    const empty = makeTempStore({ empty: true });
    expect(empty.store.loadSamples()).toEqual([]);
    empty.cleanup();
  });

  it('names a draft after its file when the file forgot to say', () => {
    t.write('drafts/nameless.yaml', 'company: Acme\nrole: Intern\n');
    expect(t.store.loadDrafts().find((d) => d.id === 'nameless')).toBeTruthy();
  });

  it('treats an empty yaml file as the empty thing it is', () => {
    t.write('applications.yaml', '');
    expect(t.store.load().applications).toEqual([]);
  });
});

describe('patching config one section at a time', () => {
  it('merges into a section without dropping the rest of it', () => {
    t.store.saveConfig({ latex: { engine: 'tectonic' } } as never);
    const after = t.store.loadConfig();
    expect(after.latex.engine).toBe('tectonic');
    // The sections that were not mentioned are untouched.
    expect(after.ai.command).toBe(t.store.loadConfig().ai.command);
    expect(after.output.dir).toBeTruthy();
  });

  it('patches the other sections the same way', () => {
    t.store.saveConfig({ ai: { enabled: true } } as never);
    t.store.saveConfig({ git: { autoCommit: false } } as never);
    t.store.saveConfig({ output: { dir: 'built' } } as never);
    const after = t.store.loadConfig();
    expect(after.ai.enabled).toBe(true);
    expect(after.git.autoCommit).toBe(false);
    expect(after.output.dir).toBe('built');
  });
});

describe('where an entry is written back', () => {
  it('puts a project in projects.yaml, beside the other projects', () => {
    t.store.saveEntry({ id: 'proj_new', kind: 'project', title: 'A new thing' });
    const raw = fs.readFileSync(path.join(t.dir, 'projects.yaml'), 'utf8');
    expect(raw).toContain('proj_new');
  });
});
