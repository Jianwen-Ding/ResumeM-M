import type { StoreData, WritingSample } from '../model/types.js';

/**
 * Conveying a writing voice by describing it is a losing game. People are poor
 * witnesses to their own style, and "plain and direct" means something
 * different to everyone who writes it down. Three paragraphs the person
 * actually wrote convey it exactly.
 *
 * So the voice handed to any AI request is assembled from real material: the
 * corpus they pasted in, the letters they have sent, the answers they have
 * given, and the bullets on their own resume. Notes are still supported, but
 * they are a footnote to the evidence rather than the whole of it.
 */

/** How much sample text to spend. Enough to establish a voice, not a novel. */
const BUDGET = 9000;

export interface VoiceSample {
  kind: WritingSample['kind'];
  title: string;
  text: string;
}

export interface VoiceContext {
  samples: VoiceSample[];
  /** Free-form notes, when the user has written any. */
  notes: string;
  /** Total characters of sample text included. */
  chars: number;
  /** What was available before the budget was applied. */
  available: number;
}

function clean(text: string): string {
  return String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Everything of the user's own writing that the store holds, longest-form
 * first: prose shows voice better than a resume bullet does.
 */
export function collectSamples(data: StoreData): VoiceSample[] {
  const out: VoiceSample[] = [];

  for (const s of data.samples ?? []) {
    if (s.archived) continue;
    const text = clean(s.text);
    if (text.length < 40) continue;
    out.push({ kind: s.kind, title: s.title, text });
  }

  for (const letter of data.coverLetters ?? []) {
    const text = clean(letter.body);
    if (text.length < 40) continue;
    out.push({ kind: 'letter', title: letter.title, text });
  }

  for (const item of data.answers ?? []) {
    for (const v of item.variants) {
      const text = clean(v.text);
      // One-word answers ("No") say nothing about how someone writes.
      if (text.length < 60) continue;
      out.push({ kind: 'answer', title: item.question, text });
    }
  }

  // Resume bullets are terse but they are the register the resume itself is
  // written in, which is exactly what a tailoring request needs to match.
  const bullets: string[] = [];
  for (const entry of data.entries ?? []) {
    for (const bullet of entry.bullets ?? []) {
      for (const v of bullet.variants) {
        const text = clean(v.text);
        if (text.length >= 30) bullets.push(text);
      }
    }
  }
  if (bullets.length > 0) {
    out.push({
      kind: 'resume',
      title: 'Bullets from your resume',
      text: bullets.slice(0, 24).map((b) => `- ${b}`).join('\n'),
    });
  }

  return out;
}

/**
 * Choose what to send, spending the budget across kinds rather than on
 * whichever happens to be longest. A letter, an answer, and some bullets tell
 * a model more than three letters do.
 */
export function buildVoiceContext(data: StoreData): VoiceContext {
  const all = collectSamples(data);
  const available = all.reduce((n, s) => n + s.text.length, 0);

  const byKind = new Map<VoiceSample['kind'], VoiceSample[]>();
  for (const s of all) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }

  // Prose first: it carries the most voice per character.
  const order: VoiceSample['kind'][] = ['letter', 'answer', 'other', 'resume'];
  const chosen: VoiceSample[] = [];
  let spent = 0;

  // Round-robin across kinds so no single kind eats the whole budget.
  for (let round = 0; spent < BUDGET && round < 8; round++) {
    let tookAny = false;
    for (const kind of order) {
      const list = byKind.get(kind);
      const next = list?.[round];
      if (!next) continue;
      tookAny = true;

      const room = BUDGET - spent;
      if (room < 200) break;
      // room - 1 so the ellipsis fits inside the budget rather than past it.
      const text = next.text.length > room ? `${next.text.slice(0, room - 1).trimEnd()}…` : next.text;
      chosen.push({ ...next, text });
      spent += text.length;
      if (spent >= BUDGET) break;
    }
    if (!tookAny) break;
  }

  return { samples: chosen, notes: clean(data.voice), chars: spent, available };
}

const KIND_LABEL: Record<VoiceSample['kind'], string> = {
  letter: 'A cover letter you sent',
  answer: 'An application answer you gave',
  resume: 'Your resume',
  other: 'Something you wrote',
};

/** Render the voice context as the section that leads every prompt. */
export function renderVoiceContext(context: VoiceContext): string {
  const parts: string[] = [];

  if (context.samples.length > 0) {
    parts.push(
      '## How this person writes',
      '',
      'Below is their own writing. Match its register, sentence length, and vocabulary.',
      'Do not describe the style back; just write the way these samples are written.',
      '',
    );
    for (const s of context.samples) {
      parts.push(`### ${KIND_LABEL[s.kind]} — ${s.title}`, '', s.text, '');
    }
  } else {
    parts.push(
      '## How this person writes',
      '',
      '(No samples of their writing are stored yet. Write plainly and concretely, and',
      'avoid anything that sounds like marketing copy.)',
      '',
    );
  }

  if (context.notes) {
    parts.push('## Notes they added themselves', '', context.notes, '');
  }

  return parts.join('\n');
}
