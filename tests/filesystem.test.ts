/**
 * What this code does to files it has never seen before.
 *
 * The parse is somebody else's pass — `tests/serialization.test.ts` covers a
 * store file that will not read. This one is about everything around it: the
 * names that become paths, the folders that may not exist or may not be
 * folders, and the moment a write is half done. The failures collected here
 * are the ones that end with a file the owner cannot get back, or with a file
 * of theirs written by something that had no business naming it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBundle } from '../src/model/applications.js';
import { syncCurrent } from '../src/model/current.js';
import { hasLatex, makeTempStore, type TempStore } from './helpers.js';

const latex = await hasLatex();

let t: TempStore;
const strays: string[] = [];

beforeEach(() => {
  t = makeTempStore();
});
afterEach(() => {
  t.cleanup();
  while (strays.length) fs.rmSync(strays.pop()!, { recursive: true, force: true });
});

/** A folder outside the store, standing in for anything else on the disk. */
function elsewhere(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-not-the-store-'));
  strays.push(dir);
  return dir;
}

describe('an id that is also a path', () => {
  /*
   * An application id is a folder name under `out/applications`, and it is not
   * always one this code made. `buildBundle` prefers the id of the tracker row
   * the job already has — read straight out of applications.yaml, which is
   * hand-editable by design and is written by `POST /api/applications` from a
   * body the browser extension supplies, `id` included.
   *
   * So an id of `../../../..` + somewhere real made that folder the bundle
   * folder. `buildBundle` then deletes every file in it before writing, which
   * is the whole of the damage in one line: point it at a folder of the
   * owner's and rebuilding an application empties it.
   */
  it('cannot make a bundle folder outside the output folder', async () => {
    const theirs = elsewhere();
    fs.writeFileSync(path.join(theirs, 'taxes-2025.pdf'), 'not ours to delete', 'utf8');
    const escape = path.relative(path.join(t.store.outDir(), 'applications'), theirs);

    t.write('applications.yaml', [
      { id: escape, company: 'Acme', role: 'Engineer', status: 'applying' },
    ]);

    // And the message names the row to go and fix, because "that name is not
    // allowed" in front of somebody sending an application names nothing they
    // can see.
    await expect(
      buildBundle(t.store, { company: 'Acme', role: 'Engineer', resumeId: 'base' }),
    ).rejects.toThrow(/Acme[\s\S]*Engineer[\s\S]*tracker/i);

    expect(fs.readdirSync(theirs)).toEqual(['taxes-2025.pdf']);
  });

  /*
   * The other direction, and the reason the first one matters even to somebody
   * who never edits YAML by hand: `snapshotDir` is a path the tracker keeps,
   * and `syncCurrent` copies every file it finds there into `out/current` —
   * a folder this app serves over HTTP, on loopback, to any origin that asks.
   * An id that escapes writes an escaping `snapshotDir`, and from then on the
   * upload folder is a mirror of whatever that folder holds.
   */
  it('does not copy a folder outside the output folder into the upload folder', () => {
    const theirs = elsewhere();
    fs.writeFileSync(path.join(theirs, 'id_rsa'), 'PRIVATE KEY', 'utf8');

    t.write('applications.yaml', [
      {
        id: 'a1',
        company: 'Acme',
        role: 'Engineer',
        status: 'applied',
        snapshotDir: path.relative(t.store.outDir(), theirs),
      },
    ]);

    const folder = syncCurrent(t.store);
    expect(folder.files).toEqual([]);
    expect(fs.existsSync(path.join(folder.dir, 'id_rsa'))).toBe(false);
  });
});

