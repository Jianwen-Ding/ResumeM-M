import { buildVoiceContext, renderVoiceContext } from './voice.js';
import { questionSimilarity, relevantLetters } from '../jobs/answers.js';
import type { Bullet, CoverLetter, Entry, ResolvedResume, StoreData } from '../model/types.js';

/**
 * The standing instructions prepended to every request, so the rules you would
 * otherwise retype into a fresh chat live in the repo instead.
 *
 * The voice section is not a description — it is the person's own writing,
 * assembled from their corpus, their sent letters, their past answers, and
 * their resume. Showing a model how someone writes works; telling it does not.
 */
function preamble(data: StoreData): string {
  return [
    'You are helping with a resume and job-search assistant. Follow these rules exactly.',
    '',
    renderVoiceContext(buildVoiceContext(data)),
    '## Hard rules',
    '- Never invent experience, employers, dates, technologies, or metrics. Work only from what you are given.',
    '- Never inflate a number. If a claim has no metric, do not add one.',
    '- Match the register of the writing above. Do not make text sound more corporate or more enthusiastic than it is.',
    '- Output only what the task asks for. No preamble, no sign-off, no restating the task.',
  ].join('\n');
}

/** Render a resume as plain text the model can reason about without LaTeX noise. */
export function resumeAsText(r: ResolvedResume): string {
  const lines: string[] = [`# ${r.profile.name} — ${r.label}`];
  for (const s of r.sections) {
    lines.push('', `## ${s.heading}`);
    for (const g of s.skillGroups) lines.push(`- ${g.name}: ${g.items.join(', ')}`);
    for (const e of s.entries) {
      lines.push(
        `### ${e.title}${e.subtitle ? ` — ${e.subtitle}` : ''}${e.dates ? ` (${e.dates})` : ''} [entry:${e.id}]`,
      );
      for (const b of e.bullets) lines.push(`- ${b.text}  [bullet:${b.id} variant:${b.variantId}]`);
    }
  }
  return lines.join('\n');
}

/**
 * Feedback only. This is deliberately not a rewriting prompt: the point is to
 * get a critique you can act on, not a replacement you have to re-edit back
 * into your own voice.
 */
export interface FeedbackContext {
  focus?: string;
  /** The exact LaTeX that produced the PDF, when it has been compiled. */
  tex?: string;
  /** What the compiler said about fitting the page. */
  fit?: { pages: number; fits: boolean; overflowLines: number; adjustments: string[] };
}

