import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { Store } from '../src/model/store.js';
import type { Entry, SkillGroup } from '../src/model/types.js';
import { makeTempStore, type TempStore } from './helpers.js';

/**
 * What the store does to text it has never seen before.
 *
 * Everything under here is the same question asked about a different file: a
 * person is about to import years of their own writing into a folder of YAML,
 * and the failure that matters is not a crash. It is the résumé that comes back
 * with an accent missing, the tracker that comes back with half the history in
 * it, the cover letter whose header quietly stopped being a header — each of
 * them silent, each of them only noticeable weeks later when the wrong file has
 * already been sent.
 *
 * So these tests are about fidelity and about refusal. Text goes in and the
 * same text comes out, byte for byte, twice over; and where a file genuinely
 * cannot be understood, the error says which file and what is wrong with it
 * rather than handing back an empty list.
 */

let t: TempStore;
beforeEach(() => {
  t = makeTempStore({ empty: true });
});
afterEach(() => t.cleanup());

/**
 * Text that is unremarkable to a person and awkward to YAML.
 *
 * Every one of these is something somebody actually writes on a résumé or in a
 * cover letter. They are gathered in one list so the round-trip tests below can
 * be property-style — the same assertion made over every string here in every
 * field that holds free text — rather than one fixture that happens to dodge
 * the case that breaks.
 */
const AWKWARD: Record<string, string> = {
  // YAML 1.1 booleans. A skill really can be called `NO` (the Norwegian
  // country code on a localisation CV) and a résumé really does say `on`.
  bareNo: 'NO',
  bareY: 'Y',
  bareOn: 'on',
  bareOff: 'off',
  wordTrue: 'true',
  wordNull: 'null',
  tilde: '~',
  // Version and phone shapes that a naive writer turns into numbers.
  version: '1.10',
  leadingZero: '007',
  plusPhone: '+1 (555) 010-0100',
  onlyDigits: '12345',
  octalish: '0755',
  // A date-shaped string that must stay the string the user typed.
  dateShaped: '2026-09-18',
  timestamp: '2026-09-18T14:30:00.000Z',
  clock: '10:30',
  // Leading characters YAML reads as structure.
  leadingDash: '- shipped the thing',
  leadingHash: '# not a heading',
  leadingPercent: '% of revenue retained',
  leadingAt: '@mentioned in the release notes',
  leadingTick: '`npm test` in CI',
  leadingBracket: '[draft] not yet reviewed',
  leadingBrace: '{placeholder} to fill in',
  leadingAmp: '& then the migration landed',
  leadingStar: '* emphasis, not a list',
  leadingBang: '!important, as CSS puts it',
  // A colon followed by a space is the one that bites plain scalars.
  colonSpace: 'Coursework: Algorithms, Databases, Networks',
  // Real text that is merely inconvenient.
  emoji: 'shipped it 🚀 and the team said 🎉',
  astral: 'math italic 𝐴𝐵𝐶 and a 𝕮lever logo',
  accents: 'Zoë Ørsted, Łukasz Dvořák, naïve résumé',
  rtl: 'ירושלים — مرحبا بالعالم',
  tab: 'before\tafter',
  nbsp: '5 GB/s sustained',
  trailingSpace: 'ends with a space ',
  leadingSpace: ' starts with a space',
  crlf: 'first line\r\nsecond line',
  paragraphs: 'Dear hiring team,\n\nI am writing about the role.\n\nBest,\nA Person',
  blankLines: 'one\n\n\n\nfour',
  // LaTeX's ten special characters. They must live in the store exactly as
  // typed and be escaped at render time, never at save time.
  latex: 'Raised margin from $1 & 50% on _x_ {y} ~z ^w \\ all of it',
  longLine: `A single bullet with no line breaks in it at all, ${'padding '.repeat(1400)}end.`,
  justSpaces: '   ',
  empty: '',
};

