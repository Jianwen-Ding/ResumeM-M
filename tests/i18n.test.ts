import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJob, looksLikeCompanyName, looksLikeRoleTitle } from '../src/jobs/extract.js';
import { cleanRole, sameEmployer } from '../src/jobs/names.js';
import { alreadySent, applicationId, findApplication, identity, slug } from '../src/model/applications.js';
import { splitLocation } from '../src/model/autofill.js';
import { resolveResume } from '../src/model/resolve.js';
import { compileResume } from '../src/render/compile.js';
import { tex, unrenderableReason, unsupportedCharacters } from '../src/render/latex.js';
import { DEFAULT_LAYOUT, type Application, type ResolvedResume, type StoreData } from '../src/model/types.js';
import { hasLatex } from './helpers.js';

/*
 * Round 24: a resume and a job search that are not in English.
 *
 * Each case below was measured failing before its fix — a Japanese posting's
 * employer thrown away, one French employer filed as two, a German title's
 * gender tag splitting one job, an invisible character stopping a whole
 * resume — and each is the person doing nothing wrong. The classifier and
 * privacy cases are in the permanent corpora (tests/fixtures/), tagged r24.
 */

const run = promisify(execFile);
const latex = await hasLatex();
const hasPdfToText = await run('pdftotext', ['-v']).then(() => true).catch(() => false);

describe('an employer and a role not written in Latin letters', () => {
  const ld = (title: string, company: string) =>
    `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title,
      hiringOrganization: { '@type': 'Organization', name: company },
    })}</script></head><body><h1>${title}</h1></body></html>`;

  it('keeps them from the posting’s own JSON-LD, in every script', () => {
    for (const [title, company] of [
      ['ソフトウェアエンジニア（新卒）', '株式会社リクルート'],
      ['Стажёр-разработчик Python', 'ООО «Яндекс»'],
      ['Μηχανικός Λογισμικού', 'Εθνική Τράπεζα'],
      ['מהנדס תוכנה', 'צ׳ק פוינט'],
      ['软件工程师', '腾讯'],
    ] as const) {
      expect(looksLikeCompanyName(company), company).toBe(true);
      expect(looksLikeRoleTitle(title), title).toBe(true);
      const job = extractJob(ld(title, company), 'https://example.jp/jobs/12345', title);
      expect(job.company, company).toBe(company);
      expect(job.title, title).toBe(title);
    }
  });

  it('still refuses what is no name in English', () => {
    for (const name of ['Careers', 'Unknown company', 'boards.greenhouse.io', 'Summer 2027', 'US', '12345', '—', 'Inc.']) {
      expect(looksLikeCompanyName(name), name).toBe(false);
    }
    for (const role of ['R-129384', '2027 Summer', 'https://x.example/a?b=c', 'Careers', '404']) {
      expect(looksLikeRoleTitle(role), role).toBe(false);
    }
  });
});

const row = (company: string, role: string, extra: Partial<Application> = {}): Application =>
  ({
    id: applicationId(company, role),
    company,
    role,
    status: 'applied',
    appliedAt: '2026-10-01T00:00:00.000Z',
    url: 'https://careers.example.com/jobs/1',
    ...extra,
  }) as Application;