describe('a name that is legal here and nowhere else', () => {
  /*
   * A store is git-backed, and the point of that is being able to clone it —
   * onto the laptop, which is a Mac, or onto the desktop, which is Windows. A
   * name containing `:` or `?`, ending in a dot or a space, or spelled `CON`
   * is a name Windows cannot create at all: `git clone` of a store holding one
   * fails partway, leaving a checkout missing files with an error that names
   * git rather than the resume.
   *
   * Refused when it is made, because that costs a rename of something that
   * does not exist yet, and the alternative costs a store that cannot be
   * cloned and does not say why.
   */
  it('refuses a name a clone onto Windows could not check out', () => {
    for (const id of ['CON', 'nul', 'Acme: Engineer', 'ends with a dot.', 'ends with a space ', 'why?']) {
      expect(() => t.store.saveResume({ id, label: 'x' }), id).toThrow(/name/i);
    }
    expect(fs.readdirSync(path.join(t.dir, 'resumes')).sort()).toEqual([
      'base.yaml',
      'intern.yaml',
      'newgrad.yaml',
    ]);
  });

  /*
   * But only when it is made. Somebody who already has one — from a store
   * written before this check, or from a hand-edit — must still be able to
   * open it, edit it and delete it, because the alternative is a file of
   * theirs that the app can see and refuses to touch.
   */
  it('still lets one that is already there be edited and deleted', () => {
    fs.writeFileSync(path.join(t.dir, 'resumes', 'CON.yaml'), 'label: Already here\n', 'utf8');
    expect(t.store.getResume('CON')?.label).toBe('Already here');

    t.store.saveResume({ id: 'CON', label: 'Edited anyway' });
    expect(t.store.getResume('CON')?.label).toBe('Edited anyway');

    t.store.deleteResume('CON');
    expect(t.exists('resumes/CON.yaml')).toBe(false);
  });

  /*
   * An id with nothing in it made `resumes/.yaml`: a hidden file that
   * `loadResumes` reads, derives an empty id from, and then drops — so it
   * could never be opened, never be edited and never be deleted from the app,
   * while sitting in the folder and in every commit.
   */
  it('refuses an id with no name in it', () => {
    expect(() => t.store.saveResume({ id: '', label: 'x' })).toThrow(/name/i);
    expect(t.exists('resumes/.yaml')).toBe(false);
  });

  it('refuses a null byte by talking about the name', () => {
    // Node throws here on its own, with a message about argument types and a
    // path the user never typed. The name is the thing that is wrong.
    expect(() => t.store.saveResume({ id: 'acme\u0000', label: 'x' })).toThrow(/name/i);
  });

  /*
   * 255 bytes is the limit almost everywhere, and the atomic write used to
   * spend 41 of them on `.<uuid>.tmp` — so a resume whose filename is legal,
   * which loads and renders perfectly, could not be saved. The error was
   * ENAMETOOLONG naming a temp path with a UUID in it, which says nothing
   * about the id the person typed, and the edit was simply lost.
   */
  it('saves a file whose name is long but legal', () => {
    const id = 'senior-staff-software-engineer-'.repeat(7).slice(0, 230);
    t.store.saveResume({ id, label: 'Long but legal' });
    expect(t.store.getResume(id)?.label).toBe('Long but legal');
  });

  it('refuses one no filesystem could hold, and says that is what is wrong', () => {
    // Not ENAMETOOLONG on a path ending in `.<uuid>.tmp`, which is what it
    // was: that names a file the person never typed and does not mention the
    // limit they have run into.
    expect(() => t.store.saveResume({ id: 'x'.repeat(300), label: 'x' })).toThrow(/too long[\s\S]*255/);
    expect(() => t.store.saveResume({ id: 'x'.repeat(300), label: 'x' })).not.toThrow(/tmp/);
  });

  /*
   * A write that cannot happen says which file and which folder. Everything
   * that fails in an atomic write fails on the scratch file, so the error used
   * to name a path with a UUID in it that no longer exists by the time anybody
   * reads the message.
   */
  it.skipIf(process.getuid?.() === 0)('names the file and the folder when a write cannot happen', () => {
    fs.chmodSync(path.join(t.dir, 'resumes'), 0o500);
    try {
      expect(() => t.store.saveResume({ id: 'locked-out', label: 'x' })).toThrow(/locked-out\.yaml[\s\S]*resumes/);
    } finally {
      fs.chmodSync(path.join(t.dir, 'resumes'), 0o700);
    }
  });
});

describe('links and lists that point elsewhere', () => {
  /*
   * A symlink inside the store, pointing out of it — the obvious way to keep
   * one resume in Dropbox, and the obvious way for an import to arrive. The
   * question is what a save does with it: writing *through* the link would put
   * the store's content outside the store and outside git, and would overwrite
   * whatever the link points at.
   *
   * The atomic write settles it by construction — a temp file renamed over the
   * name replaces the link itself — and that is worth a test, because it is a
   * guarantee somebody could undo by making this a plain `writeFileSync` on a
   * quiet afternoon.
   */
  it('replaces a symlink in the store rather than writing through it', () => {
    const theirs = elsewhere();
    const target = path.join(theirs, 'kept-in-dropbox.yaml');
    fs.writeFileSync(target, 'label: Theirs\n', 'utf8');
    fs.symlinkSync(target, path.join(t.dir, 'resumes', 'linked.yaml'));

    expect(t.store.getResume('linked')?.label).toBe('Theirs');
    t.store.saveResume({ id: 'linked', label: 'Saved from the app' });

    expect(fs.readFileSync(target, 'utf8')).toBe('label: Theirs\n');
    expect(fs.lstatSync(path.join(t.dir, 'resumes', 'linked.yaml')).isSymbolicLink()).toBe(false);
    expect(t.store.getResume('linked')?.label).toBe('Saved from the app');
  });

  /*
   * `out/current` deletes what its own manifest says it put there, and that
   * manifest is a JSON file sitting in a folder the user is invited to open,
   * next to the files they are told they may keep in it. Every name in it goes
   * to a recursive delete, so a hand edit or a bad merge that puts a path in
   * there would take a folder nobody meant.
   */
  it('will not follow a path out of the upload folder to delete it', () => {
    const theirs = elsewhere();
    fs.writeFileSync(path.join(theirs, 'keep.txt'), 'mine', 'utf8');

    const dir = path.join(t.store.outDir(), 'current');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.rmm-current.json'),
      JSON.stringify({ files: [path.relative(dir, theirs), '..'] }),
      'utf8',
    );

    syncCurrent(t.store);
    expect(fs.existsSync(path.join(theirs, 'keep.txt'))).toBe(true);
  });
});

