/**
 * Reading the boxes a form has out of the profile it does not have them in.
 *
 * Every case here is a shape somebody's name or location really takes. The
 * ones that yield nothing matter as much as the ones that yield something:
 * an empty required field is visible and gets fixed, and a wrong name on a
 * submitted application is neither.
 */
import { describe, expect, it } from 'vitest';
import { derivedAutofill, readGpa, splitDegree, splitLocation, splitName } from '../src/model/autofill.js';
import type { Entry } from '../src/model/types.js';

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