describe('one employer, with its legal form or without', () => {
  const PAIRS = [
    ['Société Générale S.A.', 'Société Générale'],
    ['Telefónica, S.L.', 'Telefónica'],
    ['Acme GmbH & Co. KG', 'Acme'],
    ['Acme SARL', 'Acme'],
    ['Acme S.r.l.', 'Acme'],
    ['Acme S.p.A.', 'Acme'],
    ['Acme S.A.S.', 'Acme'],
    ['Acme B.V.', 'Acme'],
    ['Acme N.V.', 'Acme'],
    ['Acme e.V.', 'Acme'],
    ['Acme Ltda.', 'Acme'],
    ['Acme KG', 'Acme'],
    ['Acme A/S', 'Acme'],
    ['Acme ApS', 'Acme'],
    ['Acme Oyj', 'Acme'],
    ['株式会社リクルート', 'リクルート'],
    ['リクルート株式会社', 'リクルート'],
    ['(株)リクルート', 'リクルート'],
    ['有限会社リクルート', 'リクルート'],
  ] as const;

  it('reads each pair as one employer', () => {
    for (const [a, b] of PAIRS) expect(sameEmployer(a, b), `${a} ~ ${b}`).toBe(true);
  });

  it('finds the row filed under one spelling from the other', () => {
    for (const [a, b] of PAIRS) {
      expect(findApplication([row(a, 'Werkstudent', { status: 'applying' })], b, 'Werkstudent')?.company, `${a} ~ ${b}`).toBe(a);
    }
  });

  it('keeps a name that is nothing but a legal form, and two companies apart', () => {
    expect(sameEmployer('GmbH', 'Acme')).toBe(false);
    expect(sameEmployer('S.A.', '')).toBe(false);
    expect(sameEmployer('Acme Labs GmbH', 'Acme')).toBe(false);
    expect(sameEmployer('株式会社', 'リクルート')).toBe(false);
  });
});

describe('one job, with a gender tag on its title or without', () => {
  const role = (company: string, r: string) => ({ ...row(company, r), status: 'applying' as const });
  it('reads them as one job, and leaves the tag off the cleaned role', () => {
    for (const [a, b] of [
      ['Werkstudent Softwareentwicklung (m/w/d)', 'Werkstudent Softwareentwicklung'],
      ['Softwareentwickler (w/m/d)', 'Softwareentwickler'],
      ['Softwareentwickler (m/f/d)', 'Softwareentwickler'],
      ['Softwareentwickler (d/m/w)', 'Softwareentwickler'],
      ['Praktikant Data Science (all genders)', 'Praktikant Data Science'],
      ['Praktikant Data Science (gn)', 'Praktikant Data Science'],
      ['Stagiaire Ingénieur Logiciel (H/F)', 'Stagiaire Ingénieur Logiciel'],
      ['Stagiaire Ingénieur Logiciel F/H', 'Stagiaire Ingénieur Logiciel'],
      ['Stagiaire Ingénieur Logiciel H/F', 'Stagiaire Ingénieur Logiciel'],
      ['Softwareentwickler (m/w/d) (Remote)', 'Softwareentwickler'],
      ['Software Engineer (Remote)', 'Software Engineer'],
    ]) {
      expect(identity('Acme GmbH', a!), a).toBe(identity('Acme GmbH', b!));
      expect(findApplication([role('Acme GmbH', a!)], 'Acme GmbH', b!), a).toBeDefined();
      expect(cleanRole(a, 'Acme GmbH'), a).not.toMatch(/m\/w\/d|H\/F|F\/H|genders|\(gn\)|w\/m\/d|m\/f\/d|d\/m\/w/);
    }
  });

  it('leaves a slash that is part of the job alone', () => {
    expect(cleanRole('C/C++ Developer', 'Acme')).toBe('C/C++ Developer');
    expect(cleanRole('A/B Testing Analyst', 'Acme')).toBe('A/B Testing Analyst');
    expect(identity('Acme', 'Software Engineer')).not.toBe(identity('Acme', 'Data Engineer (m/w/d)'));
  });
});

describe('one job, its names composed or decomposed', () => {
  const nfd = (s: string) => s.normalize('NFD');
  it('finds and reads as sent a row whose names were stored the other way', () => {
    const apps = [row(nfd('Société Générale'), nfd('Stagiaire Ingénieur Logiciel'))];
    expect(findApplication(apps, 'Société Générale', 'Stagiaire Ingénieur Logiciel')).toBe(apps[0]);
    expect(alreadySent(apps, 'Société Générale', 'Stagiaire Ingénieur Logiciel', 'https://careers.example.com/jobs/1')).toBe(apps[0]);
    expect(identity('Société Générale', 'Ingénieur')).toBe(identity(nfd('Société Générale'), nfd('Ingénieur')));
  });

  it('slugs accents to their letters, and ASCII as it always did', () => {
    expect(slug('Société Générale')).toBe('societe-generale');
    expect(slug(nfd('Société Générale'))).toBe('societe-generale');
    expect(slug('Acme Corp. — Platform Engineer')).toBe('acme-corp-platform-engineer');
  });

  it('still matches a row whose id was minted under the old slug', () => {
    const old = { ...row('Société Générale', 'Stagiaire'), id: '2026-01-01-soci-t-g-n-rale-stagiaire' };
    expect(findApplication([old], 'Société Générale', 'Stagiaire')).toBe(old);
  });
});

