/**
 * Dates on a resume, as dates rather than as words.
 *
 * `Entry.dates` has always been free text, and free text cannot be sorted. You
 * can read "Jul. 2024 -- Dec. 2024" and know it comes after "Sep. 2022", but
 * nothing in the program can, so the order of the entries on a resume was
 * whatever order they happened to be written in and every correction was made
 * by hand.
 *
 * The hard part is not reading a date. It is that a store already exists and
 * has already been sent to people. "Jul. 2024" and "July 2024" and "Jul 2024"
 * are the same date and three different documents, and a migration that reads
 * the first and writes the second has quietly changed a resume the user
 * believes they have already proofread. So:
 *
 *   - Parsing is generous. It takes the spellings people actually write,
 *     including the ones it cannot reproduce, because a date it can read is a
 *     date it can sort by even when it must print the original words.
 *   - Formatting is styled, not canonical. The separator, the month spelling
 *     and the word for an open end are all read back out of the store the
 *     first time, so the form the program writes is the form already in use.
 *   - Anything that does not round-trip keeps its original text, and says so.
 *
 * The rule the rest of the code relies on: `format(parse(text), styleOf(text))`
 * returns `text` for every shape this file claims to handle, and the tests
 * assert exactly that over a corpus rather than over examples chosen to pass.
 */

/** A point in time at the granularity a resume uses: a year, or a month in one. */
export interface DatePoint {
  year: number;
  /** 1-12. Absent means the year as a whole. */
  month?: number;
}

/**
 * When something happened.
 *
 * `end` absent with `ongoing` false is a single date — an award, a talk, a
 * one-day certification — which is a real shape and not a range missing half
 * of itself.
 */
export interface Period {
  start?: DatePoint;
  end?: DatePoint;
  /** No end yet: prints as the store's word for it, usually "Present". */
  ongoing?: boolean;
  /** Not yet reached: a graduation date, printed with "Expected" in front. */
  expected?: boolean;
  /**
   * The season the text named, kept so "Summer 2024" can be printed back as
   * itself. The month carries the sort order; this carries the words.
   */
  season?: Season;
}

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

/** How this store writes a date, read back out of the store itself. */
export interface DateStyle {
  /** `Sep.` | `Sep` | `September` | `09` */
  month: 'abbrDot' | 'abbr' | 'long' | 'numeric';
  /** What sits between the two ends, spaces included. */
  range: string;
  /** The word for an end that has not happened. */
  present: string;
  /** The word that marks a date as not yet reached. */
  expected: string;
}

export const DEFAULT_STYLE: DateStyle = {
  // `--` is an en dash in LaTeX, and it is what the bundled store uses.
  month: 'abbrDot',
  range: ' -- ',
  present: 'Present',
  expected: 'Expected',
};

const LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ABBR = LONG.map((m) => m.slice(0, 3));

/*
 * A season is not a month, but it is sortable, and a resume that says "Summer
 * 2024" is saying something a sort should be able to act on. The month is the
 * one the season starts in, which is what a reader would assume.
 */
const SEASON_MONTH: Record<Season, number> = { spring: 3, summer: 6, fall: 9, winter: 12 };
const SEASON_WORDS: Record<string, Season> = {
  spring: 'spring',
  summer: 'summer',
  fall: 'fall',
  autumn: 'fall',
  winter: 'winter',
};

/** Words that mean "this has not ended". */
const PRESENT = /^(present|current|currently|now|ongoing|to date|date)$/i;
/** Words that mark a date as not yet reached. */
const EXPECTED = /\b(expected|anticipated|projected)\b:?/i;

/*
 * Every separator seen in the wild, strictly longest first so ` -- ` is not
 * read as a hyphen with a stray dash beside it. A bare `-` is last because it
 * also turns up inside `2024-07`, which the month parser needs first.
 *
 * "Strictly" is the part that was only a claim. ' – ' sat after '–', so a
 * store writing "July 2024 – December 2024" matched the bare dash, recorded a
 * separator with no spaces around it, and got "July 2024–March 2025" back the
 * next time one of its dates moved — the em dash the same. Spaced dashes are
 * an ordinary way to write a range, and this quietly closed them up.
 */
const RANGE_SEPARATORS = [
  ' --- ', ' -- ', ' — ', ' – ', ' to ', ' until ', ' through ', ' - ',
  '---', '--', '—', '–', '-',
];

/** The `(expected)` that people write after the date instead of before it. */
const TRAILING_EXPECTED = /\s*\((expected|anticipated|projected)\)\s*$/i;

