/**
 * Turning a pile of material into a store, as moves.
 *
 * The third session, and the one with the most to gain. Getting started here
 * means having an old resume, three cover letters, a project README and a
 * performance review, and wanting the entries, bullets and alternate wordings
 * that are hiding in them. Today that is `rmm voice add` for the writing and
 * then typing the entries in by hand, which is an evening.
 *
 * ## What it may do, and what it may not
 *
 * This is the one session where the AI writes text that ends up on a resume,
 * so the line has to move rather than disappear — and it moves in exactly one
 * place: everything it proposes is *from the material*, and everything it
 * proposes arrives `suggested`.
 *
 *   - Nothing is written to the store here at all. The session accumulates a
 *     proposal; the person reviews it, entry by entry, and what they accept is
 *     what lands. The same rule as `suggest_wording` on the tailoring side,
 *     applied to a larger unit.
 *   - Every bullet must quote the material it came from. `source` is required,
 *     not optional, and is checked against the documents that were actually
 *     supplied — which is the difference between "read my resume and enter it"
 *     and "write me a resume".
 *
 * A model that has to point at the sentence it is paraphrasing cannot invent
 * a job. That is the whole mechanism, and it is cheap: the material is right
 * there, so quoting it costs nothing when the claim is real.
 */

import type { EntryKind, MoveResult } from './authoring-types.js';

const ok = (text: string): MoveResult => ({ ok: true, text });
const no = (text: string): MoveResult => ({ ok: false, text });

/** One file the user handed over, as text. */
export interface SourceDocument {
  id: string;
  /** What it is called, for the model to refer to. */
  name: string;
  /** What this file appears to be: a resume, a letter, a README, notes. */
  kind?: string;
  text: string;
}

export interface ProposedBullet {
  /** A short label for the wording, as the store uses. */
  label: string;
  text: string;
  /** The sentence in the material this came from. Required. */
  source: string;
  /** Which document that sentence is in. Absent means the entry's own. */
  documentId?: string;
  tags?: string[];
}

export interface ProposedEntry {
  /** Suggested id; the person may rename it when they accept it. */
  id: string;
  kind: EntryKind;
  title: string;
  subtitle?: string;
  dates?: string;
  location?: string;
  bullets: ProposedBullet[];
  /** Which document this entry was read out of. */
  documentId: string;
}

export interface AuthoringState {
  entries: ProposedEntry[];
  /** Alternate wordings for bullets that already exist in the store. */
  alternates: { bulletId: string; label: string; text: string; source: string; documentId: string }[];
  /** Skills found in the material, for groups that already exist. */
  skills: { groupId: string; text: string; source: string }[];
  /**
   * A better order for the lines of an entry that already exists.
   *
   * The master document decides what order the lines inside an entry come
   * in, and every resume that has not arranged its own follows it — so this
   * is one proposal that moves every document at once, which is exactly why
   * it is a proposal and not a write. It also needs no quotation, because it
   * invents no text: the lines are already the person's own, and all that is
   * being suggested is which of them a reader meets first.
   */
  orders: { entryId: string; bullets: string[]; why: string }[];
  notes: string;
  finished: boolean;
}

export const emptyAuthoring = (): AuthoringState => ({
  entries: [],
  alternates: [],
  skills: [],
  orders: [],
  notes: '',
  finished: false,
});

const KINDS: EntryKind[] = ['education', 'experience', 'project', 'custom'];

/** A list, cut off before it becomes noise. */
function some(ids: string[], limit = 12): string {
  if (ids.length === 0) return 'none';
  return ids.length <= limit ? ids.join(', ') : `${ids.slice(0, limit).join(', ')} … and ${ids.length - limit} more`;
}

/**
 * Normalised for comparing a quote against a document.
 *
 * A model asked to quote will re-type, and re-typing turns a straight
 * apostrophe curly, collapses two spaces, and drops a line break. Comparing
 * raw text would fail on all three and teach it that quoting does not work,
 * which is the opposite of what this is for.
 */
