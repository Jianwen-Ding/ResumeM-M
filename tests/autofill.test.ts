/**
 * Reading the boxes a form has out of the profile it does not have them in.
 *
 * Every case here is a shape somebody's name or location really takes. The
 * ones that yield nothing matter as much as the ones that yield something:
 * an empty required field is visible and gets fixed, and a wrong name on a
 * submitted application is neither.
 */
import { describe, expect, it } from 'vitest';
import {
  derivedAutofill,
  educationHistory,
  graduation,
  readGpa,
  splitDegree,
  splitLocation,
  splitName,
  workHistory,
} from '../src/model/autofill.js';
import type { Entry, ResolvedResume } from '../src/model/types.js';

describe('splitting a name into the two boxes a form has', () => {
  it('takes the first and last word', () => {
    expect(splitName('Jianwen Ding')).toEqual({ first: 'Jianwen', last: 'Ding' });
  });

  it('reads the filed order when it is written with a comma', () => {
    expect(splitName('Ding, Jianwen')).toEqual({ first: 'Jianwen', last: 'Ding' });
  });

  it('keeps a lower-case particle with the surname it belongs to', () => {
    expect(splitName('Ludwig van Beethoven')).toEqual({ first: 'Ludwig', last: 'van Beethoven' });
    expect(splitName('Maria de la Cruz')).toEqual({ first: 'Maria', last: 'de la Cruz' });
  });

  it('leaves a capitalised Van as the whole surname, which is how it is written', () => {
    expect(splitName('Laura Van Dyke')).toEqual({ first: 'Laura', last: 'Van Dyke' });
  });

  it('drops a suffix rather than sending it as the surname', () => {
    expect(splitName('Martin Luther King Jr.')).toEqual({ first: 'Martin', last: 'King' });
    expect(splitName('Alice Chen PhD')).toEqual({ first: 'Alice', last: 'Chen' });
  });

  it('passes over the middle names', () => {
    expect(splitName('J. R. R. Tolkien')).toEqual({ first: 'J.', last: 'Tolkien' });
  });

  it('offers nothing for a name that is not two boxes', () => {
    expect(splitName('Cher')).toBeUndefined();
    expect(splitName('')).toBeUndefined();
    expect(splitName('   ')).toBeUndefined();
    // A list, or a name with something after it: not a split this can read.
    expect(splitName('Ding, Jianwen, PhD')).toBeUndefined();
  });

  it('does not leave the given name empty by eating every particle', () => {
    // Every word but the first is a particle; the surname stops before it
    // takes the only given name there is.
    expect(splitName('de la')).toEqual({ first: 'de', last: 'la' });
  });
});

describe('splitting a location into the boxes a form has', () => {
  it('reads city and state', () => {
    expect(splitLocation('Boston, MA')).toEqual({ city: 'Boston', state: 'MA' });
  });

  it('reads all three when all three are written', () => {
    expect(splitLocation('Boston, MA, United States')).toEqual({
      city: 'Boston',
      state: 'MA',
      country: 'United States',
    });
  });

  it('reads a spelled-out second part as the country, not the state', () => {
    // The failure this is about: "United Kingdom" typed into a State box that
    // has a list of US states in it and will not take it.
    expect(splitLocation('London, United Kingdom')).toEqual({ city: 'London', country: 'United Kingdom' });
  });

  it('offers nothing for a location that names no place', () => {
    expect(splitLocation('Remote')).toBeUndefined();
    expect(splitLocation('Greater Boston Area')).toBeUndefined();
    expect(splitLocation('')).toBeUndefined();
  });

  /*
   * A state is a state however it was typed.
   *
   * The rule this function documents is "with two parts, a two-letter second
   * part is a state or province and anything longer is a country" — but the
   * shape test was `^[A-Z]{2}$`, so a profile reading "boston, ma" fell
   * through to the country branch and put **ma** in the Country box of a job
   * application. Worse than filling nothing, which is what every other thing
   * this cannot read does: nothing is a blank the person completes, and "ma"
   * is a wrong answer they have to notice first.
   *
   * Nobody types their own address in a validated field, and the profile is
   * hand-written YAML.
   */
  it('reads a state whatever case it was typed in', () => {
    expect(splitLocation('boston, ma')).toEqual({ city: 'boston', state: 'MA' });
    expect(splitLocation('Boston, Ma')).toEqual({ city: 'Boston', state: 'MA' });
    expect(splitLocation('Toronto, on')).toEqual({ city: 'Toronto', state: 'ON' });
    expect(splitLocation('Seattle, wa, USA')).toEqual({ city: 'Seattle', state: 'WA', country: 'USA' });
  });

  /*
   * Only where it is a postal code. A province written out is a name, and a
   * name is not shouted back at the person who wrote it.
   */
  it('leaves a written-out province exactly as written', () => {
    expect(splitLocation('Vancouver, British Columbia, Canada')).toEqual({
      city: 'Vancouver',
      state: 'British Columbia',
      country: 'Canada',
    });
  });

  it('offers nothing rather than guessing at something it cannot read', () => {
    expect(splitLocation('Boston, 02115')).toBeUndefined();
    expect(splitLocation('a, b, c, d')).toBeUndefined();
  });
});