/** One entry whose every text-bearing field is set to the same awkward string. */
function entryOf(id: string, text: string): Entry {
  return {
    id,
    kind: 'experience',
    title: text,
    subtitle: text,
    location: text,
    dates: { default: 'v_1', variants: [{ id: 'v_1', label: text, text, tags: [text], note: text }] },
    tags: [text],
    bullets: [
      { id: `${id}_b`, default: 'v_1', variants: [{ id: 'v_1', label: text, text }] },
      {
        id: `${id}_l`,
        default: 'v_1',
        variants: [],
        prefix: text,
        separator: text,
        items: [{ id: 'i_1', text, tags: [text] }],
      },
    ],
  };
}

describe('text survives being stored', () => {
  /*
   * The property, stated once over every string in AWKWARD.
   *
   * A fixture proves that one sentence survives; this proves that the shape of
   * the sentence does not matter, which is the thing a person importing their
   * own files actually needs. `text: NO` written unquoted is `false` to any
   * YAML 1.1 reader, `text: 1.10` is the number 1.1, and `text: 2026-09-18` is
   * a date in several of them — and each of those comes back as a different
   * type than it went in, which downstream is a bullet that renders as "false"
   * or a version that lost its trailing zero.
   */
  it('gives back exactly the string it was given, whatever the string is', () => {
    const entries = Object.entries(AWKWARD).map(([name, text]) => entryOf(`exp_${name}`, text));
    for (const e of entries) t.store.saveEntry(e);

    const back = t.store.load().entries;
    for (const [name, text] of Object.entries(AWKWARD)) {
      const got = back.find((e) => e.id === `exp_${name}`);
      expect(got, name).toBeDefined();
      expect(got!.title, `${name} title`).toBe(text);
      expect(got!.subtitle, `${name} subtitle`).toBe(text);
      expect(got!.location, `${name} location`).toBe(text);
      expect(got!.tags, `${name} tags`).toEqual([text]);
      const dates = got!.dates as { variants: { text: string; label: string }[] };
      expect(dates.variants[0]?.text, `${name} variant text`).toBe(text);
      expect(dates.variants[0]?.label, `${name} variant label`).toBe(text);
      expect(got!.bullets?.[0]?.variants[0]?.text, `${name} bullet`).toBe(text);
      expect(got!.bullets?.[1]?.prefix, `${name} prefix`).toBe(text);
      expect(got!.bullets?.[1]?.separator, `${name} separator`).toBe(text);
      expect(got!.bullets?.[1]?.items?.[0]?.text, `${name} list item`).toBe(text);
    }
  });

  /*
   * And the second write is the same bytes as the first.
   *
   * The store is under git, and the whole argument for plain files is that a
   * diff is readable. A save that re-quotes a string it read unquoted, or
   * reflows a long bullet, turns every commit into a diff of the whole file and
   * hides the one line that changed — which is how a wrong edit gets committed
   * without anybody seeing it.
   */
  it('writes the same bytes the second time, so a commit diffs one line', () => {
    for (const [name, text] of Object.entries(AWKWARD)) t.store.saveEntry(entryOf(`exp_${name}`, text));
    const first = fs.readFileSync(path.join(t.dir, 'experience.yaml'), 'utf8');

    for (const e of t.store.load().entries) t.store.saveEntry(e);
    expect(fs.readFileSync(path.join(t.dir, 'experience.yaml'), 'utf8')).toBe(first);
  });

  /*
   * LaTeX's special characters are escaped by the renderer, at render time.
   * Escaping on the way to disk would be permanent: the backslash the user
   * typed becomes `\textbackslash{}` in their own file, and the second save
   * escapes the escape.
   */
  it('keeps LaTeX special characters as the user typed them', () => {
    const raw = 'Cut cost 50% on $1M & {scale} ~2x, file_name.tex, 10^3, \\begin{document}';
    t.store.saveEntry(entryOf('exp_tex', raw));
    expect(t.store.load().entries.find((e) => e.id === 'exp_tex')?.title).toBe(raw);
    // And in the file, not merely in the object handed back.
    expect(fs.readFileSync(path.join(t.dir, 'experience.yaml'), 'utf8')).toContain(raw);
  });

  it('keeps a profile, skills and answers through the same round trip', () => {
    const text = AWKWARD.colonSpace!;
    t.store.saveProfile({ name: text, phone: '+1 (555) 010-0100', email: text, location: AWKWARD.rtl });
    t.store.saveSkillGroups([{ id: 'g', name: text, items: [{ id: 's', text: AWKWARD.version! }] }]);
    t.store.saveAnswers([
      { id: 'a', question: text, default: 'v_1', variants: [{ id: 'v_1', label: 'x', text: AWKWARD.paragraphs! }] },
    ]);

    const data = t.store.load();
    expect(data.profile.name).toBe(text);
    expect(data.profile.phone).toBe('+1 (555) 010-0100');
    expect(data.profile.location).toBe(AWKWARD.rtl);
    expect(data.skillGroups[0]?.items[0]?.text).toBe(AWKWARD.version);
    expect(data.answers[0]?.variants[0]?.text).toBe(AWKWARD.paragraphs);
  });

  /*
   * A cover letter is the longest prose in the store and the one most likely to
   * arrive from somewhere else. Blank lines between paragraphs, a `---` rule
   * further down, CRLF from a Windows editor: all of it is body text and none
   * of it is structure.
   */
  it('keeps a multi-paragraph letter, blank lines and all', () => {
    const body = 'Dear team,\n\nI read the posting.\n\n  - it mentions Kafka\n\nBest,\nA Person\n';
    t.store.saveCoverLetter({ id: 'l1', title: AWKWARD.colonSpace!, createdAt: '2026-01-01', body });
    const back = t.store.loadCoverLetters().find((l) => l.id === 'l1');
    expect(back?.body).toBe(body);
    expect(back?.title).toBe(AWKWARD.colonSpace);

    // Saved again from what was read, the file is unchanged.
    const first = fs.readFileSync(path.join(t.dir, 'letters', 'l1.md'), 'utf8');
    t.store.saveCoverLetter(back!);
    expect(fs.readFileSync(path.join(t.dir, 'letters', 'l1.md'), 'utf8')).toBe(first);
  });
});

