/**
 * The search-text / committed-value dance that vue-select's `taggable` requires.
 *
 * Two values exist at once in that component: what is typed into the search box,
 * and what the field actually holds. Typing only becomes the value when an option
 * is picked or Enter creates a tag -- blur alone discards it. That is right for a
 * picker and wrong for a field whose whole point is that any branch name can be
 * typed, listed or not, so blur has to commit what was typed.
 *
 * Which makes the ordering between "a value was selected" and "the field blurred"
 * load-bearing, and it is the thing that broke: picking `task/17295-multi-idp`
 * out of a search for `172` left the field holding `172`, because the blur commit
 * ran with the search text still set and overwrote the selection.
 *
 * Lives here rather than in the SFC so that ordering can be asserted -- there is
 * no Vue test harness in this package, and reading the component's source is
 * exactly the approach that produced the bug.
 */
export interface BranchField {
  /** vue-select's `search` event: the user typed something. */
  search(query: string): void;
  /** LabeledSelect's `selecting` event: a value was committed by the component. */
  select(): void;
  /** LabeledSelect's `on-blur`: commit typed text the user never confirmed. */
  blur(): void;
}

export function createBranchField(get: () => string, set: (value: string) => void): BranchField {
  let query = '';

  return {
    search(next: string) {
      query = next;
    },

    /**
     * Selection wins, unconditionally. Emptying the query here is what stops the
     * blur commit from overwriting a real choice, and it is safe to do eagerly
     * because LabeledSelect emits `selecting` on the same line as `update:value`
     * -- the two cannot be interleaved.
     */
    select() {
      query = '';
    },

    blur() {
      const typed = query.trim();

      if (typed && typed !== get()) {
        set(typed);
      }
    },
  };
}
