import { createBranchField } from '../branch-field';

/**
 * Drives the field the way LabeledSelect does.
 *
 * `select` writes the value *and* signals the selection, because LabeledSelect
 * emits both on one line:
 * `@update:modelValue="$emit('selecting', $event); $emit('update:value', $event)"`.
 * Simulating them together is the point -- the bug this covers was an assumption
 * that they could be interleaved with blur.
 */
function field(initial = '') {
  let value = initial;
  const f = createBranchField(() => value, (v) => {
    value = v;
  });

  return {
    search: f.search,
    blur:   f.blur,
    select: (v: string) => {
      value = v;
      f.select();
    },
    get value() {
      return value;
    },
  };
}

describe('createBranchField', () => {
  // The reported bug: type 172, pick task/17295-multi-idp from the results, and
  // the field still holds 172 -- the blur commit ran with the search text still
  // set and overwrote the selection.
  it('keeps a selection made from search results', () => {
    const f = field();

    f.search('172');
    f.select('task/17295-multi-idp');
    f.blur();

    expect(f.value).toBe('task/17295-multi-idp');
  });

  // The case blur exists for: a repository with no options at all, where nothing
  // can be picked and Enter is otherwise the only way to commit.
  it('commits text the user typed and never confirmed', () => {
    const f = field();

    f.search('feature/foo');
    f.blur();

    expect(f.value).toBe('feature/foo');
  });

  it('commits text typed after an earlier selection', () => {
    const f = field();

    f.search('172');
    f.select('task/17295-multi-idp');
    f.search('feature/foo');
    f.blur();

    expect(f.value).toBe('feature/foo');
  });

  it('leaves the value alone when the box was cleared before blurring', () => {
    const f = field('main');

    f.search('172');
    f.search('');
    f.blur();

    expect(f.value).toBe('main');
  });

  it('ignores whitespace-only input', () => {
    const f = field('main');

    f.search('   ');
    f.blur();

    expect(f.value).toBe('main');
  });

  it('does not rewrite the value when the typed text already matches it', () => {
    let writes = 0;
    const f = createBranchField(() => 'main', () => {
      writes++;
    });

    f.search('main');
    f.blur();

    expect(writes).toBe(0);
  });

  it('does not re-commit on a second blur after a selection', () => {
    const f = field();

    f.search('feature/foo');
    f.blur();
    f.select('task/17295-multi-idp');
    f.blur();

    expect(f.value).toBe('task/17295-multi-idp');
  });
});