describe('a store written on one filesystem and read on another', () => {
  /*
   * macOS stores filenames decomposed: the é a Linux store wrote as one code
   * point comes back from `readdir` as `e` plus a combining acute. Nothing
   * compares equal after that. `loadResumes` takes the id from the filename,
   * so the store held a resume whose id no lookup could match — the editor
   * said "No resume", every variation extending it lost its base, and saving
   * from the editor wrote a *second* file that lists identically beside the
   * first. On a Mac, where the two names are one file, that second write
   * silently replaced a resume the app had just told the user did not exist.
   */
  const composed = 'gérard';
  const decomposed = 'gérard';

  it('finds a resume whose filename is spelled the other way', () => {
    fs.writeFileSync(path.join(t.dir, 'resumes', `${decomposed}.yaml`), 'label: Written on a Mac\n', 'utf8');
    expect(t.store.getResume(composed)?.label).toBe('Written on a Mac');
  });

  it('saves it back into the file it came from, rather than beside it', () => {
    fs.writeFileSync(path.join(t.dir, 'resumes', `${decomposed}.yaml`), 'label: Written on a Mac\n', 'utf8');
    t.store.saveResume({ id: composed, label: 'Edited on Linux' });

    const files = fs.readdirSync(path.join(t.dir, 'resumes')).filter((f) => f.normalize('NFC') === `${composed}.yaml`);
    expect(files).toHaveLength(1);
    expect(t.store.getResume(composed)?.label).toBe('Edited on Linux');
  });

  it('deletes the file that is actually there', () => {
    fs.writeFileSync(path.join(t.dir, 'resumes', `${decomposed}.yaml`), 'label: Written on a Mac\n', 'utf8');
    t.store.deleteResume(composed);
    expect(fs.readdirSync(path.join(t.dir, 'resumes')).some((f) => f.normalize('NFC').startsWith('gé'))).toBe(
      false,
    );
  });
});