describe('a file that cannot be read says which file it is', () => {
  /*
   * `YAML.parse` throws "Flow sequence in block collection must be sufficiently
   * indented and end with a ] at line 2, column 1". True, and useless: a store
   * is ten YAML files at the root plus a folder of resumes, a folder of drafts,
   * a folder of letters and a corpus, and that message names none of them. The
   * moment this happens is the moment somebody has hand-edited or imported one
   * file out of twenty, and "which one?" is the only question they have.
   */
  const corrupt = 'title: [ unclosed\n';

  it('names the root file that will not parse', () => {
    for (const rel of ['profile.yaml', 'experience.yaml', 'skills.yaml', 'applications.yaml', 'answers.yaml']) {
      t.write(rel, corrupt);
      expect(() => t.store.load(), rel).toThrow(new RegExp(rel.replace('.', '\\.')));
      t.write(rel, rel === 'profile.yaml' ? 'name: Test\n' : '[]\n');
    }
  });

  it('names config.yaml rather than falling back to the defaults in silence', () => {
    t.write('config.yaml', corrupt);
    expect(() => t.store.loadConfig()).toThrow(/config\.yaml/);
  });

  it('names the resume, the draft, the letter and the sample', () => {
    t.write('resumes/base.yaml', corrupt);
    expect(() => t.store.loadResumes()).toThrow(/resumes.base\.yaml/);
    fs.rmSync(path.join(t.dir, 'resumes', 'base.yaml'));

    t.write('drafts/d1.yaml', corrupt);
    expect(() => t.store.loadDrafts()).toThrow(/drafts.d1\.yaml/);
    fs.rmSync(path.join(t.dir, 'drafts', 'd1.yaml'));

    t.write('letters/l1.md', `---\n${corrupt}---\nBody\n`);
    expect(() => t.store.loadCoverLetters()).toThrow(/letters.l1\.md/);
    fs.rmSync(path.join(t.dir, 'letters', 'l1.md'));

    t.write('corpus/c1.md', `---\n${corrupt}---\nText\n`);
    expect(() => t.store.loadSamples()).toThrow(/corpus.c1\.md/);
  });

  it('still says what YAML objected to, so the line can be found', () => {
    t.write('profile.yaml', corrupt);
    expect(() => t.store.load()).toThrow(/line 2/);
  });
});