function monthFromWord(
  word: string,
): { month: number; how: DateStyle['month']; season?: Season; ambiguous?: true } | null {
  const clean = word.replace(/\.$/, '').toLowerCase();
  const season = SEASON_WORDS[clean];
  if (season) return { month: SEASON_MONTH[season], how: 'long', season };

  const long = LONG.findIndex((m) => m.toLowerCase() === clean);
  /*
   * "May" is its own abbreviation, so it says nothing about which style this
   * store writes — the same way a season says nothing, a line below.
   *
   * The long names are tried first, so every May reported `long`.
   * `formatMonth` already refuses to write "May." for the symmetric reason;
   * reading had no such guard. On one string that respells the other end —
   * "May 2023 -- Aug. 2023" came back "May 2023 -- August 2023" — and
   * store-wide it is worse, because `inferStyle` counts votes: three summer
   * internships and a degree is the most ordinary new-grad save there is, and
   * three Mays outvoted two `Sep.`/`Jan.`, so every entry touched afterwards
   * was rewritten into full month names one at a time.
   */
  if (long >= 0) {
    const same = LONG[long] === ABBR[long];
    return { month: long + 1, how: 'long', ...(same ? { ambiguous: true as const } : {}) };
  }

  const abbr = ABBR.findIndex((m) => m.toLowerCase() === clean);
  if (abbr >= 0) return { month: abbr + 1, how: word.endsWith('.') ? 'abbrDot' : 'abbr' };

  // "Sept" is written often enough to be worth knowing, and it is nobody's
  // three-letter abbreviation.
  if (clean === 'sept') return { month: 9, how: 'abbr' };
  return null;
}

/**
 * One end of a range: a year, a month and a year, or a season and a year.
 *
 * Returns the spelling it found as well as the value, because the spelling is
 * what lets the formatter put the text back the way it was.
 */
function parsePoint(raw: string): { point: DatePoint; how?: DateStyle['month']; season?: Season } | null {
  const text = raw.trim().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // 2024-07 and 2024/07, which sort correctly as text and so get written by
  // people who have been bitten by this before.
  const iso = /^(\d{4})[-/](\d{1,2})$/.exec(text);
  if (iso) {
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return null;
    return { point: { year: Number(iso[1]), month }, how: 'numeric' };
  }

  // 07/2024 and 7/2024.
  const slash = /^(\d{1,2})[-/](\d{4})$/.exec(text);
  if (slash) {
    const month = Number(slash[1]);
    if (month < 1 || month > 12) return null;
    return { point: { year: Number(slash[2]), month }, how: 'numeric' };
  }

  const bare = /^(\d{4})$/.exec(text);
  if (bare) return { point: { year: Number(bare[1]) } };

  // "Jul. 2024", "July 2024", "Summer 2024" — and the reverse order, which
  // plenty of European CVs use.
  const words = text.split(' ');
  if (words.length === 2) {
    const [a = '', b = ''] = words;
    for (const [word, year] of [[a, b], [b, a]] as const) {
      if (!/^\d{4}$/.test(year)) continue;
      const month = monthFromWord(word);
      if (month) {
        return {
          point: { year: Number(year), month: month.month },
          how: month.how,
          ...(month.season ? { season: month.season } : {}),
        };
      }
    }
  }
  return null;
}

/** Split a range on the first separator that leaves something on both sides. */
function splitRange(text: string): { left: string; right: string; separator: string } | null {
  for (const separator of RANGE_SEPARATORS) {
    const at = text.indexOf(separator);
    if (at <= 0) continue;
    const left = text.slice(0, at).trim();
    const right = text.slice(at + separator.length).trim();
    if (!left || !right) continue;
    // `2024-07` is one date, not July of the year 2024 onwards.
    if (separator === '-' && /^\d{4}$/.test(left) && /^\d{1,2}$/.test(right)) continue;
    return { left, right, separator };
  }
  return null;
}

/**
 * Read a date out of the words someone wrote, or say that there is none.
 *
 * Returning undefined is a normal outcome, not a failure: "Various" and
 * "Ongoing since university" are things people put in this field, and the
 * right response is to leave the text alone and sort that entry by hand.
 */
