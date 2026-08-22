/**
 * Whether a string looks like something `git clone` could take.
 *
 * Deliberately shape-only: it cannot tell whether a repository exists, and it is
 * not trying to. It catches the mistake that actually happens -- pasting an
 * owner URL like `https://github.com/rak-phillip` with no repository name, which
 * clones as `https://github.com/rak-phillip/` and fails with "Not Found". That
 * failure otherwise surfaces several minutes later as a failed build Job, long
 * after the create form has been dismissed.
 */
export function isCloneableRepo(repo: string): boolean {
  const value = (repo || '').trim().replace(/\/+$/, '');

  if (!value) {
    return false;
  }

  // scp-style: git@host:owner/repo
  if (/^[\w.-]+@[\w.-]+:[^/\s]+\/[^/\s]+$/.test(value)) {
    return true;
  }

  // http(s)://host/owner/repo -- at least two path segments after the host, so a
  // bare owner URL is rejected.
  return /^https?:\/\/[\w.-]+(:\d+)?(\/[^/\s]+){2,}$/.test(value);
}
