import type { Bullet, Entry, ResolvedResume, StoreData } from '../model/types.js';

/**
 * The standing instructions that get prepended to every request, so the rules
 * you would otherwise retype into a fresh chat every time live in the repo
 * instead. `voice.md` is yours to edit; everything here is structural.
 */
function preamble(data: StoreData): string {
  const voice = data.voice.trim();
  return [
    'You are helping with a resume and job-search assistant. Follow these rules exactly.',
    '',
    '## Voice',
    voice ||
      '(No voice notes recorded yet. Write plainly, in first person implied — no "I" — with concrete nouns and verbs.)',
    '',
    '## Hard rules',
    '- Never invent experience, employers, dates, technologies, or metrics. Work only from what you are given.',
    '- Never inflate a number. If a claim has no metric, do not add one.',
    '- Match the existing register. Do not make text sound more corporate or more enthusiastic than the source.',
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
export function feedbackPrompt(data: StoreData, resume: ResolvedResume, focus?: string): string {
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
  ]
    .filter(Boolean)
    .join('\n');
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
    'Be conservative. The starting resume is already good; most choices should stay as they are.',
    'Only change a choice when the posting gives a concrete reason — it names a technology, a domain,',
    'or a responsibility that a different existing phrasing addresses more directly.',
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
  priorLetters: string[],
): string {
  return [
    preamble(data),
    '',
    '## Task: draft a cover letter',
    'Draft a cover letter for the posting below, in the voice described above.',
    'Ground every claim in the resume; do not introduce experience that is not there.',
    'Three or four short paragraphs. No "I am writing to express my interest". No restating the resume line by line.',
    '',
    priorLetters.length > 0
      ? `## Previous letters (for voice, not content)\n${priorLetters.slice(0, 3).join('\n\n---\n\n').slice(0, 8000)}`
      : '',
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
  const bank = data.answers
    .map((a) => {
      const v = a.variants.find((x) => x.id === a.default) ?? a.variants[0];
      return v ? `- Q: ${a.question}\n  A: ${v.text}` : '';
    })
    .filter(Boolean);

  return [
    preamble(data),
    '',
    '## Task: answer an application question',
    'Answer the question below in the voice described above.',
    'If one of the previously written answers already covers it, adapt that answer rather than starting over —',
    'staying consistent across applications matters more than novelty.',
    'Keep it to the length the question implies. No filler.',
    '',
    bank.length > 0 ? `## Previously written answers\n${bank.join('\n')}` : '',
    '',
    job ? `## Posting\n${job.company ?? ''} ${job.jobTitle ?? ''}\n${job.jobDescription.slice(0, 4000)}` : '',
    '',
    `## Question\n${question}`,
  ]
    .filter(Boolean)
    .join('\n');
}