export function parsePeriod(raw: string): Period | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (!text) return undefined;

  let expected = false;
  if (TRAILING_EXPECTED.test(text)) {
    expected = true;
    text = text.replace(TRAILING_EXPECTED, '').trim();
  }
  if (EXPECTED.test(text)) {
    expected = true;
    text = text.replace(EXPECTED, '').trim();
  }

  const split = splitRange(text);
  if (!split) {
    const only = parsePoint(text);
    if (!only) return undefined;
    return {
      start: only.point,
      ...(expected ? { expected: true } : {}),
      ...(only.season ? { season: only.season } : {}),
    };
  }

  const start = parsePoint(split.left);
  if (!start) return undefined;

  if (PRESENT.test(split.right)) {
    return {
      start: start.point,
      ongoing: true,
      ...(expected ? { expected: true } : {}),
      ...(start.season ? { season: start.season } : {}),
    };
  }

  const end = parsePoint(split.right);
  if (!end) return undefined;
  return {
    start: start.point,
    end: end.point,
    ...(expected ? { expected: true } : {}),
    ...(start.season ? { season: start.season } : {}),
  };
}

/** How one date string spells things, for inferring a whole store's habit. */
export function styleOf(raw: string): Partial<DateStyle> {
  const found: Partial<DateStyle> = {};
  const text = String(raw ?? '');

  const split = splitRange(text);
  if (split) {
    found.range = split.separator;
    if (PRESENT.test(split.right)) found.present = split.right;
  }

  /*
   * Every date in the string, not the first one, because the first may be the
   * one that cannot answer. "May 2023 -- Aug. 2023" is the ordinary summer
   * internship: May abstains — it is its own abbreviation, see
   * `monthFromWord` — and `Aug.` is right there saying `abbrDot`. Stopping at
   * the first match threw that away and reported nothing at all, which sends
   * the date back in the store's habit rather than the way it was written.
   */
  for (const month of text.matchAll(/([A-Za-z]{3,9}\.?)\s+\d{4}|\d{4}[-/]\d{1,2}|\d{1,2}[-/]\d{4}/g)) {
    if (!month[1]) {
      found.month = 'numeric';
      break;
    }
    const how = monthFromWord(month[1]);
    // A season tells you nothing about how months are abbreviated, and
    // neither does a month whose abbreviation is the whole word.
    if (how && !how.season && !how.ambiguous) {
      found.month = how.how;
      break;
    }
  }

  const expected = EXPECTED.exec(text);
  if (expected?.[0]) found.expected = expected[0].replace(/:$/, '');

  return found;
}

/**
 * The way this store already writes dates.
 *
 * Taken by majority rather than from the first entry: one project dated
 * "2024" says nothing about how months are abbreviated, and one hand-typed
 * outlier should not decide the shape of every date the program writes from
 * then on.
 */
export function inferStyle(samples: string[]): DateStyle {
  const votes: Record<keyof DateStyle, Map<string, number>> = {
    month: new Map(),
    range: new Map(),
    present: new Map(),
    expected: new Map(),
  };

  for (const sample of samples) {
    const found = styleOf(sample);
    for (const key of Object.keys(votes) as (keyof DateStyle)[]) {
      const value = found[key];
      if (value === undefined) continue;
      votes[key].set(value, (votes[key].get(value) ?? 0) + 1);
    }
  }

  const winner = <K extends keyof DateStyle>(key: K): DateStyle[K] => {
    let best: string | undefined;
    let count = 0;
    for (const [value, n] of votes[key]) {
      if (n > count) {
        best = value;
        count = n;
      }
    }
    return (best ?? DEFAULT_STYLE[key]) as DateStyle[K];
  };

  return { month: winner('month'), range: winner('range'), present: winner('present'), expected: winner('expected') };
}

function formatMonth(month: number, how: DateStyle['month']): string {
  const name = LONG[month - 1] ?? '';
  if (how === 'long') return name;
  if (how === 'numeric') return String(month).padStart(2, '0');
  /*
   * "May." is not a thing anyone writes, and a store that abbreviates with a
   * full stop still writes May as May — the abbreviation is the word, so there
   * is nothing to mark as shortened. Found by round-tripping the corpus: the
   * one real store here holds "Sep. 2022 -- May 2026", which came back out as
   * "May. 2026" and would have quietly respelt a graduation date.
   */
  const short = name.slice(0, 3);
  return how === 'abbrDot' && short !== name ? `${short}.` : short;
}

function formatPoint(point: DatePoint, style: DateStyle, season?: Season): string {
  if (season) return `${season[0]?.toUpperCase()}${season.slice(1)} ${point.year}`;
  if (point.month === undefined) return String(point.year);
  if (style.month === 'numeric') return `${String(point.month).padStart(2, '0')}/${point.year}`;
  return `${formatMonth(point.month, style.month)} ${point.year}`;
}

/**
 * Write a period back out in the way this store writes dates.
 *
 * "Expected" marks the *last* date, not the range: a degree reads "Sep. 2022
 * -- Expected May 2027", because the start already happened and only the end
 * is a projection. Putting it in front of the whole thing produced "Expected
 * Sep. 2022 -- May 2027", which says something false about the start.
 */
