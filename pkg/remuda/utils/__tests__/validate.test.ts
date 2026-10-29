import { MAX_ENVIRONMENT_NAME, isCloneableRepo, isEnvironmentName } from '../validate';

describe('isEnvironmentName', () => {
  it.each([
    'my-feature',
    'dashboard-task-17295-multi-idp',
    'a',
    'a'.repeat(MAX_ENVIRONMENT_NAME),
  ])('accepts %s', (name) => expect(isEnvironmentName(name)).toBe(true));

  it.each([
    // The one that actually happened: admitted, then Pending forever because the
    // hop Service cannot be named `mo-2.13-head-hop`.
    'mo-2.13-head',
    'My-Feature',
    '2-13-head',
    'trailing-',
    '-leading',
    'under_score',
    'a'.repeat(MAX_ENVIRONMENT_NAME + 1),
    '',
  ])('rejects %s', (name) => expect(isEnvironmentName(name)).toBe(false));
});

describe('isCloneableRepo', () => {
  it.each([
    'https://github.com/rancher/dashboard',
    'https://github.com/rak-phillip/dashboard.git',
    'https://github.com/rancher/dashboard/',
    'http://git.internal:3000/team/repo',
    'git@github.com:rancher/dashboard.git',
  ])('accepts %s', (repo) => expect(isCloneableRepo(repo)).toBe(true));

  it.each([
    // The one that actually happened: an owner URL with no repository. It clones
    // as https://github.com/rak-phillip/ and fails with "Not Found" -- but only
    // once the build Job runs, minutes after the form is gone.
    'https://github.com/rak-phillip',
    'https://github.com',
    'rancher/dashboard',
    'not a url',
    '',
  ])('rejects %s', (repo) => expect(isCloneableRepo(repo)).toBe(false));

  it('ignores surrounding whitespace, since these get pasted', () => {
    expect(isCloneableRepo('  https://github.com/rancher/dashboard  ')).toBe(true);
  });
});