describe('a folder that is not a folder', () => {
  /*
   * `corpus` as a file — an import that wrote one, or a hand-made note — took
   * the whole store down with "ENOTDIR: not a directory, scandir '…'", from
   * `store.load()`, which every page calls. The path was in there; what it was
   * for, and what to do about it, were not.
   */
  it('says which folder it is and what it should be', () => {
    fs.writeFileSync(path.join(t.dir, 'corpus'), 'notes I meant to put in a folder', 'utf8');
    expect(() => t.store.load()).toThrow(/corpus[\s\S]*folder/i);
  });

  it('is content for a folder that is simply not there yet', () => {
    const fresh = makeTempStore({ empty: true });
    try {
      expect(fresh.store.loadSamples()).toEqual([]);
      expect(fresh.store.loadDrafts()).toEqual([]);
      // And writing into one creates it rather than throwing.
      fresh.store.saveSample({ id: 's1', title: 'A note', kind: 'other', text: 'Text.', createdAt: '' });
      expect(fresh.store.loadSamples().map((s) => s.id)).toEqual(['s1']);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('a bundle is either the one that was sent or the one being built', () => {
  /*
   * The snapshot is the reason the folder exists: six weeks later, when they
   * ask about the pipeline project, the file that went out is still there.
   *
   * Rebuilding cleared the folder first and compiled afterwards, so any
   * failure between the two — a character the engine cannot set, a store that
   * has lost an entry the spec names, a full disk — left the folder holding
   * `source/` and nothing else. The resume that was actually sent, the cover
   * letter, the plain-text copy of it and the answers: all deleted, by a
   * rebuild that then reported an error about typography.
   */
  it.skipIf(!latex)('keeps what was sent when the rebuild fails', async () => {
    const first = await buildBundle(t.store, {
      company: 'Acme',
      role: 'Engineer',
      resumeId: 'base',
      coverLetter: 'Dear Acme,\n\nHello.\n',
      answers: [{ question: 'Why?', answer: 'Because.' }],
    });
    const sent = fs.readdirSync(first.dir).sort();
    expect(sent).toContain('Test-Person-Resume.pdf');

    // The same resume, now holding a character no LaTeX engine can set.
    t.write('experience.yaml', [{ id: 'exp_acme', kind: 'experience', title: 'Acme \u{1F600} Co.', bullets: [] }]);

    await expect(
      buildBundle(t.store, { company: 'Acme', role: 'Engineer', resumeId: 'base' }),
    ).rejects.toThrow();

    expect(fs.readdirSync(first.dir).sort()).toEqual(sent);
  });

  /*
   * And nothing half-built is ever in the folder the tracker points at, so a
   * crash between the resume and the cover letter cannot be mistaken for an
   * application that was only ever sent a resume.
   */
  it.skipIf(!latex)('leaves no working files behind in the folder it hands over', async () => {
    const built = await buildBundle(t.store, {
      company: 'Acme',
      role: 'Engineer',
      resumeId: 'base',
      coverLetter: 'Dear Acme,\n\nHello.\n',
    });
    expect(fs.readdirSync(built.dir).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(fs.readdirSync(path.dirname(built.dir)).filter((f) => f.startsWith('.'))).toEqual([]);
  });
});

describe('the folder you upload from', () => {
  /*
   * The same argument as the store's own writes, in the folder where it is
   * most visible: `copyFileSync` opens the destination with O_TRUNC, so for
   * the length of the copy the file in the upload folder is short — and the
   * whole purpose of that folder is that a file dialog is open over it. A PDF
   * attached in that window is a truncated PDF, and nothing says so.
   */
  it.skipIf(!latex)('replaces a file rather than emptying and refilling it', async () => {
    await buildBundle(t.store, { company: 'Acme', role: 'Engineer', resumeId: 'base' });
    const folder = syncCurrent(t.store);
    const name = folder.files.find((f) => f.endsWith('.pdf'))!;
    const before = fs.statSync(path.join(folder.dir, name)).ino;

    // The archived copy looks newer, which is what makes the sync copy again.
    const from = path.join(t.store.outDir(), 'applications', fs.readdirSync(path.join(t.store.outDir(), 'applications'))[0]!, name);
    const soon = new Date(Date.now() + 10_000);
    fs.utimesSync(from, soon, soon);

    syncCurrent(t.store);
    expect(fs.statSync(path.join(folder.dir, name)).ino).not.toBe(before);
    expect(fs.readdirSync(folder.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  /*
   * And a file of the user's own that happens to be in the way is not walked
   * over in silence. The folder is documented as the one to point the file
   * picker at, so a folder or a file they made is an ordinary thing to find
   * there — and an EISDIR thrown from the middle of a sync used to take down
   * the whole Applications tab, after the bundle it was reporting had already
   * been written.
   */
  it.skipIf(!latex)('keeps going, and says so, when something is in the way', async () => {
    await buildBundle(t.store, { company: 'Acme', role: 'Engineer', resumeId: 'base' });
    const folder = syncCurrent(t.store);
    const name = folder.files.find((f) => f.endsWith('.pdf'))!;

    // Their own folder, with their name on it, where a file wants to go.
    fs.rmSync(path.join(folder.dir, name));
    fs.mkdirSync(path.join(folder.dir, name));
    fs.writeFileSync(path.join(folder.dir, name, 'mine.txt'), 'mine', 'utf8');
    // The manifest no longer claims it, so it is the user's as far as the sync
    // is concerned.
    fs.writeFileSync(path.join(folder.dir, '.rmm-current.json'), JSON.stringify({ files: [] }), 'utf8');

    const after = syncCurrent(t.store);
    expect(after.problems?.join(' ')).toContain(name);
    expect(fs.existsSync(path.join(folder.dir, name, 'mine.txt'))).toBe(true);
  });
});

describe('where the output folder is', () => {
  /*
   * `output.dir` is a hand-editable setting, and blank is what a half-finished
   * edit leaves. Blank resolved to the store's own parent directory, which
   * made `out/current` a sibling of the save, scattered application folders
   * beside it — and pointed `/pdf/:name`, which serves whatever is in the
   * output folder, at a directory full of the user's unrelated files.
   */
  it('falls back to "out" rather than the folder above the save', () => {
    const blank = makeTempStore({ config: { output: { dir: '  ' }, ai: { enabled: false }, git: { autoCommit: false } } });
    try {
      expect(blank.store.outDir()).toBe(path.resolve(blank.dir, '..', 'out'));
    } finally {
      blank.cleanup();
    }
  });

  it('never resolves to the save folder itself', () => {
    const inside = makeTempStore({
      config: { output: { dir: '.', withinProject: true }, ai: { enabled: false }, git: { autoCommit: false } },
    });
    try {
      expect(inside.store.outDir()).not.toBe(inside.store.root);
      expect(inside.store.outDir().startsWith(inside.store.root + path.sep)).toBe(true);
    } finally {
      inside.cleanup();
    }
  });
});

/*
 * The two limits the path-hardening pass wrote down rather than fixed. Both
 * are about a save surviving something outside its own process: losing power,
 * and being cloned onto a machine whose filesystem has different rules.
 */
describe('a save that outlives the machine it was written on', () => {
  /*
   * The bytes were already durable — the temp file is fsynced before the
   * rename. The rename itself was not: it is a change to the directory, and on
   * ext4 with the usual mount options that entry can still be in flight
   * seconds after `renameSync` returns. Lose power there and the edit is gone
   * while the data sits intact somewhere the directory no longer names.
   *
   * A test cannot pull the plug, so this asserts the thing that is checkable:
   * the directory is opened and fsynced on the way through, and a platform
   * that refuses that — Windows refuses to open a directory at all — does not
   * turn a good save into a failed one.
   */
  it('flushes the directory entry, not only the file contents', () => {
    const t = makeTempStore();
    try {
      const synced: string[] = [];
      const realFsync = fs.fsyncSync;
      const realOpen = fs.openSync;
      const dirs = new Set<number>();
      vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const fd = (realOpen as (...a: never[]) => number)(p as never, ...(rest as never[]));
        if (fs.existsSync(String(p)) && fs.statSync(String(p)).isDirectory()) {
          dirs.add(fd);
          synced.push(String(p));
        }
        return fd;
      }) as typeof fs.openSync);
      vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
        if (dirs.has(fd)) return undefined;
        return (realFsync as (f: number) => void)(fd);
      }) as typeof fs.fsyncSync);

      t.store.saveResume({ id: 'durable', label: 'Durable', sections: [] });
      expect(synced).toContain(path.join(t.dir, 'resumes'));
    } finally {
      vi.restoreAllMocks();
      t.cleanup();
    }
  });

  /*
   * And a write that landed is not a write that failed.
   *
   * The directory flush used to sit inside the same try as the rename, and
   * `fsyncDirectory` re-throws any errno outside its short allow-list. `EIO`
   * is not on it — so a flush failing on a file that was already on disk
   * under its real name came back as "resume.yaml could not be saved to
   * …/resumes — EIO". `withCommit` has no catch, so the commit was skipped
   * with it: the edit on disk, absent from the history, and reported to the
   * person as not saved. They redo work that is already done.
   *
   * What the flush buys is the rename surviving a power cut. Losing that
   * quietly is the smaller harm by a long way.
   */
  it('reports a save that landed as saved, whatever the directory flush says', () => {
    const t = makeTempStore();
    try {
      const realFsync = fs.fsyncSync;
      vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
        let isDir = false;
        try {
          isDir = fs.fstatSync(fd).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          // A failing disk, rather than a platform that will not do this.
          const err = new Error('EIO: i/o error, fsync') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return (realFsync as (f: number) => void)(fd);
      }) as typeof fs.fsyncSync);

      expect(() => t.store.saveResume({ id: 'landed', label: 'Landed', sections: [] })).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      // Read back with the real fsync in place, so this is the file on disk
      // and not the mock agreeing with itself.
      expect(t.store.getResume('landed')?.label).toBe('Landed');
      t.cleanup();
    }
  });

  it('still saves where the platform will not fsync a directory', () => {
    const t = makeTempStore();
    try {
      const realFsync = fs.fsyncSync;
      vi.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
        // As Windows answers for a directory handle.
        let isDir = false;
        try {
          isDir = fs.fstatSync(fd).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          const err = new Error('EPERM: operation not permitted, fsync') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return (realFsync as (f: number) => void)(fd);
      }) as typeof fs.fsyncSync);

      expect(() => t.store.saveResume({ id: 'windows', label: 'Windows', sections: [] })).not.toThrow();
      expect(t.store.getResume('windows')?.label).toBe('Windows');
    } finally {
      vi.restoreAllMocks();
      t.cleanup();
    }
  });

  /*
   * `Acme` and `acme` are two resumes on Linux and one on macOS or Windows, so
   * a save holding both cannot be cloned onto them without losing one. Folding
   * them on read would be worse than the disease — a save under one spelling
   * would then overwrite a genuinely different file on the platform that keeps
   * them apart — so the second name is refused when it is created instead.
   */
  it('refuses a new id that differs from an existing one only in case', () => {
    const t = makeTempStore();
    try {
      t.store.saveResume({ id: 'Acme', label: 'Acme', sections: [] });
      expect(() => t.store.saveResume({ id: 'acme', label: 'acme', sections: [] })).toThrow(/only in capitalisation/i);
      // And the one that was there is untouched.
      expect(t.store.getResume('Acme')?.label).toBe('Acme');
    } finally {
      t.cleanup();
    }
  });

  it('keeps letting you edit the one that already exists', () => {
    const t = makeTempStore();
    try {
      t.store.saveResume({ id: 'Acme', label: 'Acme', sections: [] });
      expect(() => t.store.saveResume({ id: 'Acme', label: 'Acme again', sections: [] })).not.toThrow();
      expect(t.store.getResume('Acme')?.label).toBe('Acme again');
    } finally {
      t.cleanup();
    }
  });

  it('says nothing about ids that differ by more than case', () => {
    const t = makeTempStore();
    try {
      t.store.saveResume({ id: 'acme-grad', label: 'One', sections: [] });
      expect(() => t.store.saveResume({ id: 'acme-staff', label: 'Two', sections: [] })).not.toThrow();
    } finally {
      t.cleanup();
    }
  });
});

