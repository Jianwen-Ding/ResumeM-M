/**
 * Review round 28c: an scp-style remote without a dot for `rmm log remote`,
 * "No. Of course not" as an option, "GPA 3.9,4.0 scale", a phone number after
 * "line" or "code" in a log, and every control character in a remote address.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ErrorLog } from '../src/errorlog/log.js';
import { scrubText } from '../src/errorlog/scrub.js';
import { checkRemoteUrl, RemoteUrlError } from '../src/git/repo.js';
import { isOptionPhrase } from '../src/jobs/answers.js';
import { readGpa } from '../src/model/autofill.js';
import { tempDir } from './helpers.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function rmm(args: string[], env: Record<string, string>) {
  const base = { ...process.env };
  delete base.RMM_ERROR_LOG_DIR;
  delete base.RMM_ERROR_LOG_SETTINGS;
  return run(process.execPath, [path.join(root, 'node_modules/.bin/tsx'), path.join(root, 'src/cli.ts'), ...args], {
    cwd: root,
    timeout: 60_000,
    env: { ...base, ...env },
  });
}

describe('rmm log remote <host>:<path>', () => {
  it('sets the remote for an scp-style address whose host has no dot, or whose path starts with "/"', async () => {
    const home = tempDir('rmm-r28c-home-');
    const dir = path.join(home, 'log');
    const env = { RMM_ERROR_LOG_DIR: dir, HOME: home, RMM_PROJECTS_FILE: path.join(home, 'projects.json'), RMM_DATA: path.join(home, 'no-save') };
    for (const address of ['myserver:repos/log.git', 'localhost:/srv/log.git', 'me@myserver:/srv/log.git']) {
      const { stdout } = await rmm(['log', 'remote', address], env);
      expect(stdout, address).toContain(`pushes to ${address}`);
      expect((await rmm(['log', 'remote'], env)).stdout.trim()).toBe(address);
    }
    expect(await new ErrorLog(dir).list()).toEqual([]);
    // A bare word is still a description.
    const { stdout } = await rmm(['log', 'remote', 'unreachable', '--server', 'http://127.0.0.1:9'], env);
    expect(stdout).toMatch(/Logged to .*-remote-unreachable/);
    expect((await rmm(['log', 'remote'], env)).stdout.trim()).toBe('me@myserver:/srv/log.git');
  }, 90_000);
});

describe('"No" and "of course" as an option', () => {
  it('is an option, and "No. of years" is still a question', () => {
    expect(isOptionPhrase('No. Of course not')).toBe(true);
    expect(isOptionPhrase('No: of course not')).toBe(true);
    expect(isOptionPhrase('No. of years of experience')).toBe(false);
    expect(isOptionPhrase('No: of years in current role')).toBe(false);
    expect(isOptionPhrase('No.of reports')).toBe(false);
  });
});

describe('a grade with its scale after a comma', () => {
  it('reads "GPA 3.9,4.0 scale" as 3.9, and still 3,8 as 3.8 and 3,800 as nothing', () => {
    expect(readGpa('GPA 3.9,4.0 scale')).toBe('3.9');
    expect(readGpa('GPA: 3,8')).toBe('3.8');
    expect(readGpa('GPA 3,8, Dean’s list')).toBe('3.8');
    expect(readGpa('GPA: 3,800')).toBeUndefined();
  });
});

describe('a phone number after a machine word in a log line', () => {
  // 555-01xx: numbers set aside for fiction.
  const PHONE = '6175550134';
  it('is taken out after line, code, status, count and row, and after "phone" a few words before', () => {
    for (const line of [`line ${PHONE}`, `code ${PHONE}`, `status: ${PHONE}`, `count ${PHONE}`, `row ${PHONE}`, `Phone (ID ${PHONE})`, `Phone line ${PHONE}`, `phone, job ${PHONE}`]) {
      expect(scrubText(line), line).not.toContain(PHONE);
    }
  });
  it('keeps a machine id after job, pid, commit, id, build, port and timestamp, and short numbers after line or status', () => {
    for (const line of ['job 4012345678 failed', 'pid 4123456789', 'commit 4123456789', 'id 4123456789', 'build 4123456789', 'port 4123456789', 'timestamp 4123456789', 'error at line 1234', 'status 404', 'exit code 1']) {
      expect(scrubText(line), line).toBe(line);
    }
  });
});

describe('a control character in a remote address', () => {
  it('refuses every C0 control and DEL, not only line breaks and NUL', () => {
    for (const c of ['\0', '\r', '\n', '\x01', '\x08', '\t', '\x1b', '\x1f', '\x7f']) {
      expect(() => checkRemoteUrl(`https://example.invalid/me/${c}log.git`), JSON.stringify(c)).toThrow(RemoteUrlError);
    }
    expect(() => checkRemoteUrl('https://example.invalid/me/log.git')).not.toThrow();
  });
});
