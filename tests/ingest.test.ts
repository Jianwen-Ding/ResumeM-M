import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { extractText, reflow, tidy } from '../src/ingest/text.js';
import { ingestPrompt, readIngestPlan, segment, sortByRules } from '../src/ingest/sort.js';
import { ingestFile } from '../src/ingest/index.js';
import { DEFAULT_CONFIG, type StoreConfig } from '../src/model/types.js';
import { hasLatex } from './helpers.js';

const latex = await hasLatex();

const LETTER = [
  'Dear Streamly,',
  '',
  'I am writing about the software engineering internship. I have spent the last two years building data pipelines and I would like to keep doing that somewhere the data actually matters.',
  '',
  'Sincerely,',
  'Jianwen Ding',
].join('\n');

describe('reading whatever file turns up', () => {
  it('reads plain text as it is', async () => {
    const out = await extractText('notes.txt', Buffer.from(LETTER));
    expect(out.via).toBe('text');
    expect(out.text).toContain('Dear Streamly,');
  });

  it('tidies the ragged whitespace every format produces', () => {
    expect(tidy('a  b \n\n\n\n c \r\n')).toBe('a b\n\nc');
  });

  it('strips html down to its words', async () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Dear Acme,</p><p>I &amp; you.</p></body></html>';
    const out = await extractText('page.html', Buffer.from(html));
    expect(out.via).toBe('html');
    expect(out.text).toBe('Dear Acme,\n\nI & you.');
    expect(out.text).not.toContain('color:red');
  });

  it('reads latex for its prose, not its markup', async () => {
    const tex = '% a comment\n\\documentclass{article}\n\\begin{document}\n\\textbf{Dear Acme,}\n\nI write \\emph{plainly}.\n\\end{document}';
    const out = await extractText('letter.tex', Buffer.from(tex));
    expect(out.text).toContain('Dear Acme,');
    expect(out.text).toContain('I write plainly.');
    expect(out.text).not.toContain('\\textbf');
  });

  it('reads rtf, including its escaped characters', async () => {
    const rtf = String.raw`{\rtf1\ansi\deff0 Dear Acme,\par I am 100\'25 sure.\par}`;
    const out = await extractText('letter.rtf', Buffer.from(rtf));
    expect(out.text).toContain('Dear Acme,');
    expect(out.text).toContain('100% sure');
  });

  it('reads a docx by unzipping the document inside it', async () => {
    const xml = Buffer.from(
      '<w:document><w:body><w:p><w:r><w:t>Dear Acme,</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>I am writing to you &amp; your team.</w:t></w:r></w:p></w:body></w:document>',
    );
    const out = await extractText('letter.docx', makeZip('word/document.xml', xml));
    expect(out.via).toBe('docx');
    expect(out.text).toBe('Dear Acme,\n\nI am writing to you & your team.');
  });

  it('reads a stored, uncompressed docx too', async () => {
    const xml = Buffer.from('<w:p><w:t>Stored, not deflated.</w:t></w:p>');
    const out = await extractText('letter.docx', makeZip('word/document.xml', xml, { store: true }));
    expect(out.text).toBe('Stored, not deflated.');
  });

  it('says so plainly when the zip is not a document', async () => {
    const zip = makeZip('xl/workbook.xml', Buffer.from('<workbook/>'));
    await expect(extractText('book.docx', zip)).rejects.toThrow(/no readable document/);
  });

  it('refuses a binary rather than filing its bytes as writing', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    await expect(extractText('shot.png', bytes)).rejects.toThrow(/not text/);
  });

  it('goes by the bytes when the name says nothing', async () => {
    const out = await extractText('exported', Buffer.from('Dear Acme,\n\nHello.'));
    expect(out.text).toContain('Dear Acme,');
  });

  it('joins the lines a typesetter broke, and keeps the ones a writer broke', () => {
    // The long lines were wrapped to a measure; the short ones ended paragraphs.
    const lines = [
      'Dear Northwind,',
      'Your posting mentions Kafka, which I have run in anger for about eighteen',
      'months, including the week it stopped working entirely.',
      'Sincerely, Jianwen Ding',
    ];
    expect(reflow(lines)).toBe(
      'Dear Northwind,\n\nYour posting mentions Kafka, which I have run in anger for about eighteen months, including the week it stopped working entirely.\n\nSincerely, Jianwen Ding',
    );
  });

  it('gives every bullet its own line, however long the one above ran', () => {
    const lines = [
      '- Built a streaming pipeline that stayed up through two datacentre moves and',
      'a migration.',
      '- Kept the on-call rota honest by fixing what woke people rather than muting it.',
    ];
    expect(reflow(lines).split('\n\n')).toHaveLength(2);
  });

  it('has nothing to say about an empty page', () => {
    expect(reflow([])).toBe('');
    expect(reflow(['', '  '])).toBe('');
  });

  it.skipIf(!latex)('reads a real pdf', { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-pdf-'));
    try {
      fs.writeFileSync(
        path.join(dir, 's.tex'),
        '\\documentclass{article}\\begin{document}\nDear Streamly,\n\nI would like to apply.\n\\end{document}\n',
      );
      compilePdf(dir);
      const out = await extractText('letter.pdf', fs.readFileSync(path.join(dir, 's.pdf')));
      expect(out.via).toBe('pdf');
      expect(out.text).toContain('Dear Streamly,');
      expect(out.text).toContain('I would like to apply.');
      // The page number at the foot is furniture, not writing.
      expect(out.text.trimEnd()).not.toMatch(/\n1$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cutting a file into blocks', () => {
  it('cuts on blank lines', () => {
    const blocks = segment('One paragraph here.\n\nAnother one there.');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.index).toBe(0);
    expect(blocks[1]?.text).toBe('Another one there.');
  });

  it('keeps a heading with the paragraph it introduces', () => {
    const blocks = segment('Why us\n\nBecause the work is interesting and the people are good.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('Why us');
    expect(blocks[0]?.text).toContain('Because the work');
  });

  it('leaves a question standing on its own', () => {
    const blocks = segment('Why do you want to work here?\n\nBecause of the work.');
    expect(blocks).toHaveLength(2);
  });

  it('is unbothered by an empty file', () => {
    expect(segment('')).toEqual([]);
    expect(segment('   \n\n  ')).toEqual([]);
  });
});

describe('sorting blocks without a model', () => {
  it('finds a cover letter from its salutation to its signature', () => {
    const items = sortByRules('old-letters.txt', segment(LETTER));
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('letter');
    expect(items[0]?.text).toContain('Sincerely,');
    expect(items[0]?.text).toContain('Jianwen Ding');
    expect(items[0]?.by).toBe('rules');
    // A label you could find again in a list of thirty, not the opening line.
    expect(items[0]?.title).toBe('Letter to Streamly');
  });

  it('names a letter after the file when it is addressed to nobody', () => {
    const generic = LETTER.replace('Dear Streamly,', 'Dear Hiring Manager,');
    expect(sortByRules('old-letters.txt', segment(generic))[0]?.title).toBe('old-letters — letter');
  });

  it('drops the Q: a notes file puts in front of its questions', () => {
    const text = 'Q: Why us?\n\nBecause the work is interesting and the people seem to mean it.';
    const items = sortByRules('notes.md', segment(text));
    expect(items[0]?.kind).toBe('answer');
    expect(items[0]?.title).toBe('Why us?');
  });

  it('separates two letters in one file', () => {
    const items = sortByRules('letters.txt', segment(`${LETTER}\n\n${LETTER.replace('Streamly', 'Northwind')}`));
    expect(items.filter((i) => i.kind === 'letter')).toHaveLength(2);
    expect(items[0]?.text).toContain('Streamly');
    expect(items[1]?.text).toContain('Northwind');
  });

  it('gives a question the prose underneath it', () => {
    const text = [
      'Why do you want to work here?',
      '',
      'Because the problem is one I have actually hit, and I would rather fix it than complain.',
      '',
      'What is your greatest weakness?',
      '',
      'I take on more than I should, and I have had to learn to say so early rather than late.',
    ].join('\n');

    const items = sortByRules('answers.md', segment(text));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'answer')).toBe(true);
    expect(items[0]?.title).toBe('Why do you want to work here?');
    expect(items[1]?.title).toBe('What is your greatest weakness?');
    expect(items[0]?.text).toContain('rather fix it');
    expect(items[1]?.text).not.toContain('rather fix it');
  });

  it('recognises a resume by its headings', () => {
    const text = 'EXPERIENCE\n\nStreamly — Engineer\n\n- Built a thing that worked.\n- Built another thing that also worked.\n- Kept both of them running.';
    const items = sortByRules('resume.txt', segment(text));
    expect(items[0]?.kind).toBe('resume');
  });

  it('drops a fragment too short to show a voice', () => {
    expect(sortByRules('scrap.txt', segment('Hi.'))).toEqual([]);
  });

  it('files anything it cannot place as other, named after the file', () => {
    const items = sortByRules('thoughts about work.md', segment('A paragraph about nothing in particular, written at length and with feeling.'));
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('other');
  });
});