/**
 * The flat folder is the app's, and everything else in it is the user's.
 *
 * The delete loop commits to that in as many words — "a name the manifest
 * does not claim belongs to the user, whatever it is" — and then only the
 * directory case was honoured on the way in. A *file* of theirs with a name a
 * bundle also wanted was copied straight over: no warning, nothing in
 * `problems`, and the name then went into the manifest, so the next sync
 * would have deleted it as ours.
 *
 * The folder's own documentation invites people to open it and point an
 * upload dialog at it, and the names it produces are made from the user's own
 * name and the role — so a hand-polished copy of exactly that name is a thing
 * somebody would plausibly keep there.
 */
describe('a file of your own in the upload folder', () => {
  /** One in-flight application whose bundle holds one named file. */
  const filed = (name: string, text = 'the generated one') => {
    const bundle = path.join(t.store.outDir(), 'applications', 'a1');
    fs.mkdirSync(bundle, { recursive: true });
    const file = path.join(bundle, name);
    fs.writeFileSync(file, text, 'utf8');
    /*
     * Dated a moment into the future, because "has this bundle been rebuilt
     * since" is a modification-time comparison and two writes inside one
     * millisecond are indistinguishable to it. A test that races the clock
     * would pass or fail on how fast the machine is.
     */
    const soon = new Date(Date.now() + 2000);
    fs.utimesSync(file, soon, soon);
    t.write('applications.yaml', [
      { id: 'a1', company: 'Acme', role: 'Engineer', status: 'applied', snapshotDir: 'applications/a1' },
    ]);
    return bundle;
  };

  it('is left alone, and said out loud, when a bundle wants its name', () => {
    filed('Test-Person-Resume.pdf');
    // A first sync, so the folder has a manifest and knows what is its own.
    const first = syncCurrent(t.store);
    expect(first.files).toEqual(['Test-Person-Resume.pdf']);

    // Now the user puts one of their own in, under a name nothing claims.
    fs.writeFileSync(path.join(first.dir, 'Jane-Doe-Resume.pdf'), 'MINE', 'utf8');
    // And a rebuild produces exactly that name.
    filed('Jane-Doe-Resume.pdf', 'the generated one');
    t.write('config.yaml', {
      ai: { enabled: false },
      git: { autoCommit: false },
      output: { dir: 'out', fileNames: 'type' },
    });

    const after = syncCurrent(t.store);
    expect(fs.readFileSync(path.join(after.dir, 'Jane-Doe-Resume.pdf'), 'utf8')).toBe('MINE');
    expect(after.files).not.toContain('Jane-Doe-Resume.pdf');
    expect((after.problems ?? []).join(' ')).toMatch(/Jane-Doe-Resume\.pdf[\s\S]*your own/i);
  });

  it('but the folder still refreshes its own files', () => {
    filed('Test-Person-Resume.pdf', 'first');
    const first = syncCurrent(t.store);
    fs.writeFileSync(path.join(first.dir, 'notes-of-mine.txt'), 'MINE', 'utf8');

    filed('Test-Person-Resume.pdf', 'second');
    const after = syncCurrent(t.store);
    expect(after.files).toEqual(['Test-Person-Resume.pdf']);
    expect(fs.readFileSync(path.join(after.dir, 'Test-Person-Resume.pdf'), 'utf8')).toBe('second');
    // And the file nobody claimed is still there, untouched.
    expect(fs.readFileSync(path.join(after.dir, 'notes-of-mine.txt'), 'utf8')).toBe('MINE');
  });

  /*
   * Without a manifest nothing in the folder can be attributed to anybody, so
   * refusing every name would turn a missing file into a folder that has
   * stopped working. The old behaviour is the only safe one there.
   */
  it('writes over what it finds when there is no record of what is its own', () => {
    filed('Test-Person-Resume.pdf', 'the generated one');
    const dir = path.join(t.store.outDir(), 'current');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Test-Person-Resume.pdf'), 'stale', 'utf8');

    const after = syncCurrent(t.store);
    expect(after.files).toEqual(['Test-Person-Resume.pdf']);
    expect(fs.readFileSync(path.join(after.dir, 'Test-Person-Resume.pdf'), 'utf8')).toBe('the generated one');
  });
});

