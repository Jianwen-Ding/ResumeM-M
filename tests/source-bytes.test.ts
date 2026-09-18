import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Control characters written into source as themselves, rather than escaped.
 *
 * Several places here need a separator that cannot occur in the data being
 * separated — `git log --pretty=format:%H<sep>%aI<sep>%s` and the parse that
 * splits it back apart, a join that turns a list of ids into one comparable
 * key, a name that must be refused. The character is the right choice. Typing
 * it into the file as a raw byte is not.
 *
 * A raw 0x00 or 0x01 in a text file survives only as long as nothing tidies
 * the file up. An editor that strips control characters on save, a copy and
 * paste through anything at all, a merge tool, a linter's formatter: any of
 * them can take it out, and the file still parses, the types still check, and
 * the tests that do not happen to exercise that exact path still pass. What
 * changes is quiet and total — `%H%aI%s` with no separators parses every
 * commit as one field, so the whole version history of a save reads as
 * nonsense, and a join that used to produce `a<NUL>b` now produces `ab`, which
 * collides with the list `ab`.
 *
 * The escape spelling is the same byte to the program and an ordinary six
 * characters to everything that handles the file. There is no reason to spell
 * it the other way, so this says so once for the whole repository rather than
 * waiting to find out which tool does the stripping.
 */
describe('source files hold no raw control characters', () => {
  /* Files that are genuinely binary, and have nothing to do with the rule. */
  const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|otf|zip)$|(^|\/)vendor\//;

  /** Tab, newline and carriage return are text; the rest of C0 is not. */
  const forbidden = (b: number) => b < 0x09 || b === 0x0b || b === 0x0c || (b > 0x0d && b < 0x20);

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), maxBuffer: 32 << 20 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((p) => !BINARY.test(p));

  it('has files to check at all', () => {
    // A test that checks nothing passes forever. This is the one assertion
    // that fails if `git ls-files` ever stops answering here.
    expect(tracked.length).toBeGreaterThan(50);
  });

  it('spells every separator as an escape', () => {
    const offenders: string[] = [];
    for (const file of tracked) {
      const full = path.join(process.cwd(), file);
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
      const bytes = fs.readFileSync(full);
      const where: number[] = [];
      for (let i = 0; i < bytes.length; i++) {
        if (forbidden(bytes[i] as number)) where.push(i);
      }
      if (where.length > 0) {
        const line = bytes.subarray(0, where[0]).toString('utf8').split('\n').length;
        offenders.push(`${file}:${line} — ${where.length} raw control byte(s), first 0x${bytes[where[0] as number]!.toString(16).padStart(2, '0')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
