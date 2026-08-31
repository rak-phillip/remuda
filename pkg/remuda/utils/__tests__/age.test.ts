import { relativeAge } from '../age';

const now = Date.parse('2026-08-31T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeAge', () => {
  it('steps through the units rather than combining them', () => {
    // The question a reader is answering is "is this one old", not "how old".
    expect(relativeAge(ago(30 * SECOND), now)).toBe('<1m');
    expect(relativeAge(ago(5 * MINUTE), now)).toBe('5m');
    expect(relativeAge(ago(3 * HOUR), now)).toBe('3h');
    expect(relativeAge(ago(2 * DAY), now)).toBe('2d');
    expect(relativeAge(ago(25 * HOUR), now)).toBe('1d');
  });

  it('rounds down at every boundary', () => {
    expect(relativeAge(ago(59 * SECOND), now)).toBe('<1m');
    expect(relativeAge(ago(60 * SECOND), now)).toBe('1m');
    expect(relativeAge(ago(59 * MINUTE), now)).toBe('59m');
    expect(relativeAge(ago(60 * MINUTE), now)).toBe('1h');
    expect(relativeAge(ago(23 * HOUR), now)).toBe('23h');
    expect(relativeAge(ago(24 * HOUR), now)).toBe('1d');
  });

  it('renders a skewed clock as new rather than as a negative age', () => {
    // The browser and the cluster do not share a clock, and a future timestamp
    // showing as "-1m" reads as a bug.
    expect(relativeAge(new Date(now + 5 * MINUTE).toISOString(), now)).toBe('<1m');
  });

  it('renders nothing it cannot parse, rather than NaN', () => {
    // A legacy record predating createdAt, or a CR whose metadata has not been
    // read back yet -- an empty cell is the honest answer for both.
    expect(relativeAge(undefined, now)).toBe('');
    expect(relativeAge('', now)).toBe('');
    expect(relativeAge('not a date', now)).toBe('');
  });
});
