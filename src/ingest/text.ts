import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Getting words out of whatever file someone happens to have.
 *
 * The voice corpus is only as good as what is in it, and the friction of
 * getting material in is what keeps it empty: nobody opens a PDF, selects all,
 * and pastes into a text box for the fourth time. So a file — any file they
 * already have — goes in directly, and the work of turning it into text
 * happens here.
 *
 * Deliberately dependency-free apart from the PDF reader already vendored for
 * the preview. A .docx is a zip of XML, and both of those Node can read; adding
 * a library for it would be a dependency to audit for the sake of forty lines.
 */

export interface Extracted {
  text: string;
  /** How it was read, for the UI to say when it was not a plain read. */
  via: 'text' | 'pdf' | 'docx' | 'html' | 'latex';
}

/** File extensions this can read, for the picker's `accept` and for messages. */
export const READABLE = [
  '.txt', '.md', '.markdown', '.text', '.rtf',
  '.pdf', '.docx', '.html', '.htm', '.tex', '.json', '.yaml', '.yml', '.csv',
];

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Collapse the ragged whitespace every one of these formats produces. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Zip, enough of it for a .docx                                       *
 * ------------------------------------------------------------------ */

/*
 * A ceiling on what one zip entry may inflate to.
 *
 * Deflate reaches ratios around 1000:1 on repetitive input, so the size of the
 * file on disk says nothing about the size of it in memory. A 1.2 MB .docx
 * holding a megabyte of spaces took 2.5 GB of resident memory before Node
 * happened to refuse the string, and the user's reward was "Cannot create a
 * string longer than 0x1fffffe8 characters". A slightly smaller one would have
 * succeeded and simply eaten the machine — and this runs in the same process as
 * the editor, so what dies is the app, with whatever was in flight.
 *
 * It does not take malice to get here: any corrupt file whose header lies about
 * its contents lands in the same place. 32 MiB of document.xml is a document of
 * several hundred pages, well past anything this reads for its words.
 */
const MAX_UNZIPPED = 32 * 1024 * 1024;

/**
 * Read one named file out of a zip. Goes by the central directory rather than
 * scanning local headers, because a streamed zip leaves the sizes in the local
 * header at zero and the real ones in a trailing descriptor.
 */
function unzipEntry(buf: Buffer, wanted: string): Buffer | null {
  // The end-of-central-directory record is last, after a comment of unknown
  // length, so it is found by searching backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x0201_4b50) return null;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x0403_4b50) return null;
      const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
      const data = buf.subarray(dataAt, dataAt + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
        } catch (err) {
          // Node reports the cap as ERR_BUFFER_TOO_LARGE, which tells the user
          // nothing about the file they just dropped.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ERR_BUFFER_TOO_LARGE') {
            throw new Error(
              `That file says it holds more than ${Math.round(MAX_UNZIPPED / 1024 / 1024)} MB of ` +
                `text inside ${wanted}. Either it is not really a document, or it is damaged.`,
            );
          }
          throw new Error('That file is damaged — the compressed data inside it does not unpack.');
        }
      }
      return null; // some other compression method; not worth carrying a decoder
    }

    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function fromDocx(buf: Buffer): string {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('That .docx has no readable document inside it');
  const text = xml
    .toString('utf8')
    .replace(/<w:p[ >][^>]*>|<w:p\/?>/g, '\n\n')
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeEntities(text));
}

/* ------------------------------------------------------------------ *
 * The rest                                                            *
 * ------------------------------------------------------------------ */

function fromHtml(raw: string): string {
  const text = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeEntities(text));
}

/**
 * LaTeX, read for its prose. Markup is dropped rather than interpreted: the
 * point is the sentences, and a half-rendered `\textbf` in a writing sample is
 * worse than no markup at all.
 */
function fromLatex(raw: string): string {
  const text = raw
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\(begin|end)\{[^}]*\}/g, '\n\n')
    .replace(/\\item\b/g, '\n- ')
    .replace(/\\\\/g, '\n')
    .replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?/g, '')
    .replace(/[{}$&~^_]/g, '');
  return tidy(text);
}

/** RTF, stripped the same way: control words out, braces out, text kept. */
function fromRtf(raw: string): string {
  const text = raw
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '');
  return tidy(text);
}

/**
 * Undo a PDF's line breaks.
 *
 * A PDF has no paragraphs, only lines that were typeset to a measure, so read
 * naively it comes back wrapped at whatever width the page happened to be.
 * Stored that way it is useless as a writing sample: every sentence looks like
 * it was written in seventy-character bursts.
 *
 * A line that runs to the full measure was broken by the typesetter, so it
 * joins what follows; a line that stops short ended a paragraph, so it does
 * not. That is the whole rule, and it is right often enough on prose — which
 * is what a corpus is made of.
 */
export function reflow(lines: string[]): string {
  const widths = lines.map((l) => l.length).filter((n) => n > 0).sort((a, b) => a - b);
  if (widths.length === 0) return '';
  // The 75th percentile, not the longest: one runaway line should not decide
  // what "full width" means for the page.
  const full = widths[Math.floor(widths.length * 0.75)] ?? 0;
  const runsOn = (line: string) => line.length >= full * 0.85 && !/[.!?:;]$/.test(line);

  const paragraphs: string[] = [];
  let current: string[] = [];
  const end = () => {
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      end();
      continue;
    }
    // A bullet starts its own line whatever came before it.
    if (/^[-•*·]\s/.test(line)) end();
    current.push(line);
    if (!runsOn(line)) end();
  }
  end();

  return paragraphs.join('\n\n');
}

/** "3", "Page 3 of 7" — furniture at the top or bottom of a page, not writing. */
const PAGE_NUMBER = /^(page\s+)?\d+(\s*(of|\/)\s*\d+)?$/i;

function stripRunningHead(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && PAGE_NUMBER.test(out[out.length - 1]!.trim())) out.pop();
  while (out.length && PAGE_NUMBER.test(out[0]!.trim())) out.shift();
  return out;
}

async function fromPdf(buf: Buffer): Promise<string> {
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    pages.push(reflow(stripRunningHead(lines)));
  }
  await doc.destroy();
  return tidy(pages.join('\n\n'));
}

/** Does this look like text a person wrote, or like a binary we cannot read? */
function looksTextual(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  let odd = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) odd++;
  }
  return odd / Math.max(sample.length, 1) < 0.05;
}

/**
 * Read a file for its words. The extension decides how, with a sniff at the
 * bytes as the fallback so an extensionless file someone exported still works.
 */
export async function extractText(name: string, bytes: Buffer): Promise<Extracted> {
  const ext = path.extname(name).toLowerCase();

  if (ext === '.pdf' || bytes.subarray(0, 4).toString('latin1') === '%PDF') {
    return { text: await fromPdf(bytes), via: 'pdf' };
  }
  if (ext === '.docx' || bytes.subarray(0, 2).toString('latin1') === 'PK') {
    return { text: fromDocx(bytes), via: 'docx' };
  }
  if (ext === '.html' || ext === '.htm') return { text: fromHtml(bytes.toString('utf8')), via: 'html' };
  if (ext === '.tex') return { text: fromLatex(bytes.toString('utf8')), via: 'latex' };
  if (ext === '.rtf') return { text: fromRtf(bytes.toString('utf8')), via: 'text' };

  if (!looksTextual(bytes)) {
    throw new Error(
      `Cannot read ${name || 'that file'} — it is not text. Readable: ${READABLE.join(', ')}`,
    );
  }
  return { text: tidy(bytes.toString('utf8')), via: 'text' };
}
