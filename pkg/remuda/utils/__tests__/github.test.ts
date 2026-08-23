import { listBranches, parseGitHubRepo, searchBranches } from '../github';

const mockListMatchingRefs = jest.fn();
const mockListBranches = jest.fn();

/*
 * Offline on purpose: the real API allows 60 requests/hour per IP, which is not
 * something CI should be spending.
 *
 * This can sit below the import because github.ts builds its Octokit lazily. If
 * it ever goes back to constructing one at module scope, the client would be
 * built during that import -- before this file's consts exist -- and the mock
 * would fail with a temporal-dead-zone error rather than a useful one.
 */
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({
    rest: {
      git:   { listMatchingRefs: mockListMatchingRefs },
      repos: { listBranches: mockListBranches },
    },
  })),
}));

const REF = { owner: 'rancher', repo: 'dashboard' };

describe('parseGitHubRepo', () => {
  it.each([
    ['https://github.com/rancher/dashboard', 'rancher', 'dashboard'],
    ['http://github.com/rancher/dashboard', 'rancher', 'dashboard'],
    ['https://www.github.com/rancher/dashboard', 'rancher', 'dashboard'],
    ['github.com/rancher/dashboard', 'rancher', 'dashboard'],
    ['git@github.com:rancher/dashboard', 'rancher', 'dashboard'],
    // Trailing forms the create form sees pasted from a browser or a clone hint.
    ['https://github.com/rancher/dashboard.git', 'rancher', 'dashboard'],
    ['https://github.com/rancher/dashboard/', 'rancher', 'dashboard'],
  ])('reads %s as %s/%s', (url, owner, repo) => {
    expect(parseGitHubRepo(url)).toStrictEqual({ owner, repo });
  });

  // Undefined means "cannot be checked here", never "invalid" -- isCloneableRepo
  // is what decides validity, and it accepts all of these.
  it.each([
    ['https://gitlab.com/group/project'],
    ['https://git.internal.example.com/team/repo'],
    ['git@gitlab.com:group/project'],
  ])('declines to parse the non-GitHub host in %s', (url) => {
    expect(parseGitHubRepo(url)).toBeUndefined();
  });

  it('rejects an owner URL with no repository', () => {
    expect(parseGitHubRepo('https://github.com/rancher')).toBeUndefined();
  });

  it('rejects a path deeper than owner/repo', () => {
    // A tree or blob URL copied out of the GitHub UI. The build cannot clone it,
    // and guessing which prefix was meant would be a silent rewrite of input.
    expect(parseGitHubRepo('https://github.com/rancher/dashboard/tree/master')).toBeUndefined();
  });

  it.each([[''], ['   '], [null as any], [undefined as any]])('is undefined for %p', (value) => {
    expect(parseGitHubRepo(value)).toBeUndefined();
  });
});

describe('searchBranches', () => {
  beforeEach(() => mockListMatchingRefs.mockReset());

  it('strips the refs/heads/ prefix off what GitHub returns', async() => {
    mockListMatchingRefs.mockResolvedValue({ data: [{ ref: 'refs/heads/task/17295-multi-idp' }] });

    expect(await searchBranches(REF, 'task/17295')).toStrictEqual(['task/17295-multi-idp']);
  });

  it('asks for the prefix under heads/', async() => {
    mockListMatchingRefs.mockResolvedValue({ data: [] });

    await searchBranches(REF, 'task/17295');

    expect(mockListMatchingRefs).toHaveBeenCalledWith({
      owner: 'rancher', repo: 'dashboard', ref: 'heads/task/17295',
    });
  });

  // An empty ref makes matching-refs return every ref in the repository, which
  // is both slow and a waste of the hourly budget.
  it.each([[''], ['t'], ['  ']])('does not call the API for %p', async(prefix) => {
    expect(await searchBranches(REF, prefix)).toStrictEqual([]);
    expect(mockListMatchingRefs).not.toHaveBeenCalled();
  });

  it('fails soft when the lookup throws', async() => {
    // Rate limit, offline, anything. The field stays free text either way, so a
    // thrown error here would break the form for no benefit.
    mockListMatchingRefs.mockRejectedValue(new Error('rate limit exceeded'));

    expect(await searchBranches(REF, 'task/17295')).toStrictEqual([]);
  });
});

describe('listBranches', () => {
  const page = (n: number, prefix = 'b') => ({ data: Array.from({ length: n }, (_, i) => ({ name: `${ prefix }${ i }` })) });

  beforeEach(() => mockListBranches.mockReset());

  it('stops at the first short page and reports a complete list', async() => {
    mockListBranches.mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(20));

    const res = await listBranches(REF);

    expect(res.names).toHaveLength(120);
    expect(res.truncated).toBe(false);
    expect(mockListBranches).toHaveBeenCalledTimes(2);
  });

  // The whole point of holding every branch is that the caller can filter by
  // substring; a partial list silently presented as complete is what made a
  // branch that existed look absent.
  it('reports truncation when every page up to the cap came back full', async() => {
    mockListBranches.mockResolvedValue(page(100));

    const res = await listBranches(REF);

    expect(res.names).toHaveLength(1000);
    expect(res.truncated).toBe(true);
  });

  it('keeps what it collected and marks it incomplete when a page fails', async() => {
    mockListBranches.mockResolvedValueOnce(page(100)).mockRejectedValueOnce(new Error('rate limit'));

    const res = await listBranches(REF);

    expect(res.names).toHaveLength(100);
    expect(res.truncated).toBe(true);
  });

  it('is an empty, incomplete list when the very first page fails', async() => {
    mockListBranches.mockRejectedValue(new Error('offline'));

    expect(await listBranches(REF)).toStrictEqual({ names: [], truncated: true });
  });
});
