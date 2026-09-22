/*
 * Dates, for the browser.
 *
 * A mirror of `src/model/period.ts`, which the editor cannot import: that one
 * is TypeScript compiled for node and this is a script the browser loads
 * directly, and the build has no path between them — the same split that
 * forced `orderEntryIds` into reorder.js.
 *
 * Duplication is tolerable; drift is not. If the two disagree, the control
 * shows one date and the resume prints another, and both look right on their
 * own. `tests/date-agreement.test.js` pins them against one table of the
 * shapes people actually write, in both directions, so a change to either side
 * fails rather than shipping.
 */

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

export const DEFAULT_STYLE = {
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
const SEASON_MONTH = { spring: 3, summer: 6, fall: 9, winter: 12 };
const SEASON_WORDS = {
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

function monthFromWord(word) {
  const clean = word.replace(/\.$/, '').toLowerCase();
  const season = SEASON_WORDS[clean];
  if (season) return { month: SEASON_MONTH[season], how: 'long', season };

  const long = LONG.findIndex((m) => m.toLowerCase() === clean);
  // "May" is its own abbreviation, so it is evidence of no style at all. See
  // `monthFromWord` in period.ts, which this mirrors and is pinned against.
  if (long >= 0) {
    const same = LONG[long] === ABBR[long];
    return { month: long + 1, how: 'long', ...(same ? { ambiguous: true } : {}) };
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
 * Returns the spelling it found, because the spelling is
 * what lets the formatter put the text back the way it was.
 */
function parsePoint(raw) {
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
    for (const [word, year] of [[a, b], [b, a]] ) {
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
function splitRange(text) {
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
export function parsePeriod(raw) {
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
export function styleOf(raw) {
  const found = {};
  const text = String(raw ?? '');

  const split = splitRange(text);
  if (split) {
    found.range = split.separator;
    if (PRESENT.test(split.right)) found.present = split.right;
  }

  // Every date in the string, not the first: the first may be a season or a
  // May, neither of which can say. See `styleOf` in period.ts, which this
  // mirrors and is pinned against by date-agreement.test.js.
  for (const month of text.matchAll(/([A-Za-z]{3,9}\.?)\s+\d{4}|\d{4}[-/]\d{1,2}|\d{1,2}[-/]\d{4}/g)) {
    if (!month[1]) {
      found.month = 'numeric';
      break;
    }
    const how = monthFromWord(month[1]);
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
export function inferStyle(samples) {
  const votes = {
    month: new Map(),
    range: new Map(),
    present: new Map(),
    expected: new Map(),
  };

  for (const sample of samples) {
    const found = styleOf(sample);
    for (const key of Object.keys(votes)) {
      const value = found[key];
      if (value === undefined) continue;
      votes[key].set(value, (votes[key].get(value) ?? 0) + 1);
    }
  }

  const winner = (key) => {
    let best;
    let count = 0;
    for (const [value, n] of votes[key]) {
      if (n > count) {
        best = value;
        count = n;
      }
    }
    return best ?? DEFAULT_STYLE[key];
  };

  return { month: winner('month'), range: winner('range'), present: winner('present'), expected: winner('expected') };
}

function formatMonth(month, how) {
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

function formatPoint(point, style, season) {
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
export function formatPeriod(period, style = DEFAULT_STYLE) {
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
export function sortKey(period) {
  if (!period?.start) return undefined;
  // Above everything finished, and ordered among themselves by when they
  // began. See `sortKey` in period.ts, which this mirrors and is pinned
  // against by order-agreement.test.js.
  if (period.ongoing) return ONGOING + (startKey(period) ?? 0);
  const point = period.end ?? period.start;
  return point.year * 100 + (point.month ?? 12);
}

/** The floor for anything still running. See period.ts. */
const ONGOING = 1e12;

/** The earlier edge, for sorting oldest-first without reversing the other key. */
export function startKey(period) {
  if (!period?.start) return undefined;
  return period.start.year * 100 + (period.start.month ?? 1);
}

/**
 * A range that finishes before it begins. See `period.ts` for why this is
 * said rather than refused; `tests/date-agreement.test.js` holds the two
 * copies to the same answer.
 */
export function endsBeforeItStarts(period) {
  if (!period?.start?.year || !period.end?.year || period.ongoing) return false;
  return period.end.year < period.start.year;
}