describe('what the profile implies altogether', () => {
  it('fills the four boxes an ATS form asks for', () => {
    expect(derivedAutofill({ name: 'Jianwen Ding', location: 'Boston, MA' })).toEqual({
      first_name: 'Jianwen',
      last_name: 'Ding',
      address_city: 'Boston',
      address_state: 'MA',
    });
  });

  it('offers nothing it cannot read, rather than a guess', () => {
    expect(derivedAutofill({ name: 'Cher', location: 'Remote' })).toEqual({});
    expect(derivedAutofill({})).toEqual({});
  });

  it('keys them the way the extension keys its own patterns', () => {
    const keys = Object.keys(derivedAutofill({ name: 'Ada Lovelace', location: 'London, United Kingdom' }));
    expect(keys.sort()).toEqual(['address_city', 'address_country', 'first_name', 'last_name']);
  });
});

/*
 * And the other half of the same problem this file opens with.
 *
 * The extension's `FIELD_PATTERNS` has recognised `school`, `degree`, `major`
 * and `gpa` from the start, exactly as it recognised the name and address
 * parts, and the store answered none of them — so the Education section of a
 * Greenhouse form came out empty on a store holding a university, a degree and
 * a grade. Hidden the same way the names were: every test store had them typed
 * in by hand as extras.
 */
const edu = (over: Partial<Entry> = {}): Entry => ({
  id: 'edu_neu',
  kind: 'education',
  title: 'Northeastern University',
  subtitle: 'Bachelor of Science in Computer Science',
  period: { start: { year: 2022 }, end: { year: 2026 } },
  ...over,
});

describe('splitting a degree line into the two boxes a form has', () => {
  it('splits on "in", which is how a resume writes it', () => {
    expect(splitDegree('Bachelor of Science in Computer Science')).toEqual({
      degree: 'Bachelor of Science',
      major: 'Computer Science',
    });
  });

  it('reads the abbreviated forms too', () => {
    expect(splitDegree('BS in Computer Science')).toEqual({ degree: 'BS', major: 'Computer Science' });
    expect(splitDegree('M.Eng in Robotics')).toEqual({ degree: 'M.Eng', major: 'Robotics' });
  });

  /*
   * The last "in", not the first: "Bachelor of Science in Engineering in
   * Computer Science" is a real degree name and the discipline is the tail.
   */
  it('takes the last join when the degree name has one in it', () => {
    expect(splitDegree('Bachelor of Science in Engineering in Computer Science')).toEqual({
      degree: 'Bachelor of Science in Engineering',
      major: 'Computer Science',
    });
  });

  it('drops a GPA clause rather than filing it as the discipline', () => {
    expect(splitDegree('Bachelor of Science in Computer Science, GPA 3.8/4.0')).toEqual({
      degree: 'Bachelor of Science',
      major: 'Computer Science',
    });
  });

  /*
   * A comma is not the join. "Bachelor of Science, Computer Science" and
   * "Bachelor of Science, Summa Cum Laude" are the same shape and only one of
   * them has a discipline after it, so neither is split.
   */
  it('offers nothing where the split is not plain', () => {
    expect(splitDegree('Bachelor of Science, Computer Science')).toBeUndefined();
    expect(splitDegree('Bachelor of Science, Summa Cum Laude')).toBeUndefined();
    // No degree word on the left, so the "in" is part of a subject.
    expect(splitDegree('Studies in Computer Science')).toBeUndefined();
    expect(splitDegree('Computer Science')).toBeUndefined();
    expect(splitDegree('')).toBeUndefined();
  });
});