describe('a file whose top level is the wrong shape', () => {
  /*
   * The two worst outcomes in the whole store, and they were both silent.
   *
   * `applications.yaml` written as a mapping of id to application — a perfectly
   * reasonable thing for a person or a script to produce — parsed fine, failed
   * `Array.isArray`, and `normalizeApplications` returned `[]`. The tracker came
   * up empty, nothing was raised, and the next save wrote that empty list over
   * the file. Every application, gone, with no error anywhere.
   *
   * `profile.yaml` holding a bare string went the other way: `{...'a string'}`
   * spreads into `{0:'a', 1:' ', 2:'s'…}`, so the profile became a numbered map
   * of single characters and the name became empty.
   *
   * Both now refuse by name. An import that stops and says "applications.yaml
   * should be a list" costs a minute; an import that drops a year of
   * applications costs the year.
   */
  it('refuses a list of applications written as a mapping, rather than losing them all', () => {
    t.write('applications.yaml', 'a1:\n  company: Acme\n  role: Engineer\n  status: applied\n');
    expect(() => t.store.load()).toThrow(/applications\.yaml/);
    expect(() => t.store.load()).toThrow(/list/);
  });

  it('refuses entries, answers and skills written as a mapping', () => {
    for (const rel of ['education.yaml', 'experience.yaml', 'projects.yaml', 'custom.yaml', 'answers.yaml', 'skills.yaml']) {
      t.write(rel, 'some_id:\n  title: A thing\n');
      expect(() => t.store.load(), rel).toThrow(new RegExp(rel.replace('.', '\\.')));
      fs.rmSync(path.join(t.dir, rel));
    }
  });

  it('refuses a profile that is a bare string instead of spreading it letter by letter', () => {
    t.write('profile.yaml', 'Just my name, written straight into the file\n');
    expect(() => t.store.load()).toThrow(/profile\.yaml/);

    t.write('profile.yaml', '- name: Test Person\n');
    expect(() => t.store.load()).toThrow(/profile\.yaml/);
  });

  it('refuses a resume or a draft that is not a mapping', () => {
    t.write('resumes/odd.yaml', 'just a label\n');
    expect(() => t.store.loadResumes()).toThrow(/resumes.odd\.yaml/);
    fs.rmSync(path.join(t.dir, 'resumes', 'odd.yaml'));

    t.write('drafts/odd.yaml', '- a\n- b\n');
    expect(() => t.store.loadDrafts()).toThrow(/drafts.odd\.yaml/);
  });

  /*
   * An empty file and a file holding only `---` are not malformed — they are a
   * file somebody made and has not filled in yet. Those stay the empty thing
   * they are, because refusing to open the store over one is the other kind of
   * unhelpful.
   */
  it('treats an empty file, and a file holding only a document marker, as empty', () => {
    t.write('applications.yaml', '');
    t.write('experience.yaml', '---\n');
    t.write('skills.yaml', '   \n');
    const data = t.store.load();
    expect(data.applications).toEqual([]);
    expect(data.entries).toEqual([]);
    expect(data.skillGroups).toEqual([]);
  });

  /* A resume file that exists and says nothing is still that resume. */
  it('gives an empty resume file the name of its file rather than no name at all', () => {
    t.write('resumes/half-written.yaml', '');
    const spec = t.store.loadResumes().find((r) => r.id === 'half-written');
    expect(spec).toBeDefined();
    expect(spec?.label).toBe('half-written');
  });
});