/**
 * The count beside the folder has to be about the folder.
 *
 * `applications` is documented as "In-flight applications whose files are in
 * the folder" and was computed from the tracker alone — every in-flight row
 * with a `snapshotDir` written on it, whether or not that path led anywhere.
 * So an application whose bundle folder the user deleted, or one built under
 * a previous `output.dir` that no longer resolves, was counted as ready while
 * contributing nothing, and nothing named it: the skip was silent and
 * `problems` stayed empty.
 */
describe('an application whose files are not where the tracker says', () => {
  it('is not counted as ready, and is named', () => {
    const bundle = path.join(t.store.outDir(), 'applications', 'a1');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Test-Person-Resume.pdf'), 'here', 'utf8');
    t.write('applications.yaml', [
      { id: 'a1', company: 'Acme', role: 'Engineer', status: 'applied', snapshotDir: 'applications/a1' },
      { id: 'a2', company: 'Zenith', role: 'Platform', status: 'applied', snapshotDir: 'applications/a2-gone' },
    ]);

    const folder = syncCurrent(t.store);

    expect(folder.files).toEqual(['Test-Person-Resume.pdf']);
    expect(folder.applications).toBe(1);
    // Both are in flight; only one has anything here.
    expect(folder.inFlight).toBe(2);
    expect((folder.problems ?? []).join(' ')).toMatch(/Zenith — Platform[\s\S]*not there any more/);
  });

  it('and a path leading out of the output folder is named as that', () => {
    t.write('applications.yaml', [
      { id: 'a1', company: 'Acme', role: 'Engineer', status: 'applied', snapshotDir: '../../../.ssh' },
    ]);

    const folder = syncCurrent(t.store);
    expect(folder.files).toEqual([]);
    expect(folder.applications).toBe(0);
    expect((folder.problems ?? []).join(' ')).toMatch(/Acme — Engineer[\s\S]*outside the output folder/);
  });
});

