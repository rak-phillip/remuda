/**
 * The longest environment name every derived object can carry: the build Job is
 * `<name>-build-<10 digit timestamp>`, and a Job name is capped at 63. Matches
 * MAX_NAME in skills/remuda/env.mjs and the CRD's rule.
 */
export const MAX_ENVIRONMENT_NAME = 63 - '-build-'.length - 10;

/**
 * Whether a name can become every object an environment owns.
 *
 * The API server admits any DNS subdomain, dots included, but the name is also
 * a Service name -- a DNS-1035 label, so no dots and a leading letter. A name
 * like `mo-2.13-head` used to be accepted here and then sit in Pending forever
 * with "must not contain dots" on the hop Service.
 */
export function isEnvironmentName(name: string): boolean {
  return (name || '').length <= MAX_ENVIRONMENT_NAME && /^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(name || '');
}

/**
 * Whether a string looks like something `git clone` could take.
 *
 * Deliberately shape-only: it cannot tell whether a repository exists, and it is
 * not trying to. It catches the mistake that actually happens -- pasting an
 * owner URL like `https://github.com/rancher` with no repository name, which
 * clones as `https://github.com/rancher/` and fails with "Not Found". That
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