describe('what a front-matter header is allowed to hold', () => {
  /*
   * A letter's header was rebuilt field by field on the way in, so a key the
   * code did not know about was a key deleted — not on disk immediately, but on
   * the next save, because the editor loads a letter and PUTs back exactly what
   * it was given. Import a letter carrying `sentOn:` or `portal:` from wherever
   * it was written, open it once, and those lines are gone from your file with
   * nothing said.
   *
   * Keys we do not understand are kept. This store is advertised as
   * hand-editable YAML; a person who adds a key to their own file means it.
   */
  it('keeps header keys it does not know about, through a save', () => {
    t.write(
      'letters/l1.md',
      '---\ntitle: Acme letter\ncreatedAt: 2026-01-01\nsentOn: 2026-02-02\nportal: greenhouse\n---\nDear Acme,\n',
    );
    const letter = t.store.loadCoverLetters().find((l) => l.id === 'l1')!;
    expect((letter as unknown as Record<string, unknown>).sentOn).toBe('2026-02-02');
    expect((letter as unknown as Record<string, unknown>).portal).toBe('greenhouse');

    t.store.saveCoverLetter(letter);
    const raw = fs.readFileSync(path.join(t.dir, 'letters', 'l1.md'), 'utf8');
    expect(raw).toContain('sentOn');
    expect(raw).toContain('portal');
  });

  it('keeps them on a writing sample too', () => {
    t.write('corpus/c1.md', '---\ntitle: Old letter\nkind: letter\nsource: my blog\n---\nText.\n');
    const sample = t.store.loadSamples().find((s) => s.id === 'c1')!;
    expect((sample as unknown as Record<string, unknown>).source).toBe('my blog');
    t.store.saveSample(sample);
    expect(fs.readFileSync(path.join(t.dir, 'corpus', 'c1.md'), 'utf8')).toContain('source: my blog');
  });

  /*
   * A header written on Windows.
   *
   * The regex required `---\n` exactly, so a file with CRLF line endings — what
   * anything exported from Word, from a Windows editor, or from a browser
   * download gives you — matched nothing. The whole file, `---` fences
   * included, became the body; the title became the filename; the date and the
   * company were lost. Saving it then wrote a *second* header above the first,
   * and the letter body began with a horizontal rule.
   */
  it('reads a header with Windows line endings as a header', () => {
    t.write('letters/l2.md', '---\r\ntitle: CRLF letter\r\ncompany: Acme Co.\r\n---\r\nDear Acme,\r\n');
    const letter = t.store.loadCoverLetters().find((l) => l.id === 'l2');
    expect(letter?.title).toBe('CRLF letter');
    expect(letter?.company).toBe('Acme Co.');
    expect(letter?.body).not.toContain('---');

    t.store.saveCoverLetter(letter!);
    const raw = fs.readFileSync(path.join(t.dir, 'letters', 'l2.md'), 'utf8');
    expect(raw.match(/^---$/gm)).toHaveLength(2);
  });

  it('reads a sample with Windows line endings the same way', () => {
    t.write('corpus/c2.md', '---\r\ntitle: CRLF sample\r\nkind: answer\r\n---\r\nText.\r\n');
    const sample = t.store.loadSamples().find((s) => s.id === 'c2');
    expect(sample?.title).toBe('CRLF sample');
    expect(sample?.kind).toBe('answer');
  });
});

describe('skills, which nothing used to check the shape of', () => {
  /*
   * `skills.yaml` was the one file read straight out of YAML and handed on with
   * no normalising at all, while a dozen places do `for (const g of
   * data.skillGroups)` and `g.items.join(', ')`. A group written without an
   * `items:` key — the single easiest thing to leave out when typing one by
   * hand — took down the renderer, the matcher, the MCP session and the
   * skills tab with "Cannot read properties of undefined (reading 'length')".
   */
  it('gives a group with no items an empty list rather than a crash downstream', () => {
    t.write('skills.yaml', '- id: g_langs\n  name: Languages\n');
    const groups = t.store.load().skillGroups;
    expect(groups[0]?.items).toEqual([]);
  });

  /*
   * And a group or an item that YAML turned into a number stays printable. A
   * hand-written `text: 2026` is genuinely the number 2026 by YAML's own rules
   * — nothing can recover the quotes that were never typed — but it must at
   * least still be a string by the time something calls `.replace` on it.
   */
  it('makes a value YAML turned into a number printable again', () => {
    t.write('skills.yaml', '- id: 1\n  name: 2026\n  items:\n    - id: 2\n      text: 3.5\n');
    const group = t.store.load().skillGroups[0]!;
    expect(group.id).toBe('1');
    expect(group.name).toBe('2026');
    expect(group.items[0]?.text).toBe('3.5');
  });

  it('drops neither the group nor an unknown key it carries', () => {
    t.write('skills.yaml', '- id: g\n  name: Languages\n  note: keep me\n  items:\n    - id: s\n      text: Go\n');
    const group = t.store.load().skillGroups[0] as SkillGroup & { note?: string };
    expect(group.note).toBe('keep me');
    expect(group.items[0]?.text).toBe('Go');
  });
});