describe('a location written in its own language', () => {
  it('splits into the boxes a form has', () => {
    expect(splitLocation('München, Bayern, Deutschland')).toEqual({ city: 'München', state: 'Bayern', country: 'Deutschland' });
    expect(splitLocation('München, Deutschland')).toEqual({ city: 'München', country: 'Deutschland' });
    expect(splitLocation('São Paulo, SP, Brasil')).toEqual({ city: 'São Paulo', state: 'SP', country: 'Brasil' });
    expect(splitLocation('Madrid, España')).toEqual({ city: 'Madrid', country: 'España' });
    expect(splitLocation('Amsterdam, Nederland')).toEqual({ city: 'Amsterdam', country: 'Nederland' });
    expect(splitLocation('Москва, Россия')).toEqual({ city: 'Москва', country: 'Россия' });
    expect(splitLocation('Zürich, Schweiz')).toEqual({ city: 'Zürich', country: 'Schweiz' });
    expect(splitLocation('Athens, Ελλάδα')).toEqual({ city: 'Athens', country: 'Ελλάδα' });
    expect(splitLocation('東京都渋谷区')).toEqual({ city: '渋谷区', state: '東京都' });
    // And what was right stays right.
    expect(splitLocation('Boston, MA')).toEqual({ city: 'Boston', state: 'MA' });
    expect(splitLocation('Munich, Germany')).toEqual({ city: 'Munich', country: 'Germany' });
    expect(splitLocation('Remote')).toBeUndefined();
  });
});

function resume(over: Partial<ResolvedResume> = {}, bullets: string[] = ['Did the work.']): ResolvedResume {
  return {
    id: 'r',
    label: 'R',
    profile: { name: 'Test Person', email: 'a@b.com' },
    sections: [
      {
        kind: 'experience',
        heading: 'Experience',
        entries: [
          {
            id: 'e',
            kind: 'experience',
            title: 'Engineer',
            subtitle: 'Acme',
            dates: '2024',
            location: 'Boston',
            bullets: bullets.map((text, i) => ({ id: `b${i}`, variantId: 'v', text })),
          },
        ],
        skillGroups: [],
      },
    ],
    layout: { ...DEFAULT_LAYOUT },
    warnings: [],
    ...over,
  } as ResolvedResume;
}

describe('characters nobody can see, and the spaces French typing puts in', () => {
  it('drops the invisible ones and sets the spaces as what they mean', () => {
    expect(tex('pipeline​ for')).toBe('pipeline for');
    expect(tex('LinkedIn⁠ with a BOM﻿')).toBe('LinkedIn with a BOM');
    expect(tex('30 %')).toBe('30\\,\\%');
    expect(tex('10 GB')).toBe('10\\,GB');
    expect(tex('1 000')).toBe('1~000');
    // The soft hyphen is a place a word may break, and stays.
    expect(tex('Soft­ware')).toBe('Soft­ware');
    expect(unrenderableReason(tex('Built a pipeline​ for “quoted” data — fast'))).toBeUndefined();
  });

  it('names an invisible character as one, and the scripts only for a letter', () => {
    const said = unrenderableReason('a b')!;
    expect(said).toContain('an invisible line separator (U+2028)');
    expect(said).not.toContain('Chinese');
    expect(unrenderableReason('ship it 🚀')).not.toContain('Chinese');
    expect(unrenderableReason('张伟')).toContain('Chinese');
  });

  it('accepts the caron vowels of pinyin, ← and №', () => {
    expect(unsupportedCharacters('Ǎ ǎ Ǐ ǐ Ǒ ǒ Ǔ ǔ ← №')).toEqual([]);
  });

  it.runIf(latex)(
    'typesets the three pasted bullets, the caron vowels, ← and №',
    async () => {
      const out = await compileResume(
        resume({}, [
          'Built a pipeline​ for “quoted” data — fast',
          'Cut latency by 30 % on 10 GB inputs',
          'Pasted from LinkedIn⁠ with a word joiner and a BOM﻿',
          'Pinyin Ǎ ǎ Ǐ ǐ Ǒ ǒ Ǔ ǔ, ← and № 12',
        ]),
        { maxAttempts: 1 },
      );
      expect(out.pages).toBeGreaterThan(0);
      expect(out.tex).toContain('30\\,\\%');
    },
    60_000,
  );
});