describe('sorting blocks with a model', () => {
  const blocks = segment(`${LETTER}\n\nWhy us?\n\nBecause I have read the code and I liked it, which is not something I say often.`);

  it('shows the model every block, numbered', () => {
    const prompt = ingestPrompt('letters.txt', blocks);
    expect(prompt).toContain('### Block 0');
    expect(prompt).toContain('Dear Streamly,');
    expect(prompt).toContain('Do not write, rewrite, summarise, or correct');
  });

  it('takes the grouping from the model and the text from the file', () => {
    const reply = JSON.stringify({
      items: [
        { blocks: [0, 1, 2], kind: 'letter', title: 'To Streamly' },
        { blocks: [3, 4], kind: 'answer', title: 'Why us?' },
      ],
    });
    const items = readIngestPlan(reply, 'letters.txt', blocks);
    expect(items.map((i) => i.kind)).toEqual(['letter', 'answer']);
    expect(items[0]?.title).toBe('To Streamly');
    expect(items[0]?.by).toBe('ai');
    expect(items[1]?.text).toContain('I have read the code');
  });

  it('ignores text the model invented, keeping only what the file said', () => {
    const reply = JSON.stringify({
      items: [{ blocks: [0, 1, 2], kind: 'letter', title: 'To Streamly', text: 'I am a synergistic self-starter.' }],
    });
    const items = readIngestPlan(reply, 'letters.txt', blocks);
    expect(items.some((i) => i.text.includes('synergistic'))).toBe(false);
  });

  it('drops block numbers that do not exist', () => {
    const reply = JSON.stringify({ items: [{ blocks: [0, 1, 2, 99, -4], kind: 'letter', title: 'x' }] });
    const items = readIngestPlan(reply, 'letters.txt', blocks);
    expect(items[0]?.blocks).toEqual([0, 1, 2]);
  });

  it('gives a block to whichever group claimed it first', () => {
    const reply = JSON.stringify({
      items: [
        { blocks: [0, 1, 2], kind: 'letter', title: 'First' },
        { blocks: [2, 3, 4], kind: 'answer', title: 'Second' },
      ],
    });
    const items = readIngestPlan(reply, 'letters.txt', blocks);
    expect(items[0]?.blocks).toContain(2);
    expect(items[1]?.blocks).not.toContain(2);
  });

  it('falls back to a sensible kind when the model names one that does not exist', () => {
    const reply = JSON.stringify({ items: [{ blocks: [0, 1, 2], kind: 'manifesto', title: 'x' }] });
    expect(readIngestPlan(reply, 'letters.txt', blocks)[0]?.kind).toBe('other');
  });

  it('picks up whatever the model left behind, so no text is lost', () => {
    const reply = JSON.stringify({ items: [{ blocks: [0, 1, 2], kind: 'letter', title: 'To Streamly' }] });
    const items = readIngestPlan(reply, 'letters.txt', blocks);
    expect(items).toHaveLength(2);
    expect(items[1]?.by).toBe('rules');
    expect(items[1]?.text).toContain('I have read the code');
  });

  it('reads json the CLI wrapped in a code fence and some chatter', () => {
    const reply = 'Sure! Here you go:\n```json\n{"items":[{"blocks":[0,1,2],"kind":"letter","title":"To Streamly"}]}\n```\nHope that helps.';
    expect(readIngestPlan(reply, 'letters.txt', blocks)[0]?.kind).toBe('letter');
  });

  it('shortens a title the model let run away with itself', () => {
    const reply = JSON.stringify({ items: [{ blocks: [0], kind: 'other', title: 'x'.repeat(200) }] });
    const title = readIngestPlan(reply, 'letters.txt', blocks)[0]?.title ?? '';
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('says so when the model did not answer with json at all', () => {
    expect(() => readIngestPlan('I would rather not.', 'letters.txt', blocks)).toThrow(/did not reply with JSON/);
  });

  it('treats a reply with no items as a model that found nothing, and uses the rules', () => {
    const items = readIngestPlan('{"items":[]}', 'letters.txt', blocks);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.by === 'rules')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

/** A minimal zip, so the docx reader is tested against a real archive. */
function makeZip(
  name: string,
  contents: Buffer,
  { store = false, method }: { store?: boolean; method?: number } = {},
): Buffer {
  const how = method ?? (store ? 0 : 8);
  const nameBuf = Buffer.from(name, 'utf8');
  const data = store ? contents : zlib.deflateRawSync(contents);
  const crc = crc32(contents);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x0403_4b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(how, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const localAt = 0;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x0201_4b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(how, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(localAt, 42);

  const centralAt = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralAt, 16);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function compilePdf(dir: string): void {
  for (const [cmd, args] of [
    ['tectonic', ['s.tex']],
    ['latexmk', ['-pdf', '-interaction=nonstopmode', 's.tex']],
    ['pdflatex', ['-interaction=nonstopmode', 's.tex']],
  ] as const) {
    try {
      execFileSync(cmd, [...args], { cwd: dir, stdio: 'ignore' });
      if (fs.existsSync(path.join(dir, 's.pdf'))) return;
    } catch {
      /* try the next engine */
    }
  }
  throw new Error('no LaTeX engine produced a PDF');
}

/* ------------------------------------------------------------------ *
 * The whole job, as both doors call it                                *
 * ------------------------------------------------------------------ */

describe('reading a file and sorting it, in one call', () => {
  const FILE = Buffer.from(
    'Dear Streamly,\n\nI am writing about the internship, having spent two years on pipelines that mostly stayed up.\n\nSincerely,\nJianwen Ding\n',
  );

  /** A stand-in CLI: whatever is passed on argv is what it "replies". */
  const saying = (reply: string): StoreConfig => ({
    ...DEFAULT_CONFIG,
    ai: {
      ...DEFAULT_CONFIG.ai,
      enabled: true,
      command: process.execPath,
      args: ['-e', `process.stdin.resume();process.stdin.on("end",()=>{});process.stdout.write(${JSON.stringify(reply)});process.exit(0)`],
      timeoutMs: 10_000,
    },
  });

  const off: StoreConfig = { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, enabled: false } };

  it('uses the rules when there is no AI to ask', async () => {
    const out = await ingestFile(off, 'letter.txt', FILE);
    expect(out.usedAi).toBe(false);
    expect(out.aiError).toBeUndefined();
    expect(out.items[0]?.by).toBe('rules');
    expect(out.via).toBe('text');
    expect(out.blocks).toBeGreaterThan(0);
  });

  it('uses the AI when there is one, and says that it did', async () => {
    const out = await ingestFile(saying('{"items":[{"blocks":[0,1,2],"kind":"letter","title":"To Streamly"}]}'), 'letter.txt', FILE);
    expect(out.usedAi).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.title).toBe('To Streamly');
    expect(out.items[0]?.by).toBe('ai');
  });

  it('keeps the file when the AI answers with nonsense, and says what happened', async () => {
    const out = await ingestFile(saying('I would rather not.'), 'letter.txt', FILE);
    expect(out.usedAi).toBe(false);
    expect(out.aiError).toMatch(/did not reply with JSON/);
    expect(out.items[0]?.by).toBe('rules');
    expect(out.items[0]?.text).toContain('Sincerely,');
  });

  it('keeps the file when the AI command cannot be run at all', async () => {
    const broken: StoreConfig = {
      ...DEFAULT_CONFIG,
      ai: { ...DEFAULT_CONFIG.ai, enabled: true, command: 'definitely-not-a-command', args: ['{promptText}'], timeoutMs: 5000 },
    };
    const out = await ingestFile(broken, 'letter.txt', FILE);
    expect(out.usedAi).toBe(false);
    expect(out.aiError).toBeTruthy();
    expect(out.items.length).toBeGreaterThan(0);
  });

  it('leaves the AI out when the caller asks it to, however it is configured', async () => {
    const out = await ingestFile(saying('{"items":[]}'), 'letter.txt', FILE, { useAi: false });
    expect(out.usedAi).toBe(false);
    expect(out.aiError).toBeUndefined();
    expect(out.items[0]?.by).toBe('rules');
  });

  it('refuses an empty file, and one with no words in it', async () => {
    await expect(ingestFile(off, 'empty.txt', Buffer.alloc(0))).rejects.toThrow(/nothing in/i);
    await expect(ingestFile(off, 'blank.txt', Buffer.from('  \n\n  '))).rejects.toThrow(/no readable text/);
  });

  it('names the file it could not read, even when it has no name', async () => {
    await expect(ingestFile(off, '', Buffer.alloc(0))).rejects.toThrow(/that file/);
  });
});

describe('files that are not shaped like the examples', () => {
  it('survives a file that ends on a heading with nothing under it', () => {
    const blocks = segment('A paragraph that says something.\n\nAppendix');
    expect(blocks.map((b) => b.text)).toEqual(['A paragraph that says something.', 'Appendix']);
  });

  it('treats a long passage ending in a question mark as prose, not a question', () => {
    // A question is a heading for what follows. A page of prose that happens to
    // end by asking something is not.
    const essay = `${'This is a long reflection on the work. '.repeat(20)}So what did I learn?`;
    const items = sortByRules('essay.md', segment(essay));
    expect(items[0]?.kind).toBe('other');
  });

  it('recognises a resume by its bullets when it has no headings at all', () => {
    const text = [
      '- Built a streaming pipeline that stayed up.',
      '- Raised test coverage from 41% to 88%.',
      '- Onboarded two co-ops and wrote the runbook.',
    ].join('\n');
    expect(sortByRules('bullets.txt', segment(text))[0]?.kind).toBe('resume');
  });

  it('has a name for writing that arrived without a file name', () => {
    const items = sortByRules('', segment('A paragraph of some substance, long enough to be worth keeping.'));
    expect(items[0]?.title).toContain('A paragraph');
    expect(ingestPrompt('', segment('x\n\ny'))).toContain('pasted text');
  });

  it('starts a new letter at the next salutation when the first never signed off', () => {
    const text = 'Dear Streamly,\n\nI would like to apply for the internship you posted.\n\nDear Northwind,\n\nI would like to apply for yours as well.';
    const items = sortByRules('letters.txt', segment(text));
    expect(items).toHaveLength(2);
    expect(items[0]?.text).not.toContain('Northwind');
  });

  it('shows the model an opening, not a whole block, for a long one', () => {
    const long = 'x'.repeat(900);
    const prompt = ingestPrompt('big.txt', segment(long));
    expect(prompt).toContain('(900 chars)');
    expect(prompt).toContain('…');
    expect(prompt).not.toContain('x'.repeat(400));
  });
});

describe('a model that answers badly', () => {
  const blocks = segment('Dear Streamly,\n\nI am applying for the internship, which I would like very much.\n\nSincerely,\nJianwen Ding');

  it('ignores a reply whose items are not a list', () => {
    const items = readIngestPlan('{"items":"all of them"}', 'f.txt', blocks);
    expect(items.every((i) => i.by === 'rules')).toBe(true);
  });

  it('steps over a null or a string where an item should be', () => {
    const reply = '{"items":[null,"letter",{"blocks":[0,1,2],"kind":"letter","title":"To Streamly"}]}';
    expect(readIngestPlan(reply, 'f.txt', blocks)[0]?.by).toBe('ai');
  });

  it('ignores an item that names no blocks it could use', () => {
    const items = readIngestPlan('{"items":[{"kind":"letter","title":"x"},{"blocks":[99],"kind":"letter"}]}', 'f.txt', blocks);
    expect(items.every((i) => i.by === 'rules')).toBe(true);
  });

  it('accepts block numbers written as strings, which models do', () => {
    const items = readIngestPlan('{"items":[{"blocks":["0","1","2"],"kind":"letter","title":"To Streamly"}]}', 'f.txt', blocks);
    expect(items[0]?.by).toBe('ai');
    expect(items[0]?.blocks).toEqual([0, 1, 2]);
  });

  it('falls back to a title of its own when the model sent something that is not one', () => {
    const items = readIngestPlan('{"items":[{"blocks":[0,1,2],"kind":"letter","title":{"a":1}}]}', 'f.txt', blocks);
    expect(items[0]?.title).toBe('Letter to Streamly');
  });

  it('reads the JSON after a code fence that held something else', () => {
    const reply = '```\nnot json at all\n```\n{"items":[{"blocks":[0,1,2],"kind":"letter","title":"To Streamly"}]}';
    expect(readIngestPlan(reply, 'f.txt', blocks)[0]?.by).toBe('ai');
  });
});

describe('the awkward bytes', () => {
  it('decodes numeric character references, decimal and hex', async () => {
    const out = await extractText('page.html', Buffer.from('<p>&#65;&#x42; &nope; &amp;</p>'));
    expect(out.text).toBe('AB &nope; &');
  });

  it('reads a page number off the top of a page as well as the bottom', () => {
    expect(reflow(['Page 2 of 7', 'The text itself.', '3'])).toBe('Page 2 of 7\n\nThe text itself.\n\n3');
  });

  it('refuses a zip that is not a zip', async () => {
    const notAZip = Buffer.concat([Buffer.from('PK'), Buffer.alloc(200, 0x41)]);
    await expect(extractText('broken.docx', notAZip)).rejects.toThrow(/no readable document/);
  });

  /*
   * A 1.2 MB file that unpacks to 1.2 GB. Deflate reaches roughly 1000:1 on
   * repetitive input, so nothing about the size on disk warns you.
   *
   * Uncapped this took 2.5 GB resident before Node happened to refuse the
   * string, and told the user "Cannot create a string longer than 0x1fffffe8
   * characters". Slightly smaller and it would have gone through and simply
   * eaten the machine — in the same process as the editor, so the app goes with
   * it. A corrupt file whose header lies about its contents arrives here too.
   */
  it('refuses a docx that unpacks to far more than a document ever holds', async () => {
    const zip = makeZip('word/document.xml', Buffer.alloc(64 * 1024 * 1024, 0x20));
    expect(zip.length).toBeLessThan(200_000); // tiny on disk, enormous unpacked

    const before = process.memoryUsage().rss;
    await expect(extractText('bomb.docx', zip)).rejects.toThrow(/more than 32 MB|damaged/);
    // Refused rather than absorbed: the cap is the point, not the message.
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  });

  it('still reads a real document of ordinary size', async () => {
    // The cap must not be so eager that a long CV stops working.
    const body = `<w:p><w:t>${'A sentence about the work. '.repeat(20_000)}</w:t></w:p>`;
    const out = await extractText('long.docx', makeZip('word/document.xml', Buffer.from(body)));
    expect(out.text.length).toBeGreaterThan(400_000);
  });

  it('refuses a docx whose entry uses a compression nobody uses', async () => {
    // Method 6 is "imploded": legal in a zip, and not worth carrying a
    // decoder for. Saying so beats pretending the file was empty.
    const zip = makeZip('word/document.xml', Buffer.from('<w:t>hi</w:t>'), { method: 6 });
    await expect(extractText('odd.docx', zip)).rejects.toThrow(/no readable document/);
  });

  it('says "that file" when it was handed bytes with no name', async () => {
    await expect(extractText('', Buffer.from([0, 1, 2, 3]))).rejects.toThrow(/that file/);
  });
});