describe('one id in two files', () => {
  /*
   * Entries are split across four files by kind, and `load()` concatenated the
   * four with no dedupe — so one id could reach the app twice and the app then
   * disagreed with itself about which of the two was the entry. `resolveResume`
   * does `entries.find(...)` and took the first; the editor, the inventory and
   * the tailoring prompt walk the list and saw both. A resume copied by hand in
   * a folder the README invites you to hand-edit was therefore listed twice,
   * counted twice in "12 bullets", and printed from whichever copy sorted
   * first.
   */
  it('hands out one entry per id, not one per file it appears in', () => {
    t.write('education.yaml', '- id: dup\n  kind: education\n  title: First\n');
    t.write('projects.yaml', '- id: dup\n  kind: project\n  title: Second\n');
    expect(t.store.load().entries.filter((e) => e.id === 'dup')).toHaveLength(1);
  });

  /*
   * And where the files themselves say which copy is misfiled, that is the one
   * to drop. An entry sitting in projects.yaml while still saying `kind:
   * experience` belongs to experience.yaml by its own account; the copy in the
   * file its kind names is the one every other part of the system assumes it
   * is reading.
   */
  it('believes the copy sitting in the file its own kind names', () => {
    // The stray copy is read first — education.yaml heads the list — and still
    // loses, because it is in a file its kind does not name.
    t.write('education.yaml', '- id: dup\n  kind: experience\n  title: The stray copy\n');
    t.write('experience.yaml', '- id: dup\n  kind: experience\n  title: The filed copy\n');

    const found = t.store.load().entries.filter((e) => e.id === 'dup');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('The filed copy');
  });

  /*
   * What it cannot do, said out loud so nobody reads more into the two tests
   * above than they say.
   *
   * `saveEntry` moves an entry between two files when its kind changes, and
   * nothing makes that pair of writes atomic. If the second fails the entry is
   * in both files — the fresh copy in the file its new kind names, the stale
   * copy in the file its old kind named — and both are correctly filed. No
   * content distinguishes them, so file order decides, and for education
   * becoming a project that means the stale copy wins. The error `saveEntry`
   * threw at the time is the only notice of it; a caller that swallows it
   * leaves a resume rendering from text its editor no longer shows.
   */
  it('cannot tell a stale copy from a fresh one when both are correctly filed', () => {
    t.write('education.yaml', '- id: dup\n  kind: education\n  title: The stale copy\n');
    t.write('projects.yaml', '- id: dup\n  kind: project\n  title: The copy just written\n');
    const found = t.store.load().entries.filter((e) => e.id === 'dup');
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('The stale copy');
  });

  /* Two entries that never had ids are two entries, not one. */
  it('does not fold together entries that simply have no id', () => {
    t.write('custom.yaml', '- kind: custom\n  title: First\n- kind: custom\n  title: Second\n');
    expect(t.store.load().entries).toHaveLength(2);
  });

  /*
   * `saveResume` writes `.yaml`, but `loadResumes` accepted `.yml` too, and
   * both spellings of one id could sit in the folder at once — which of them
   * answered a lookup came down to the order `readdirSync` happened to return.
   * Edits go to `.yaml`, so `.yaml` is the one that is current.
   */
  it('prefers resumes/x.yaml over resumes/x.yml rather than trusting readdir order', () => {
    t.write('resumes/base.yml', 'label: The old spelling\n');
    t.write('resumes/base.yaml', 'label: The one that gets written\n');
    const found = t.store.loadResumes().filter((r) => r.id === 'base');
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe('The one that gets written');
  });
});