describe.runIf(latex && hasPdfToText)('names whose letters the text layer read in pieces', () => {
  it('reads back as written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-i18n-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      await compileResume(
        resume({ profile: { name: 'Jānis Bērziņš', email: 'a@b.com' } }, ['Led the Jānis Bērziņš & Đorđe Ķegums team in Rīga']),
        { pdfPath, maxAttempts: 1 },
      );
      const { stdout } = await run('pdftotext', [pdfPath, '-']);
      /*
       * Composed before comparing: the letters T1 has always set (ā, ē, š)
       * come back as a letter and a combining accent, which is the same text.
       * The ones this fixes came back as a different letter and a comma.
       */
      const read = stdout.normalize('NFC');
      expect(read).toContain('Led the Jānis Bērziņš & Đorđe Ķegums team in Rīga');
      expect(read).toContain('Jānis Bērziņš\n');
      expect(read).not.toMatch(/[nk],|ı̄|Ð/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a name written in a script the engine cannot set', () => {
  const store = (name: StoreData['profile']['name']) =>
    ({
      profile: { name, email: 'a@b.com' },
      entries: [],
      skillGroups: [],
      resumes: [{ id: 'base', label: 'Base', sections: [] }],
      config: {},
    }) as unknown as StoreData;

  it('prints a renderable alternate, and says so', () => {
    const r = resolveResume(
      'base',
      store({
        default: 'zh',
        variants: [
          { id: 'zh', label: 'Chinese', text: '张伟' },
          { id: 'latin', label: 'Pinyin', text: 'Zhang Wei' },
        ],
      }),
    );
    expect(r.profile.name).toBe('Zhang Wei');
    expect(r.warnings.join(' ')).toMatch(/Printed the name "Zhang Wei" \(Pinyin\) rather than "张伟"/);
  });

  it('says which field, and what to do, from the fields it is given', () => {
    const name = 'Дмитрий Иванов';
    const said = unrenderableReason(tex(name), 'resume', [{ field: 'profile.name', text: name }, { field: 'profile.email', text: 'a@b.com' }])!;
    expect(said).toContain('in profile.name');
    expect(said).toMatch(/Give your name a Latin spelling in profile\.yaml — or add an alternate name and pin it — and keep the original for forms\.$/);
    const bullet = 'Shipped 🚀';
    expect(unrenderableReason(tex(bullet), 'resume', [bullet, { field: 'profile.name', text: 'Jane' }])).not.toContain('Latin spelling');
  });

  it.runIf(latex)('says which field, and what to do, when there is none', async () => {
    const said = await compileResume(resume({ profile: { name: 'Дмитрий Иванов', email: 'a@b.com' } }), { maxAttempts: 1 }).catch(
      (err: Error) => err.message,
    );
    expect(said).toContain('in profile.name');
    expect(said).toMatch(/Give your name a Latin spelling in profile\.yaml — or add an alternate name and pin it — and keep the original for forms\.$/);
    // Not when the trouble is somewhere else.
    const elsewhere = await compileResume(resume({}, ['Shipped 🚀']), { maxAttempts: 1 }).catch((err: Error) => err.message);
    expect(elsewhere).not.toContain('Latin spelling');
  }, 30_000);
});