export function feedbackPrompt(data: StoreData, resume: ResolvedResume, context: FeedbackContext | string = {}): string {
  // Older callers passed a focus string.
  const { focus, tex, fit } = typeof context === 'string' ? { focus: context } : context;

  return [
    preamble(data),
    '',
    '## Task: critique, do not rewrite',
    'Give feedback on the resume below. Do NOT produce a rewritten resume or rewritten bullets.',
    'For each point: quote the fragment, say what specifically is weak, and say what would fix it.',
    'Be direct. Skip anything that is already fine — a short list of real problems beats a long list of nits.',
    'Call out in particular: vague verbs, claims with no outcome, duplicated phrasing across bullets,',
    'and anything a reader would not understand without insider context.',
    focus ? `\nThe user specifically wants feedback on: ${focus}` : '',
    '',
    '## Resume',
    resumeAsText(resume),
    '',
    // The rest of the store: other resumes this person keeps, letters they
    // have sent, questions they have answered. Feedback on one resume is
    // better for knowing what else is true about them — a claim that looks
    // thin here may be evidenced at length in a cover letter.
    theRestOfTheStore(data, resume),
    // What actually gets typeset. Anything about length, spacing or what fits
    // is guesswork without it.
    compiledEvidence(tex, fit),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Everything else the person has written, in brief. Not the full text of
 * everything — that would bury the resume being discussed — but enough that
 * the critique is informed by the whole picture rather than one page.
 */
function theRestOfTheStore(data: StoreData, resume: ResolvedResume): string {
  const lines: string[] = ['## What else this person has'];

  const others = data.resumes.filter((r) => r.id !== resume.id);
  if (others.length > 0) {
    lines.push('', `Other resumes they keep: ${others.map((r) => r.label).join('; ')}.`);
  }

  const letters = [...data.coverLetters]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 3);
  if (letters.length > 0) {
    lines.push('', '### Recent cover letters');
    for (const l of letters) {
      lines.push(`- **${l.title}** — ${l.body.replace(/\s+/g, ' ').slice(0, 600)}…`);
    }
  }

  const answers = data.answers.slice(0, 8);
  if (answers.length > 0) {
    lines.push('', '### Questions they have answered');
    for (const a of answers) {
      const text = (a.variants.find((v) => v.id === a.default) ?? a.variants[0])?.text ?? '';
      lines.push(`- **${a.question}** — ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Everything the person has already written for an application, in full.
 *
 * Drafting anything new starts here. The fifteenth "why are you interested in
 * this role" should begin from the fourteenth answer, and the paragraph that
 * explained a career change well in March explains it just as well in
 * September — consistency across a season of applications matters more than
 * novelty, and a reader comparing a letter to an answer should find the same
 * person in both.
 *
 * So this is the full text, not the summary the feedback prompt gets: enough to
 * adapt, not just enough to imitate. What is shown is ranked — the same company
 * first for letters, the most similar question first for answers — and then cut
 * to a budget, because everything is not an option.
 */
const PRIOR_BUDGET = 9000;

export interface PriorWork {
  /** The question being answered, when there is one. Ranks the answer bank. */
  question?: string;
  job?: { company?: string; role?: string };
  /** Letters the caller already picked out; ranked from the store otherwise. */
  letters?: CoverLetter[];
}

function priorWork(data: StoreData, { question, job, letters }: PriorWork): string {
  const chosenLetters = letters ?? relevantLetters(data.coverLetters ?? [], job ?? {}, 3);

  const ranked = [...(data.answers ?? [])];
  if (question) {
    ranked.sort((a, b) => questionSimilarity(question, b.question) - questionSimilarity(question, a.question));
  }

  const letterParts: string[] = [];
  const answerParts: string[] = [];
  let spent = 0;

  // Alternating, so a long letter cannot crowd out every answer: both kinds
  // are useful and they are useful for different reasons.
  for (let i = 0; i < Math.max(chosenLetters.length, ranked.length); i++) {
    for (const which of ['letter', 'answer'] as const) {
      if (spent >= PRIOR_BUDGET) break;

      if (which === 'letter') {
        const letter = chosenLetters[i];
        if (!letter?.body?.trim()) continue;
        const where = [letter.company, letter.role].filter(Boolean).join(' — ') || letter.title;
        const text = clip(letter.body, PRIOR_BUDGET - spent);
        letterParts.push(`### ${where}\n\n${text}`);
        spent += text.length;
        continue;
      }

      const item = ranked[i];
      if (!item) continue;
      // Every phrasing, not just the default: the alternates are exactly the
      // range this person has already found acceptable for that question.
      const texts = item.variants
        .slice(0, 2)
        .map((v) => v.text?.trim())
        .filter(Boolean) as string[];
      if (texts.length === 0) continue;
      const body = texts.map((t) => clip(t, 1500)).join('\n\n— or —\n\n');
      answerParts.push(`### ${item.question}\n\n${clip(body, PRIOR_BUDGET - spent)}`);
      spent += body.length;
    }
  }

  if (letterParts.length === 0 && answerParts.length === 0) return '';

  const out = [
    '## What you have already written',
    '',
    'Their own words, from earlier applications. Where one of these already says',
    'the thing well, adapt it rather than starting over — but only where it is',
    'still true of this posting, and never at the cost of answering what was',
    'actually asked.',
  ];
  if (letterParts.length > 0) out.push('', '### Cover letters they have sent', '', ...letterParts);
  if (answerParts.length > 0) out.push('', '### Questions they have answered', '', ...answerParts);
  return out.join('\n');
}

function clip(text: string, room: number): string {
  const clean = text.trim();
  if (room <= 0) return '';
  // The ellipsis counts against the room, so a clip never exceeds what it was given.
  return clean.length > room ? `${clean.slice(0, room - 1).trimEnd()}…` : clean;
}

/** The LaTeX and the fit report, so layout advice is about the real page. */
function compiledEvidence(tex?: string, fit?: FeedbackContext['fit']): string {
  if (!tex && !fit) return '';
  const lines = ['', '## What it compiles to'];

  if (fit) {
    lines.push(
      '',
      fit.fits
        ? `It fits on ${fit.pages} page(s), with about ${Math.abs(fit.overflowLines)} lines of room to spare.`
        : `It does NOT fit: ${fit.pages} pages, about ${fit.overflowLines} lines too long.`,
      fit.adjustments.length > 0 ? `Auto-fit had to: ${fit.adjustments.join('; ')}.` : '',
    );
  }

  if (tex) {
    lines.push(
      '',
      'The exact LaTeX that produced the PDF follows. Judge spacing, length and layout from this,',
      'not from the plain text above — and remember the reader sees a typeset page, not a list.',
      '',
      '```latex',
      tex.length > 24_000 ? `${tex.slice(0, 24_000)}\n% … truncated` : tex,
      '```',
    );
  }

  return lines.filter(Boolean).join('\n');
}

/** Feedback on one bullet and all of its existing phrasings. */
export function bulletFeedbackPrompt(data: StoreData, entry: Entry, bullet: Bullet): string {
  return [
    preamble(data),
    '',
    '## Task: critique one bullet, do not rewrite',
    `This bullet belongs to "${typeof entry.title === 'string' ? entry.title : entry.id}".`,
    'It already has several phrasings. Say which is strongest and why, and what is weak about each.',
    'Do not produce new phrasings unless asked; this is a critique.',
    '',
    '## Phrasings',
    ...bullet.variants.map((v) => `- [${v.id}] (${v.label}) ${v.text}`),
  ].join('\n');
}

export interface TailorContext {
  jobTitle?: string;
  company?: string;
  jobDescription: string;
  url?: string;
}

/**
 * Asks for a *selection* over what already exists, plus optional new phrasings
 * held separately. Keeping those apart is what makes the flow conservative:
 * choosing among your own sentences can't drift, and anything newly written is
 * quarantined until you look at it.
 */
export function tailorPrompt(data: StoreData, resume: ResolvedResume, job: TailorContext): string {
  const inventory: string[] = [];
  for (const e of data.entries) {
    if (e.archived) continue;
    const title = typeof e.title === 'string' ? e.title : e.id;
    inventory.push(`### ${title} [entry:${e.id}] kind=${e.kind} tags=${(e.tags ?? []).join(',')}`);
    for (const f of ['title', 'dates', 'subtitle', 'location'] as const) {
      const field = e[f];
      if (field && typeof field !== 'string') {
        inventory.push(`  field ${e.id}.${f}:`);
        for (const v of field.variants) {
          inventory.push(`    - [${v.id}] (${v.label}) ${v.text}${v.tags ? ` tags=${v.tags.join(',')}` : ''}`);
        }
      }
    }
    for (const b of e.bullets ?? []) {
      if (b.archived) continue;
      inventory.push(`  bullet ${b.id}:`);
      for (const v of b.variants) {
        inventory.push(`    - [${v.id}] (${v.label}) ${v.text}${v.tags ? ` tags=${v.tags.join(',')}` : ''}`);
      }
    }
  }
  for (const g of data.skillGroups) {
    inventory.push(`### skills group [${g.id}] ${g.name}`);
    for (const i of g.items) inventory.push(`    - [${i.id}] ${i.text} tags=${(i.tags ?? []).join(',')}`);
  }

  return [
    preamble(data),
    '',
    '## Task: choose variants for a specific posting',
    'Pick, from the phrasings that already exist, the set that best fits the posting below.',
    '',
    'You are selecting, not writing. You may not edit this resume. Everything that ends up on the',
    'page must be text this person already wrote, chosen by id from the inventory below. The only',
    'moves available to you are: pick a different existing phrasing, pick which skills to list, and',
    'show or hide an entry or a bullet point. Ids that do not appear below are discarded.',
    '',
    'Be conservative. The starting resume is already good; most choices should stay as they are.',
    'Only change a choice when the posting gives a concrete reason — it names a technology, a domain,',
    'or a responsibility that a different existing phrasing addresses more directly.',
    '',
    'Hiding is for content that is irrelevant to this posting, and is also how you make room when the',
    'resume is close to full. Showing is for work that is in the store but not currently on this',
    'resume, and that the posting specifically calls for. Both are ordinary and both should be rare.',
    '',
    'Separately, you may suggest at most 3 genuinely new phrasings, but only where no existing phrasing',
    'covers something the posting clearly asks for. A new phrasing must describe the same real work as',
    'the bullet it belongs to, with no new claims. If nothing qualifies, return an empty list — that is',
    'the expected answer most of the time.',
    '',
    'Reply with JSON only, matching this shape:',
    '{',
    '  "choices": { "<bulletId or entryId.field>": "<variantId>" },',
    '  "skills": { "<groupId>": ["<itemId>", ...] },',
    '  "enable": ["<entryId or bulletId to show>", ...],',
    '  "disable": ["<entryId or bulletId to hide>", ...],',
    '  "suggestions": [',
    '    { "bulletId": "<id>", "label": "<short label>", "text": "<new phrasing>", "why": "<what in the posting justifies it>" }',
    '  ],',
    '  "reasoning": "<2-4 sentences on what drove the changes>"',
    '}',
    '',
    `## Posting`,
    job.company ? `Company: ${job.company}` : '',
    job.jobTitle ? `Role: ${job.jobTitle}` : '',
    job.url ? `URL: ${job.url}` : '',
    '',
    job.jobDescription.slice(0, 12_000),
    '',
    '## Current resume',
    resumeAsText(resume),
    '',
    '## Everything available in the store',
    inventory.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Ask for N shorter phrasings of specific bullets, to claw back overflow. */
export function shortenPrompt(data: StoreData, bullets: { id: string; text: string }[], linesToCut: number): string {
  return [
    preamble(data),
    '',
    '## Task: propose shorter phrasings',
    `The resume is about ${linesToCut} line(s) too long for one page.`,
    'For the bullets below, propose a tighter phrasing that keeps every concrete claim and metric.',
    'Cut hedges and filler, not content. If a bullet is already tight, say so and skip it.',
    '',
    'Reply with JSON only:',
    '{ "shortened": [ { "bulletId": "<id>", "label": "Short", "text": "<tighter phrasing>" } ] }',
    '',
    '## Bullets',
    ...bullets.map((b) => `- [${b.id}] ${b.text}`),
  ].join('\n');
}

/** Cover letter drafted in the user's voice, grounded in the store. */
export function coverLetterPrompt(
  data: StoreData,
  resume: ResolvedResume,
  job: TailorContext,
  /** Letters the caller judged relevant. Bare text still works. */
  priorLetters: (CoverLetter | string)[],
): string {
  return [
    preamble(data),
    '',
    '## Task: draft a cover letter',
    'Draft a cover letter for the posting below, in the voice described above.',
    'Ground every claim in the resume; do not introduce experience that is not there.',
    'Three or four short paragraphs. No "I am writing to express my interest". No restating the resume line by line.',
    '',
    // Their own letters and answers, in full. A letter that has to be written
    // from nothing every time drifts; one that starts from what was already
    // said well stays recognisably the same person.
    priorWork(data, {
      job: { company: job.company, role: job.jobTitle },
      letters: priorLetters.length > 0
        ? priorLetters.map((l, n) =>
            typeof l === 'string' ? ({ id: `given-${n}`, title: `An earlier letter`, body: l } as CoverLetter) : l,
          )
        : undefined,
    }),
    '',
    '## Posting',
    job.company ? `Company: ${job.company}` : '',
    job.jobTitle ? `Role: ${job.jobTitle}` : '',
    job.jobDescription.slice(0, 8000),
    '',
    '## Resume',
    resumeAsText(resume),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Answer an application question, reusing a previous answer where one fits. */
export function answerPrompt(data: StoreData, question: string, job?: TailorContext): string {
  return [
    preamble(data),
    '',
    '## Task: answer an application question',
    'Answer the question below in the voice described above.',
    'If one of the previously written answers already covers it, adapt that answer rather than starting over —',
    'staying consistent across applications matters more than novelty.',
    'A cover letter below may already say it better than any of the answers do; take it from there if so.',
    'Keep it to the length the question implies. No filler.',
    '',
    // The closest questions first, and the letters that went with this kind of
    // posting — the same material either way, ranked for this question.
    priorWork(data, { question, job: { company: job?.company, role: job?.jobTitle } }),
    '',
    job ? `## Posting\n${job.company ?? ''} ${job.jobTitle ?? ''}\n${job.jobDescription.slice(0, 4000)}` : '',
    '',
    `## Question\n${question}`,
  ]
    .filter(Boolean)
    .join('\n');
}
