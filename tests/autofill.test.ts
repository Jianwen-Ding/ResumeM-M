/**
 * Reading the boxes a form has out of the profile it does not have them in.
 *
 * Every case here is a shape somebody's name or location really takes. The
 * ones that yield nothing matter as much as the ones that yield something:
 * an empty required field is visible and gets fixed, and a wrong name on a
 * submitted application is neither.
 */
import { describe, expect, it } from 'vitest';
import { derivedAutofill, splitLocation, splitName } from '../src/model/autofill.js';

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
