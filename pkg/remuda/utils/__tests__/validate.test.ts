import { isCloneableRepo } from '../validate';

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
