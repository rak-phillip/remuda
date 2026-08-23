import { Octokit } from '@octokit/rest';
import { GITHUB_BRANCH_PAGES, GITHUB_BRANCH_SEARCH_MIN, GITHUB_PER_PAGE } from './constants';

/**
 * Unauthenticated on purpose.
 *
 * The create form already takes a Git token *secret*, but that secret lives in
 * the cluster and is read by the build Job. Reading its value back into the
 * browser to spend on api.github.com would move a credential that currently
 * never leaves the cluster onto the wire to a third party, which is not a trade
 * worth making for a convenience check. So this only ever sees public data, and
 * a private repository is simply not checked -- see parseGitHubRepo().
 *
 * The cost is the unauthenticated rate limit: 60 requests/hour counted **per
 * IP**, so everyone behind one egress shares it. Every function here therefore
 * fails soft, and nothing it returns is allowed to block a create.
 */
let client: Octokit | undefined;

/**
 * Built on first use rather than at module scope, so importing this module costs
 * nothing for the many sessions that never touch the create form.
 */
function octokit(): Octokit {
  client ||= new Octokit({
    // A 404 is an expected outcome here, not a fault -- checkRepo turns it into
    // a value. Octokit's request-log plugin would otherwise print every mistyped
    // repository to the browser console as an error.
    log: {
      debug: () => undefined,
      info:  () => undefined,
      warn:  () => undefined,
      error: () => undefined,
    },
  });

  return client;
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** Outcome of looking a repository up. `unknown` means the lookup itself failed. */
export type RepoCheck = 'ok' | 'missing' | 'unknown';

/**
 * The owner/repo of a github.com clone URL, or undefined for anything else.
 *
 * Undefined is a perfectly normal answer: a GitLab URL, an internal git host or
 * an scp-style remote are all things the build clones happily, and none of them
 * can be checked here. Callers treat undefined as "not checkable", never as
 * "invalid" -- isCloneableRepo() is what decides validity.
 */
export function parseGitHubRepo(url: string): GitHubRepoRef | undefined {
  const value = (url || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');

  const match = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/i) ||
    value.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);

  if (!match) {
    return undefined;
  }

  return { owner: match[1], repo: match[2] };
}

/** Whether a public repository exists. Never throws. */
export async function checkRepo(ref: GitHubRepoRef): Promise<RepoCheck> {
  try {
    await octokit().rest.repos.get({ owner: ref.owner, repo: ref.repo });

    return 'ok';
  } catch (e: any) {
    // A private repository is indistinguishable from a missing one without
    // credentials -- both are 404, deliberately, so GitHub does not leak which
    // private repositories exist. Reporting "missing" would therefore be wrong
    // as often as it is right for anyone using a private fork.
    if (e?.status === 404) {
      return 'missing';
    }

    // 403/429 is the rate limit; anything else is the network. Either way the
    // answer is "could not tell", which the form renders as no opinion at all.
    return 'unknown';
  }
}

export interface BranchList {
  names: string[];
  /** True when the repository has more branches than the cap allowed. */
  truncated: boolean;
}

/**
 * Every branch of a public repository, up to the page cap.
 *
 * Fetched in full and up front so the caller can filter it by substring, which
 * is what people expect of a branch picker and what no GitHub endpoint available
 * to us offers -- see GITHUB_BRANCH_PAGES.
 *
 * `truncated` is the honest part: it says the list is not the whole repository,
 * so the caller can fall back to searchBranches() rather than quietly showing a
 * partial list as if it were complete. That mistake is exactly what made a
 * branch look absent when it existed.
 */
export async function listBranches(ref: GitHubRepoRef): Promise<BranchList> {
  const names: string[] = [];
  let truncated = false;

  try {
    for (let page = 1; page <= GITHUB_BRANCH_PAGES; page++) {
      const res = await octokit().rest.repos.listBranches({
        owner: ref.owner, repo: ref.repo, per_page: GITHUB_PER_PAGE, page,
      });
      const batch = res.data || [];

      names.push(...batch.map((b: any) => b.name));

      if (batch.length < GITHUB_PER_PAGE) {
        return { names, truncated: false };
      }

      // A full final page means there is at least one more we did not ask for.
      truncated = page === GITHUB_BRANCH_PAGES;
    }
  } catch {
    // Same contract as checkRepo: what was collected before the failure, marked
    // incomplete so the caller keeps the search fallback available.
    return { names, truncated: true };
  }

  return { names, truncated };
}

/**
 * Branch names beginning with `prefix`.
 *
 * **Prefix, not substring.** GitHub's REST branch list takes no query parameter
 * at all, so this uses git/matching-refs, which matches on the start of the ref.
 * The substring search people expect exists only on the GraphQL API
 * (`refs(query:)`), and that endpoint answers 403 to an unauthenticated
 * request -- measured -- so it is not available to us. In practice this means
 * typing `task/17295` finds `task/17295-multi-idp`, and typing `17295` alone
 * does not.
 *
 * Octokit percent-encodes the slashes in the prefix (`heads%2Ftask%2F17295`).
 * GitHub accepts that and matches correctly; verified against a live repository,
 * so do not be tempted to hand-build the path to "fix" it.
 */
export async function searchBranches(ref: GitHubRepoRef, prefix: string): Promise<string[]> {
  const value = (prefix || '').trim().replace(/^\/+/, '');

  if (value.length < GITHUB_BRANCH_SEARCH_MIN) {
    return [];
  }

  try {
    const res = await octokit().rest.git.listMatchingRefs({
      owner: ref.owner, repo: ref.repo, ref: `heads/${ value }`,
    });

    return (res.data || []).map((r: any) => `${ r.ref }`.replace(/^refs\/heads\//, ''));
  } catch {
    // Fails soft like everything else here: no suggestions, and the field is
    // still free text.
    return [];
  }
}