describe('reading a grade out of the line it is printed on', () => {
  it('takes the number a box wants, without the scale beside it', () => {
    expect(readGpa('Bachelor of Science in Computer Science, GPA 3.8/4.0')).toBe('3.8');
    expect(readGpa('GPA: 3.95')).toBe('3.95');
  });

  it('refuses a score that cannot be one', () => {
    // Above its own scale, so one of the two was misread.
    expect(readGpa('GPA 5.0/4.0')).toBeUndefined();
    expect(readGpa('GPA pending')).toBeUndefined();
    expect(readGpa('Computer Science')).toBeUndefined();
  });
});

describe('what the education entries imply', () => {
  it('fills the four boxes a Greenhouse education section asks for', () => {
    expect(derivedAutofill({}, [edu()])).toEqual({
      school: 'Northeastern University',
      degree: 'Bachelor of Science',
      major: 'Computer Science',
    });
  });

  it('reads the wording that is set when nothing has chosen between them', () => {
    const entry = edu({
      subtitle: {
        default: 'v_plain',
        variants: [
          { id: 'v_gpa', label: 'With GPA', text: 'Bachelor of Science in Computer Science, GPA 3.8/4.0' },
          { id: 'v_plain', label: 'Plain', text: 'Bachelor of Science in Computer Science' },
        ],
      },
    });

    const out = derivedAutofill({}, [entry]);
    expect(out.degree).toBe('Bachelor of Science');
    expect(out.major).toBe('Computer Science');
    /*
     * And the grade from whichever wording carries it. Whether the GPA is on
     * the resume is a decision about the resume; a box marked "GPA" is asking
     * a different question, and the answer is the same either way.
     */
    expect(out.gpa).toBe('3.8');
  });

  it('takes the most recent school when there are several', () => {
    const out = derivedAutofill({}, [
      edu({ id: 'edu_old', title: 'Boston Latin', subtitle: 'BA in History', period: { end: { year: 2022 } } }),
      edu({ id: 'edu_new', title: 'Northeastern University', period: { end: { year: 2026 } } }),
    ]);

    expect(out.school).toBe('Northeastern University');
    expect(out.major).toBe('Computer Science');
  });

  /*
   * The refusals matter as much as the readings, for the reason this file
   * opens with: an empty required box is visible and gets fixed; a wrong
   * university on a submitted application is neither.
   */
  it('offers nothing where the newest is not plain', () => {
    // Two finishing the same year cannot be told apart this way.
    expect(
      derivedAutofill({}, [
        edu({ id: 'a', title: 'One', period: { end: { year: 2026 } } }),
        edu({ id: 'b', title: 'Two', period: { end: { year: 2026 } } }),
      ]),
    ).toEqual({});

    // Neither can two with no readable end date at all.
    expect(
      derivedAutofill({}, [
        edu({ id: 'a', title: 'One', period: undefined }),
        edu({ id: 'b', title: 'Two', period: undefined }),
      ]),
    ).toEqual({});
  });

  it('ignores entries that are not education, and ones put away', () => {
    expect(derivedAutofill({}, [edu({ kind: 'experience', title: 'Helios' })])).toEqual({});
    expect(derivedAutofill({}, [edu({ archived: true })])).toEqual({});
  });

  it('fills the school even when the degree line cannot be split', () => {
    const out = derivedAutofill({}, [edu({ subtitle: 'Computer Science' })]);
    expect(out).toEqual({ school: 'Northeastern University' });
  });

  it('keys them the way the extension keys its own patterns', () => {
    const entry = edu({ subtitle: 'Bachelor of Science in Computer Science, GPA 3.8/4.0' });
    expect(Object.keys(derivedAutofill({}, [entry])).sort()).toEqual(['degree', 'gpa', 'major', 'school']);
  });
});

