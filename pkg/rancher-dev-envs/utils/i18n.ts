import { useI18n } from '@shell/composables/useI18n';

/**
 * i18n for strings rendered as text.
 *
 * `useI18n().t()` HTML-escapes its result by default -- `stringFor` in
 * `@shell/plugins/i18n` takes `escapehtml = true` -- which is right for
 * `v-clean-html`, where the string becomes innerHTML. Every string in this
 * extension is rendered through `{{ }}` or an attribute binding instead, and
 * those are already text nodes, so the escaping is applied a second time by Vue
 * and an apostrophe surfaces to the user as `&#39;`.
 *
 * Asking for the raw string is the fix. It stays safe because nothing here
 * renders a translation as HTML; if that ever changes, that call site should use
 * `useI18n` directly rather than this.
 */
export function useText(store: any): { t: (key: string, args?: unknown) => string } {
  const i18n = useI18n(store);

  return { t: (key: string, args?: unknown): string => i18n.t(key, args, true) };
}