export function formatPeriod(period: Period | undefined, style: DateStyle = DEFAULT_STYLE): string {
  if (!period?.start) return '';
  const soon = period.expected ? `${style.expected} ` : '';
  const start = formatPoint(period.start, style, period.season);

  if (period.ongoing) return `${soon}${start}${style.range}${style.present}`;
  if (!period.end) return `${soon}${start}`;
  // The season belongs to whichever end named one, and only one end can, so a
  // range with a season in it prints that season on the left and a date on the
  // right — which is what "Summer 2024 -- Dec. 2024" already looks like.
  return `${start}${style.range}${soon}${formatPoint(period.end, style)}`;
}

/**
 * A number that sorts newest-first correctly, or undefined for "no idea".
 *
 * An entry still running outranks one that finished, whatever the dates say,
 * because that is what a reader means by "most recent". A date not yet reached
 * — an expected graduation — sorts by when it will be, which puts a degree in
 * progress above a job that ended last year, and that is also right.
 */
export function sortKey(period: Period | undefined): number | undefined {
  if (!period?.start) return undefined;
  /*
   * Still above everything finished — but ordered among themselves by when
   * they began, which every other ongoing period also has.
   *
   * This was a flat `Number.MAX_SAFE_INTEGER`, so any two current roles
   * compared equal and `orderedEntries` left them in whatever order the file
   * happened to list: a job started this year printing under a volunteer role
   * started in 2019, in a section the editor calls date-ordered.
   *
   * It compounds. Because the two compare equal, `adoptDateOrder` finds the
   * listed order already equal to the sorted order for *any* arrangement of
   * them and stamps the section "newest", so the editor then says out loud
   * that it is in date order. And `startKey` does tell them apart, so the
   * oldest-first and newest-first orderings disagreed about the same pair.
   *
   * `ONGOING` is past any real `year * 100 + month`, so the two groups cannot
   * interleave however far in the future a date is.
   */
  if (period.ongoing) return ONGOING + (startKey(period) ?? 0);
  const point = period.end ?? period.start;
  return point.year * 100 + (point.month ?? 12);
}

/**
 * The floor for anything still running. A year would have to reach 10^11 for
 * a finished period to reach it, and `Number.MAX_SAFE_INTEGER` is four orders
 * of magnitude above the largest key it can carry.
 */
const ONGOING = 1e12;

/** The earlier edge, for sorting oldest-first without reversing the other key. */
export function startKey(period: Period | undefined): number | undefined {
  if (!period?.start) return undefined;
  return period.start.year * 100 + (period.start.month ?? 1);
}

/**
 * A range that finishes before it begins.
 *
 * The date control takes any year between 1900 and 2100 at either end and
 * asks nothing further, which is right while you are editing — changing both
 * ends of a range means passing through a moment where only one of them has
 * moved, and a control that fought you there would be unusable. But nothing
 * downstream ever looked again, so a mistyped digit printed "Jul. 2026 --
 * Dec. 2024" onto a document whose entire purpose is to be correct, and
 * sorted the entry by an end date that never happened.
 *
 * It is one keystroke away — the end year typed into the start field, a 6 for
 * a 4 — and it is equally what an imported file can already contain. So it is
 * said out loud, in the warnings the editor and `rmm build` both show, and
 * nowhere is anything refused or rewritten: the only thing the program is
 * entitled to do about somebody's dates is point at them.
 *
 * Only the year is compared, and that is a deliberate retreat from a version
 * of this that compared months too. "Winter 2024 -- Spring 2024" is an
 * ordinary way to write an academic term, and the month for a season is one
 * this file made up — winter is December here — so the finer check called
 * that date wrong. It is not wrong. Nor is "Dec. 2024 -- Spring 2024", a
 * co-op running into the next year, and the parse cannot even tell you a
 * season was involved: only the start's season is kept, so by the time this
 * sees the period the end is an ordinary March.
 *
 * So the rule is the one no reading rescues: the end year is before the start
 * year. "Jul. 2026 -- Dec. 2024" is wrong however you read it. A month-level
 * inversion inside one year is left alone — it is ambiguous, and it is picked
 * from a menu rather than typed, which is not where the slip happens anyway.
 * A warning that fires on somebody's real dates costs the credibility of
 * every other warning, and that is the more expensive mistake by far.
 */
export function endsBeforeItStarts(period: Period | undefined): boolean {
  // Still going has no end to be wrong about, whatever is left in `end`.
  if (!period?.start?.year || !period.end?.year || period.ongoing) return false;
  return period.end.year < period.start.year;
}