describe('variant fields that do not add up', () => {
  /*
   * These three are hand-edit damage that must not be fatal and must not be
   * silently thrown away — the field keeps its key, the resolver warns, and the
   * editor can still show it so a person can repair it. Asserted here so the
   * choice stays a choice rather than drifting.
   */
  it('keeps a field whose variants list is empty', () => {
    t.write('experience.yaml', '- id: e\n  kind: experience\n  title:\n    default: v_1\n    variants: []\n');
    const title = t.store.load().entries[0]?.title as { default: string; variants: unknown[] };
    expect(title.variants).toEqual([]);
    expect(title.default).toBe('v_1');
  });

  it('points a dangling default at a phrasing that exists', () => {
    t.write(
      'experience.yaml',
      '- id: e\n  kind: experience\n  title:\n    default: v_gone\n    variants:\n      - {id: v_1, label: A, text: X}\n',
    );
    const title = t.store.load().entries[0]?.title as { default: string };
    expect(title.default).toBe('v_1');
  });

  it('keeps both of two phrasings that claim one id, rather than dropping one', () => {
    t.write(
      'experience.yaml',
      '- id: e\n  kind: experience\n  title:\n    default: v_1\n    variants:\n      - {id: v_1, label: A, text: First}\n      - {id: v_1, label: B, text: Second}\n',
    );
    const title = t.store.load().entries[0]?.title as { variants: { text: string }[] };
    expect(title.variants.map((v) => v.text)).toEqual(['First', 'Second']);
  });

  /*
   * An anchor and an alias are how somebody writes the same bullet into two
   * entries without typing it twice. YAML hands both entries the same object,
   * and normalising copies it, so a save writes the text out in full in both
   * places. Expanding is the lossless direction — the words are all still there
   * and the two are now independently editable, which is what the editor
   * assumes anyway.
   */
  it('expands an alias into text rather than leaving two entries sharing one object', () => {
    t.write(
      'experience.yaml',
      [
        '- id: exp_a',
        '  kind: experience',
        '  title: Acme',
        '  bullets:',
        '    - &shared',
        '      id: b_1',
        '      default: v_1',
        '      variants: [{id: v_1, label: L, text: "One sentence, written once"}]',
        '- id: exp_b',
        '  kind: experience',
        '  title: Beta',
        '  bullets:',
        '    - *shared',
        '',
      ].join('\n'),
    );
    const [a, b] = t.store.load().entries;
    expect(a?.bullets?.[0]?.variants[0]?.text).toBe('One sentence, written once');
    expect(b?.bullets?.[0]?.variants[0]?.text).toBe('One sentence, written once');
    expect(a?.bullets?.[0]).not.toBe(b?.bullets?.[0]);

    t.store.saveEntry(a!);
    t.store.saveEntry(b!);
    const raw = fs.readFileSync(path.join(t.dir, 'experience.yaml'), 'utf8');
    expect(raw).not.toContain('*shared');
    expect(raw.match(/One sentence/g)).toHaveLength(2);
  });
});

