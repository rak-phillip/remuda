import { backendImageForBranch, baseDomainFromServerUrl, hostnameFor } from '../discovery';
import { DEFAULT_BACKEND_IMAGE } from '../constants';

describe('baseDomainFromServerUrl', () => {
  it.each([
    ['https://prak-bf3b08bd.ui.rancher.space', 'prak-bf3b08bd.ui.rancher.space'],
    ['https://prak-bf3b08bd.ui.rancher.space/', 'prak-bf3b08bd.ui.rancher.space'],
    ['http://rancher.example.com/dashboard', 'rancher.example.com'],
    ['', ''],
  ])('strips %s down to %s', (input, expected) => {
    expect(baseDomainFromServerUrl(input)).toBe(expected);
  });

  it('tolerates the setting being absent', () => {
    expect(baseDomainFromServerUrl(undefined as any)).toBe('');
  });
});

describe('hostnameFor', () => {
  it('composes the environment host under the wildcard domain', () => {
    expect(hostnameFor('multi-idp', 'prak-bf3b08bd.ui.rancher.space'))
      .toBe('multi-idp.prak-bf3b08bd.ui.rancher.space');
  });
});

describe('backendImageForBranch', () => {
  it('matches the backend to a release branch', () => {
    expect(backendImageForBranch('release-2.12')).toBe('rancher/rancher:v2.12-head');
    expect(backendImageForBranch('bugfix/release-2.9-thing')).toBe('rancher/rancher:v2.9-head');
  });

  // A feature branch carries no usable version signal, so don't invent one.
  it.each(['task/17295-multi-idp', 'master', '', undefined])('falls back to head for %s', (branch) => {
    expect(backendImageForBranch(branch as string)).toBe(DEFAULT_BACKEND_IMAGE);
  });
});