describe('when the degree ends, as the boxes forms ask for it in', () => {
  it('reads the month and year off the end of the range', () => {
    expect(graduation('Sep. 2022 -- May 2026')).toEqual({
      education_start_year: '2022',
      education_start_month: 'September',
      education_start_date: 'September 2022',
      graduation_year: '2026',
      graduation_month: 'May',
      graduation_date: 'May 2026',
    });
    expect(graduation('Sep. 2022 -- Dec. 2026').graduation_month).toBe('December');
  });

  /*
   * A guessed month on a graduation date is a claim about when somebody can
   * start work. An end with only a year reports only the year.
   */
  it('reports only the year when only the year is written', () => {
    expect(graduation('2022 -- 2026')).toEqual({
      education_start_year: '2022',
      education_start_date: '2022',
      graduation_year: '2026',
      graduation_date: '2026',
    });
  });

  /*
   * A degree in progress still began when it began: the start is reported and
   * the end is not, because there is no end yet to report.
   */
  it('reports no end for a degree still in progress, and nothing for dates it cannot read', () => {
    expect(graduation('Sep. 2022 -- Present')).toEqual({
      education_start_year: '2022',
      education_start_month: 'September',
      education_start_date: 'September 2022',
    });
    expect(graduation('Two semesters')).toEqual({});
    expect(graduation('')).toEqual({});
  });

  /*
   * A lone date on a degree is when it ends — "May 2026" is how the starter
   * save writes it, and how most people do. It was read as the start: the
   * form's graduation boxes got nothing, and its "Start date" boxes got the
   * graduation date.
   */
  it('reads a single date as the graduation, not the start', () => {
    expect(graduation('May 2027')).toEqual({ graduation_year: '2027', graduation_month: 'May', graduation_date: 'May 2027' });
    expect(graduation('Expected May 2027')).toEqual({
      graduation_year: '2027',
      graduation_month: 'May',
      graduation_date: 'May 2027',
    });
    expect(graduation('Anticipated Dec 2026').graduation_date).toBe('December 2026');
    expect(graduation('2027')).toEqual({ graduation_year: '2027', graduation_date: '2027' });
  });
});

/*
 * The graduation date is why the resume's own choices come into this at all.
 * Somebody applying to internships and new-grad roles keeps two, and picks
 * between them per posting; read from the default, every internship form was
 * told May 2026 while the resume attached to it said December.
 */
describe('the form agrees with the resume being sent', () => {
  const twoDates = (): Entry =>
    edu({
      dates: {
        default: 'v_may2026',
        variants: [
          { id: 'v_may2026', label: 'May 2026', text: 'Sep. 2022 -- May 2026', tags: ['newgrad'] },
          { id: 'v_dec2026', label: 'Dec 2026', text: 'Sep. 2022 -- Dec. 2026', tags: ['intern'] },
        ],
      },
    });

  it('uses the default when no resume is named', () => {
    expect(derivedAutofill({}, [twoDates()]).graduation_date).toBe('May 2026');
  });

  it("uses the date the resume chose when one is", () => {
    const out = derivedAutofill({}, [twoDates()], { 'edu_neu.dates': 'v_dec2026' });
    expect(out.graduation_date).toBe('December 2026');
    expect(out.graduation_month).toBe('December');
  });

  /*
   * To the *default*, not to whichever wording is listed first. Here the two
   * are different on purpose — the intern date is listed first and the
   * default is May — because with the default first, falling back to the
   * first wording passes this for the wrong reason.
   */
  it('falls back to the default for a choice that names no wording', () => {
    const entry = edu({
      dates: {
        default: 'v_may2026',
        variants: [
          { id: 'v_dec2026', label: 'Dec 2026', text: 'Sep. 2022 -- Dec. 2026' },
          { id: 'v_may2026', label: 'May 2026', text: 'Sep. 2022 -- May 2026' },
        ],
      },
    });
    expect(derivedAutofill({}, [entry], { 'edu_neu.dates': 'v_gone' }).graduation_date).toBe('May 2026');
  });

  it('only listens to choices about the school it is reading', () => {
    const out = derivedAutofill({}, [twoDates()], { 'edu_other.dates': 'v_dec2026' });
    expect(out.graduation_date).toBe('May 2026');
  });

  it('reads the degree the resume chose, too', () => {
    const entry = edu({
      subtitle: {
        default: 'v_cs',
        variants: [
          { id: 'v_cs', label: 'CS', text: 'Bachelor of Science in Computer Science' },
          { id: 'v_ce', label: 'CE', text: 'Bachelor of Science in Computer Engineering' },
        ],
      },
    });
    expect(derivedAutofill({}, [entry], { 'edu_neu.subtitle': 'v_ce' }).major).toBe('Computer Engineering');
  });
});

/*
 * "Current company", which Lever asks on every form and the store never
 * answered. Only from a role that runs to the present: the last place somebody
 * worked is not where they work, and saying so to a prospective employer is a
 * false statement made on their behalf.
 */