/*
 * The name on the file somebody is about to upload.
 *
 * One flat folder holds every application in flight, and under the default
 * naming they all want to be called `First-Last-Resume.pdf`. So where two
 * clash, something that tells them apart is added — the role, the company,
 * both, or the id. That part is not optional: the alternative is one
 * application's resume quietly replacing another's in the very folder a
 * portal's file picker is pointed at.
 *
 * What was wrong is that it was added to *all* of them, including the one
 * being uploaded. Reported from a real portal, with two jobs open:
 * `Jianwen-Ding-Resume-2027-Intern-Software-Engineer.pdf`, by somebody whose
 * setting says `type` and who had asked for `Jianwen-Ding-Resume.pdf`. The
 * other application in the folder is not that person's problem at the moment
 * they press upload, and the rule already said as much in its own words —
 * "the person uploading knows what they are applying to, and a longer name is
 * a worse one".
 */
describe('two applications in flight, one upload dialog', () => {
  /** A built bundle for one application, holding one resume. */
  const bundleFor = (id: string, company: string, role: string, name: string) => {
    const dir = path.join(t.store.outDir(), 'applications', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `%PDF ${id}\n`, 'utf8');
    return { id, company, role, status: 'applying' as const, snapshotDir: `applications/${id}` };
  };

  const two = () => {
    t.write('applications.yaml', [
      bundleFor('a1', 'Acme', '2027 Intern Software Engineer', 'Test-Person-Resume.pdf'),
      bundleFor('a2', 'Beta', 'Platform Engineer', 'Test-Person-Resume.pdf'),
    ]);
  };

  it('gives the plain name to the one being worked on', () => {
    two();
    const folder = syncCurrent(t.store, undefined, 'a1');
    expect(folder.files).toContain('Test-Person-Resume.pdf');
    // And the file under that name is that application's, not the other one's.
    expect(fs.readFileSync(path.join(folder.dir, 'Test-Person-Resume.pdf'), 'utf8')).toBe('%PDF a1\n');
  });

  it('and the other one still gets a name of its own', () => {
    two();
    const folder = syncCurrent(t.store, undefined, 'a1');
    const others = folder.files.filter((f) => f !== 'Test-Person-Resume.pdf' && f.endsWith('.pdf'));
    expect(others).toEqual(['Test-Person-Resume-Platform-Engineer.pdf']);
    expect(fs.readFileSync(path.join(folder.dir, others[0]!), 'utf8')).toBe('%PDF a2\n');
  });

  it('the other way round when the other one is the one in hand', () => {
    two();
    const folder = syncCurrent(t.store, undefined, 'a2');
    expect(fs.readFileSync(path.join(folder.dir, 'Test-Person-Resume.pdf'), 'utf8')).toBe('%PDF a2\n');
    expect(folder.files).toContain('Test-Person-Resume-2027-Intern-Software-Engineer.pdf');
  });

  /*
   * With nothing in hand — a listing of the tracker, no upload in progress —
   * every one of them is suffixed, as before. Nothing may take the plain name
   * by default: which of them got it would be whichever the tracker happened
   * to list first.
   */
  it('suffixes all of them when no application is named', () => {
    two();
    const folder = syncCurrent(t.store);
    expect(folder.files).not.toContain('Test-Person-Resume.pdf');
    expect(folder.files.filter((f) => f.endsWith('.pdf')).sort()).toEqual([
      'Test-Person-Resume-2027-Intern-Software-Engineer.pdf',
      'Test-Person-Resume-Platform-Engineer.pdf',
    ]);
  });

  /*
   * And one application on its own is never suffixed, whether or not it is
   * named — which is the ordinary case and the one the short name is for.
   */
  it('one application keeps the short name either way', () => {
    t.write('applications.yaml', [bundleFor('a1', 'Acme', '2027 Intern Software Engineer', 'Test-Person-Resume.pdf')]);
    expect(syncCurrent(t.store).files).toContain('Test-Person-Resume.pdf');
    expect(syncCurrent(t.store, undefined, 'a1').files).toContain('Test-Person-Resume.pdf');
  });

  /*
   * Two applications worked on at once, in two tabs.
   *
   * The plain name went to whichever application was staged last. So tab A
   * staged Acme and its card said "Test-Person-Resume.pdf is ready in
   * out/current"; tab B staged Beta, and the file under that name became
   * Beta's resume — while tab A's card went on naming it, and the upload
   * dialog open over the folder went on offering it for Acme's form. A plain
   * listing of the tracker, or a status change in either tab, then took the
   * name away from both.
   */
  const touched = (app: ReturnType<typeof bundleFor>, at: Date) => ({
    ...app,
    history: [{ at: at.toISOString(), status: 'applying' as const, note: 'Bundle created' }],
  });

  it('does not hand the plain name from one application being worked on to another', () => {
    const now = new Date();
    t.write('applications.yaml', [
      touched(bundleFor('a1', 'Acme', '2027 Intern Software Engineer', 'Test-Person-Resume.pdf'), now),
      touched(bundleFor('a2', 'Beta', 'Platform Engineer', 'Test-Person-Resume.pdf'), now),
    ]);
    const plain = () => fs.readFileSync(path.join(t.store.outDir(), 'current', 'Test-Person-Resume.pdf'), 'utf8');

    // Tab A stages Acme.
    syncCurrent(t.store, undefined, 'a1');
    expect(plain()).toBe('%PDF a1\n');

    // Tab B stages Beta, with Acme still open in tab A.
    const second = syncCurrent(t.store, undefined, 'a2');
    expect(plain()).toBe('%PDF a1\n');
    expect(second.belongsTo['Test-Person-Resume.pdf']).toBe('a1');
    const beta = second.files.filter((f) => second.belongsTo[f] === 'a2');
    expect(beta).toEqual(['Test-Person-Resume-Platform-Engineer.pdf']);
    expect(fs.readFileSync(path.join(second.dir, beta[0]!), 'utf8')).toBe('%PDF a2\n');

    // And a listing, or a status change, renames nothing under either tab.
    const listed = syncCurrent(t.store);
    expect(listed.belongsTo['Test-Person-Resume.pdf']).toBe('a1');
    expect(listed.belongsTo['Test-Person-Resume-Platform-Engineer.pdf']).toBe('a2');
  });

  it('hands it on once the application holding it has gone quiet', () => {
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    t.write('applications.yaml', [
      touched(bundleFor('a1', 'Acme', '2027 Intern Software Engineer', 'Test-Person-Resume.pdf'), hoursAgo),
      touched(bundleFor('a2', 'Beta', 'Platform Engineer', 'Test-Person-Resume.pdf'), new Date()),
    ]);
    syncCurrent(t.store, undefined, 'a1');
    const folder = syncCurrent(t.store, undefined, 'a2');
    expect(fs.readFileSync(path.join(folder.dir, 'Test-Person-Resume.pdf'), 'utf8')).toBe('%PDF a2\n');
  });
});