describe('unknown keys elsewhere in the store', () => {
  /*
   * The store is a folder of YAML under git that the README invites people to
   * edit. A key this version does not know about is either a key a later
   * version will, or a note somebody deliberately left for themselves; either
   * way, deleting it on the next save is the one outcome nobody wanted. Kept
   * everywhere, and asserted here because "kept" is only true as long as
   * nothing starts rebuilding these objects field by field.
   */
  it('keeps an unknown key on an entry, a bullet, a variant and an application', () => {
    t.write(
      'experience.yaml',
      [
        '- id: e',
        '  kind: experience',
        '  title: Acme',
        '  myNote: keep the entry key',
        '  bullets:',
        '    - id: b',
        '      myNote: keep the bullet key',
        '      default: v_1',
        '      variants:',
        '        - id: v_1',
        '          label: L',
        '          text: T',
        '          myNote: keep the variant key',
        '',
      ].join('\n'),
    );
    t.write('applications.yaml', '- id: a\n  company: Acme\n  role: Eng\n  status: applied\n  myNote: keep it\n');

    const data = t.store.load();
    const entry = data.entries[0] as Entry & { myNote?: string };
    expect(entry.myNote).toBe('keep the entry key');
    expect((entry.bullets?.[0] as { myNote?: string }).myNote).toBe('keep the bullet key');
    expect((entry.bullets?.[0]?.variants[0] as { myNote?: string }).myNote).toBe('keep the variant key');
    expect((data.applications[0] as { myNote?: string }).myNote).toBe('keep it');

    // And still there after a save, which is where losing them would show.
    t.store.saveEntry(entry);
    t.store.saveApplications(data.applications);
    expect(fs.readFileSync(path.join(t.dir, 'experience.yaml'), 'utf8')).toContain('keep the variant key');
    expect(fs.readFileSync(path.join(t.dir, 'applications.yaml'), 'utf8')).toContain('keep it');
  });
});

describe('a store built from scratch in a temp folder', () => {
  /* The whole load/save/load cycle, once, over a store nothing seeded. */
  it('round-trips everything load() reads', () => {
    const fresh = makeTempStore();
    try {
      const before = fresh.store.load();
      const store = new Store(fresh.dir);
      store.saveProfile(before.profile);
      for (const e of before.entries) store.saveEntry(e);
      store.saveSkillGroups(before.skillGroups);
      store.saveAnswers(before.answers);
      for (const r of before.resumes) store.saveResume(r);
      for (const l of before.coverLetters) store.saveCoverLetter(l);

      const after = store.load();
      expect(after.profile).toEqual(before.profile);
      expect(after.entries).toEqual(before.entries);
      expect(after.skillGroups).toEqual(before.skillGroups);
      expect(after.answers).toEqual(before.answers);
      expect(after.resumes).toEqual(before.resumes);
      expect(after.coverLetters).toEqual(before.coverLetters);
      expect(after.voice).toEqual(before.voice);
    } finally {
      fresh.cleanup();
    }
  });

  /*
   * And the bytes on disk do not move either. YAML.stringify decides for itself
   * whether a scalar needs quoting; if load() were handing back a value of a
   * different type than the one written — a number where a string went in — the
   * second write would quote it differently and this would fail.
   */
  it('writes the same file twice running', () => {
    const fresh = makeTempStore();
    try {
      const names = ['profile.yaml', 'experience.yaml', 'education.yaml', 'projects.yaml', 'skills.yaml', 'answers.yaml'];
      const save = () => {
        const d = fresh.store.load();
        fresh.store.saveProfile(d.profile);
        for (const e of d.entries) fresh.store.saveEntry(e);
        fresh.store.saveSkillGroups(d.skillGroups);
        fresh.store.saveAnswers(d.answers);
      };
      save();
      const first = names.map((n) => fs.readFileSync(path.join(fresh.dir, n), 'utf8'));
      save();
      expect(names.map((n) => fs.readFileSync(path.join(fresh.dir, n), 'utf8'))).toEqual(first);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('what the writer emits, read back by a stricter parser', () => {
  /*
   * A skill called `NO` is written to the file as `text: NO`.
   *
   * That round-trips through this library, which reads YAML 1.2 core, where
   * only `true`/`false` are booleans. It does not round-trip through a YAML 1.1
   * reader — PyYAML, Ruby's psych, Go's gopkg.in/yaml.v2, most CI linters —
   * where `NO`, `Y`, `on` and `off` are all booleans. The store is a git
   * repository people will point other tools at, so this is recorded as a known
   * limit of the format rather than asserted as safe.
   *
   * It is not fixed by quoting everything: that would requote every existing
   * file and make one diff of every store on earth, for a hazard that costs
   * nothing inside this application.
   */
  it('round-trips the YAML 1.1 booleans through its own reader', () => {
    for (const s of ['NO', 'Y', 'on', 'off', 'yes', 'No']) {
      expect(YAML.parse(YAML.stringify({ v: s }, { lineWidth: 0 })).v, s).toBe(s);
    }
  });
});