describe('the job somebody holds now', () => {
  const job = (over: Partial<Entry> = {}): Entry => ({
    id: 'exp_helios',
    kind: 'experience',
    title: 'Helios',
    subtitle: 'Software Engineer Intern',
    dates: 'Jan. 2026 -- Present',
    ...over,
  });

  it('answers from a role that runs to the present', () => {
    expect(derivedAutofill({}, [job()])).toEqual({
      current_company: 'Helios',
      current_title: 'Software Engineer Intern',
    });
  });

  it('says nothing about a role that has ended', () => {
    expect(derivedAutofill({}, [job({ dates: 'Jul. 2024 -- Dec. 2024' })])).toEqual({});
  });

  it('takes the more recent of two current roles', () => {
    const out = derivedAutofill({}, [
      job({ id: 'exp_ta', title: 'Northeastern University', subtitle: 'Teaching Assistant', dates: 'Sep. 2024 -- Present' }),
      job({ id: 'exp_helios', dates: 'Jan. 2026 -- Present' }),
    ]);
    expect(out.current_company).toBe('Helios');
  });

  it('offers nothing when two current roles started together', () => {
    expect(
      derivedAutofill({}, [
        job({ id: 'a', title: 'One', dates: 'Jan. 2026 -- Present' }),
        job({ id: 'b', title: 'Two', dates: 'Jan. 2026 -- Present' }),
      ]),
    ).toEqual({});
  });

  it('reads the dates the resume chose, which decide whether the role is current', () => {
    const entry = job({
      dates: {
        default: 'v_ended',
        variants: [
          { id: 'v_ended', label: 'Ended', text: 'Jan. 2026 -- Apr. 2026' },
          { id: 'v_now', label: 'Ongoing', text: 'Jan. 2026 -- Present' },
        ],
      },
    });
    expect(derivedAutofill({}, [entry])).toEqual({});
    expect(derivedAutofill({}, [entry], { 'exp_helios.dates': 'v_now' }).current_company).toBe('Helios');
  });

  it('ignores ongoing entries that are not jobs, and ones put away', () => {
    expect(derivedAutofill({}, [job({ archived: true })])).toEqual({});
    expect(derivedAutofill({}, [job({ kind: 'project' })])).toEqual({});
  });
});

/*
 * A form's work-history blocks, answered from the resume being sent: its jobs,
 * in its order, with the lines it prints and nothing written for the form.
 */
describe('the jobs a work-history section asks for', () => {
  const resume = (entries: ResolvedResume['sections'][number]['entries']): ResolvedResume =>
    ({
      id: 'r',
      label: 'R',
      profile: { name: 'Test Person' },
      sections: [{ kind: 'experience', heading: 'Experience', entries, skillGroups: [] }],
      layout: {},
      warnings: [],
    }) as unknown as ResolvedResume;

  it('reads each job with its dates, and its lines as plain words', () => {
    const jobs = workHistory(
      resume([
        {
          id: 'e1',
          kind: 'experience',
          title: 'Vega **Analytics**',
          subtitle: 'Backend Engineer',
          location: 'Boston, MA',
          dates: 'Jun. 2023 -- Present',
          bullets: [
            { id: 'b1', variantId: 'v', text: 'Built a `Kafka` pipeline handling **2M events/day**' },
            { id: 'b2', variantId: 'v', text: 'Cut latency from *900ms* to 180ms' },
          ],
        },
        { id: 'e2', kind: 'experience', title: 'Acme Co.', dates: 'Summer 2022', bullets: [] },
      ]),
    );
    expect(jobs[0]).toEqual({
      company: 'Vega Analytics',
      title: 'Backend Engineer',
      location: 'Boston, MA',
      start: { year: 2023, month: 6 },
      current: true,
      description: '• Built a Kafka pipeline handling 2M events/day\n• Cut latency from 900ms to 180ms',
    });
    // A lone date is when the job was, start and end alike; no lines is no description.
    expect(jobs[1]).toMatchObject({ company: 'Acme Co.', current: false, description: '' });
    expect(jobs[1]?.start?.year).toBe(2022);
    expect(jobs[1]?.end?.year).toBe(2022);
  });

  it('leaves out what is not a job', () => {
    const r = resume([
      { id: 'p', kind: 'project', title: 'A thing', bullets: [{ id: 'b', variantId: 'v', text: 'Did it' }] },
      { id: 'e', kind: 'experience', title: '   ', bullets: [] },
    ] as never);
    expect(workHistory(r)).toEqual([]);
  });
});