function flatten(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class AuthoringSession {
  readonly state: AuthoringState = emptyAuthoring();

  private readonly docs = new Map<string, SourceDocument>();

  constructor(
    readonly documents: SourceDocument[],
    /** Ids already in the store, so a proposal cannot collide with one. */
    readonly existing: {
      entryIds: string[];
      bulletIds: string[];
      skillGroups: { id: string; name: string }[];
      /** Each entry's lines, in the order the master holds them. */
      bulletsByEntry?: Record<string, string[]>;
    },
  ) {
    for (const doc of documents) this.docs.set(doc.id, doc);
  }

  /* ---------------------------------------------------------------- *
   * Reading                                                           *
   * ---------------------------------------------------------------- */

  listDocuments(): string {
    if (this.documents.length === 0) return 'Nothing was supplied.';
    return this.documents
      .map((d) => `- [${d.id}] ${d.name}${d.kind ? ` — ${d.kind}` : ''} (${d.text.length} characters)`)
      .join('\n');
  }

  readDocument(id: string, from = 0, room = 20_000): MoveResult {
    const doc = this.docs.get(id);
    if (!doc) return no(`There is no document "${id}". The documents are: ${some([...this.docs.keys()])}.`);
    const start = Math.max(0, Math.floor(from));
    const slice = doc.text.slice(start, start + Math.max(1000, Math.min(room, 40_000)));
    const more = start + slice.length < doc.text.length;
    return ok(
      `${doc.name}, characters ${start}–${start + slice.length} of ${doc.text.length}\n\n${slice}` +
        (more ? `\n\n(there is more: call read_document again with from=${start + slice.length})` : ''),
    );
  }

  describeStore(): string {
    return [
      `Entries already in the store: ${some(this.existing.entryIds)}`,
      `Bullets already in the store: ${some(this.existing.bulletIds)}`,
      `Skill groups: ${this.existing.skillGroups.map((g) => `[${g.id}] ${g.name}`).join(', ') || 'none'}`,
      '',
      'Do not propose an entry for something that is already here. Where the material says the same',
      'thing in a better way, propose an alternate wording on the bullet that already exists instead.',
    ].join('\n');
  }

  /* ---------------------------------------------------------------- *
   * Proposing                                                         *
   * ---------------------------------------------------------------- */

  /**
   * Every proposal is checked against the material it claims to come from.
   *
   * Not a formality. A model that has to point at the sentence it is
   * paraphrasing cannot invent a job, and the check is what makes the
   * requirement real rather than a line in a prompt that is sometimes
   * followed.
   */
  private quoted(documentId: string, source: string, least = 12): MoveResult | null {
    const doc = this.docs.get(documentId);
    if (!doc) return no(`There is no document "${documentId}". The documents are: ${some([...this.docs.keys()])}.`);
    const quote = flatten(source);
    if (quote.length < least) {
      return no('The quote is too short to check. Give the sentence from the material that this comes from.');
    }
    if (!flatten(doc.text).includes(quote)) {
      return no(
        `That quote is not in ${doc.name}. Every bullet has to come from something in the material — quote the ` +
          `sentence it is a rewording of, exactly as it appears. If nothing in the material says it, it does not ` +
          `go in: this is reading what they wrote, not writing it for them.`,
      );
    }
    return null;
  }

  proposeEntry(entry: Omit<ProposedEntry, 'bullets'> & { bullets?: ProposedBullet[] }): MoveResult {
    if (!KINDS.includes(entry.kind)) return no(`"${entry.kind}" is not a kind of entry. They are: ${KINDS.join(', ')}.`);
    if (!entry.title?.trim()) return no('An entry needs a title — the employer, the school, or the project’s name.');
    if (!entry.id?.trim()) return no('An entry needs an id, like exp_acme or proj_ingest.');
    /*
     * Ids are used as keys elsewhere — `entryId.field` in a resume's choices,
     * split on the first dot — so one with a dot, a slash or a space in it is
     * an id that half the store cannot address. Refused here rather than
     * quietly rewritten, because a model that is told will use a real one and
     * a model that is corrected will keep sending the same thing.
     */
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(entry.id.trim())) {
      return no(
        `"${entry.id}" will not work as an id: use letters, digits, hyphens and underscores only, ` +
          `like exp_vega or proj-ingest. Dots and spaces are used to address fields elsewhere.`,
      );
    }
    if (this.existing.entryIds.includes(entry.id)) {
      return no(`There is already an entry called "${entry.id}" in the store. Choose another id, or propose an alternate wording on its bullets instead.`);
    }
    if (this.state.entries.some((e) => e.id === entry.id)) {
      return no(`You have already proposed "${entry.id}". Add bullets to it with propose_bullet.`);
    }
    /*
     * The title is a name, not a quotation, so it is held to a name's
     * standard: it has to appear in the document, and "Google" is three
     * letters. Holding it to the twelve a bullet's quote needs would refuse
     * every real employer with a short name — which is most of them.
     */
    const bad = this.quoted(entry.documentId, entry.title, 3);
    if (bad) {
      return bad.text.includes('too short')
        ? no('An entry needs a title long enough to look for in the material.')
        : bad;
    }

    // Trimmed, because the id was validated trimmed: accepting " exp_acme"
    // and then storing it with the space makes an id nothing else can address.
    const id = entry.id.trim();
    this.state.entries.push({ ...entry, id, title: entry.title.trim(), bullets: [] });
    return ok(`Proposed ${entry.kind} entry [${id}] ${entry.title.trim()}. Add its bullets with propose_bullet.`);
  }

  proposeBullet(entryId: string, bullet: ProposedBullet): MoveResult {
    const entry = this.state.entries.find((e) => e.id === entryId);
    if (!entry) {
      return no(
        `You have not proposed an entry called "${entryId}". Proposed so far: ` +
          `${some(this.state.entries.map((e) => e.id))}.`,
      );
    }
    if (!bullet.text?.trim()) return no('A bullet needs text.');
    const bad = this.quoted(bullet.documentId ?? entry.documentId, bullet.source ?? '');
    if (bad) return bad;

    entry.bullets.push({ ...bullet, documentId: bullet.documentId ?? entry.documentId, label: bullet.label?.trim() || 'From your material' });
    return ok(`Added to [${entryId}]: ${bullet.text.trim()}`);
  }

  /** Another way of saying a line the store already has. */
  proposeAlternate(bulletId: string, label: string, text: string, source: string, documentId: string): MoveResult {
    if (!this.existing.bulletIds.includes(bulletId)) {
      return no(`There is no bullet "${bulletId}" in the store. Bullets: ${some(this.existing.bulletIds)}.`);
    }
    if (!text?.trim()) return no('An alternate wording needs text.');
    const bad = this.quoted(documentId, source);
    if (bad) return bad;
    this.state.alternates.push({ bulletId, label: label?.trim() || 'From your material', text: text.trim(), source, documentId });
    return ok(`Proposed another wording for ${bulletId}.`);
  }

  proposeSkill(groupId: string, text: string, source: string, documentId: string): MoveResult {
    const group = this.existing.skillGroups.find((g) => g.id === groupId);
    if (!group) {
      return no(`There is no skills group "${groupId}". Groups: ${this.existing.skillGroups.map((g) => g.id).join(', ') || 'none'}.`);
    }
    if (!text?.trim()) return no('A skill needs text.');
    const bad = this.quoted(documentId, source);
    if (bad) return bad;
    this.state.skills.push({ groupId, text: text.trim(), source });
    return ok(`Proposed "${text.trim()}" under ${group.name}.`);
  }

  /**
   * A better order for the lines of an entry that is already in the store.
   *
   * No quotation is required, and that is not an oversight: everything else
   * here puts words on a resume and has to point at the material they came
   * from, while this puts no words anywhere. The lines are already the
   * person's own and already accepted; the only claim being made is about
   * which one a reader should meet first.
   *
   * Naming only what moves is deliberate, and matches the tailoring tool of
   * the same shape: anything left out keeps its place behind what was named,
   * so a line cannot be lost by being forgotten.
   */
  proposeOrder(entryId: string, bullets: string[], why: string): MoveResult {
    if (!this.existing.entryIds.includes(entryId)) {
      return no(`There is no entry "${entryId}" in the store. Entries: ${some(this.existing.entryIds)}.`);
    }
    const mine = this.existing.bulletsByEntry?.[entryId];
    if (!mine || mine.length === 0) {
      return no(`"${entryId}" has no lines to put in order.`);
    }
    const named = [...new Set((bullets ?? []).filter((id) => mine.includes(id)))];
    const strangers = (bullets ?? []).filter((id) => !mine.includes(id));
    if (named.length === 0) {
      return no(`None of those are lines of ${entryId}. Its lines are: ${some(mine)}.`);
    }
    const rest = mine.filter((id) => !named.includes(id));
    const wanted = [...named, ...rest];
    if (wanted.every((id, i) => id === mine[i])) {
      return no(`That is the order ${entryId} is already in, so there is nothing to propose.`);
    }
    if (!why?.trim()) return no('Say why this order reads better. It is the whole of what the person is judging.');

    this.state.orders = this.state.orders.filter((o) => o.entryId !== entryId);
    this.state.orders.push({ entryId, bullets: wanted, why: why.trim() });
    return ok(
      `Proposed for ${entryId}: ${wanted.join(', ')}.` +
        (strangers.length ? ` Ignored, because they are not its lines: ${some(strangers)}.` : '') +
        ' Nothing is written: this moves every resume that has not arranged its own lines, so the person decides.',
    );
  }

  describeProposal(): string {
    const { entries, alternates, skills, orders } = this.state;
    if (entries.length === 0 && alternates.length === 0 && skills.length === 0 && orders.length === 0) {
      return 'Nothing proposed yet.';
    }
    const lines: string[] = [];
    for (const e of entries) {
      lines.push(`### [${e.id}] ${e.title} — ${e.kind}${e.dates ? ` (${e.dates})` : ''}`);
      for (const b of e.bullets) lines.push(`  - ${b.text}`);
      if (e.bullets.length === 0) lines.push('  (no bullets yet — an entry with none is not worth proposing)');
    }
    if (alternates.length) lines.push('', `Alternate wordings: ${alternates.map((a) => a.bulletId).join(', ')}`);
    if (skills.length) lines.push('', `Skills: ${skills.map((s) => s.text).join(', ')}`);
    if (orders.length) lines.push('', `Lines reordered: ${orders.map((o) => o.entryId).join(', ')}`);
    lines.push('', 'None of this is in the store. It goes to the person to accept or decline, one at a time.');
    return lines.join('\n');
  }

  /**
   * Finish, dropping anything that is not worth showing a person.
   *
   * This used to refuse while any proposed entry had no bullets, and told the
   * model to "withdraw the entry by not proposing it" — which is not something
   * that can be done after the fact, because there is no tool for it. So a run
   * that proposed an entry and then found nothing in the material to support
   * it could never finish, and everything else it had read was thrown away
   * with it. Dropping the empty ones and saying so keeps the rest.
   */
  done(notes: string): MoveResult {
    const empty = this.state.entries.filter((e) => e.bullets.length === 0);
    this.state.entries = this.state.entries.filter((e) => e.bullets.length > 0);
    this.state.notes = notes.trim();
    this.state.finished = true;
    const dropped = empty.length
      ? `Left out, because an entry with no bullets is a heading: ${empty.map((e) => e.id).join(', ')}.\n`
      : '';
    return ok(`Recorded.\n${dropped}${this.describeProposal()}`);
  }
}