/*
 * A form's Education section, one block per school with an "Add another" for
 * the next: answered from the resume being sent, every education it lists, in
 * its order, read the way the fields read the newest one.
 */
describe('the schools an Education section asks for, one block at a time', () => {
  const resume = (entries: ResolvedResume['sections'][number]['entries']): ResolvedResume =>
    ({
      id: 'r',
      label: 'R',
      profile: { name: 'Morgan Testwell' },
      sections: [
        { kind: 'education', heading: 'Education', entries, skillGroups: [] },
        { kind: 'experience', heading: 'Experience', entries: [{ id: 'x', kind: 'experience', title: 'Acme Co.', bullets: [] }], skillGroups: [] },
      ],
      layout: {},
      warnings: [],
    }) as unknown as ResolvedResume;

  it("reads each school with its degree, discipline, dates and grade, in the resume's order", () => {
    const schools = educationHistory(
      resume([
        {
          id: 'edu_bu',
          kind: 'education',
          title: 'Boston University',
          subtitle: 'Master of Science in Computer Science',
          location: 'Boston, MA',
          dates: 'Sep. 2027 -- May 2028',
          bullets: [],
        },
        {
          id: 'edu_neu',
          kind: 'education',
          title: 'Northeastern **University**',
          subtitle: 'Bachelor of Science in Computer Science, GPA 3.8/4.0',
          dates: 'Sep. 2023 -- May 2027',
          bullets: [],
        },
      ]),
    );
    expect(schools).toEqual([
      {
        school: 'Boston University',
        degree: 'Master of Science',
        major: 'Computer Science',
        location: 'Boston, MA',
        start: { year: 2027, month: 9 },
        end: { year: 2028, month: 5 },
      },
      {
        school: 'Northeastern University',
        degree: 'Bachelor of Science',
        major: 'Computer Science',
        start: { year: 2023, month: 9 },
        end: { year: 2027, month: 5 },
        gpa: '3.8',
      },
    ]);
  });

  it('takes a lone date as the graduation, and gives no end to one still going', () => {
    const [lone, going] = educationHistory(
      resume([
        { id: 'a', kind: 'education', title: 'Boston University', dates: 'May 2028', bullets: [] },
        { id: 'b', kind: 'education', title: 'Northeastern University', dates: 'Sep. 2023 -- Present', bullets: [] },
      ]),
    );
    expect(lone).toEqual({ school: 'Boston University', end: { year: 2028, month: 5 } });
    expect(going).toEqual({ school: 'Northeastern University', start: { year: 2023, month: 9 } });
  });

  it('offers no degree or discipline for a line that does not split plainly', () => {
    const [one] = educationHistory(
      resume([{ id: 'a', kind: 'education', title: 'Boston University', subtitle: 'Master of Engineering, Robotics', bullets: [] }]),
    );
    expect(one).toEqual({ school: 'Boston University' });
  });

  it('finds the grade in a wording the resume did not print, as the fields do', () => {
    const stored = {
      id: 'edu_neu',
      kind: 'education',
      title: 'Northeastern University',
      subtitle: {
        default: 'v_plain',
        variants: [
          { id: 'v_plain', label: 'Plain', text: 'Bachelor of Science in Computer Science' },
          { id: 'v_gpa', label: 'With GPA', text: 'Bachelor of Science in Computer Science, GPA 3.7' },
        ],
      },
      bullets: [],
    } as unknown as Entry;
    const [one] = educationHistory(
      resume([{ id: 'edu_neu', kind: 'education', title: 'Northeastern University', subtitle: 'Bachelor of Science in Computer Science', bullets: [] }]),
      [stored],
    );
    expect(one?.gpa).toBe('3.7');
    expect(one?.degree).toBe('Bachelor of Science');
  });

  it('leaves out what is not an education, and one with no school named', () => {
    const r = resume([
      { id: 'p', kind: 'project', title: 'A thing', bullets: [] },
      { id: 'e', kind: 'education', title: '  ', subtitle: 'Bachelor of Science in Physics', bullets: [] },
    ] as never);
    expect(educationHistory(r)).toEqual([]);
  });
});
