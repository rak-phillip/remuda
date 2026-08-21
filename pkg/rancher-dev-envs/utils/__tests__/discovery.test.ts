import {
  backendImageForBranch, baseDomainFromServerUrl, cidrsOverlap, hostnameFor, pickNestedCidrs,
  widenToSixteen,
} from '../discovery';
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

  it('uses plain head for the line the host is on, which has no vX.Y-head tag', () => {
    // Docker Hub publishes the main line as `head` (plus per-commit
    // vX.Y-<sha>-head); only branched lines get the vX.Y-head alias, so
    // rancher/rancher:v2.16-head 404s while 2.16 is main.
    expect(backendImageForBranch('release-2.16', 'v2.16-ffbd1cc-head')).toBe(DEFAULT_BACKEND_IMAGE);
  });

  it('still pins older lines, which do have the alias', () => {
    expect(backendImageForBranch('release-2.15', 'v2.16-ffbd1cc-head')).toBe('rancher/rancher:v2.15-head');
    expect(backendImageForBranch('release-2.9', 'v2.16-ffbd1cc-head')).toBe('rancher/rancher:v2.9-head');
  });

  it('treats a branch ahead of the host as the main line too', () => {
    expect(backendImageForBranch('release-2.17', 'v2.16-ffbd1cc-head')).toBe(DEFAULT_BACKEND_IMAGE);
  });

  it('compares minors numerically, not as strings', () => {
    // '2.9' > '2.16' lexically; the comparison has to be numeric.
    expect(backendImageForBranch('release-2.9', 'v2.16-ffbd1cc-head')).toBe('rancher/rancher:v2.9-head');
    expect(backendImageForBranch('release-2.16', 'v2.9-abc-head')).toBe(DEFAULT_BACKEND_IMAGE);
  });

  it('falls back to the pinned tag when the host version is unreadable', () => {
    expect(backendImageForBranch('release-2.15')).toBe('rancher/rancher:v2.15-head');
    expect(backendImageForBranch('release-2.15', '')).toBe('rancher/rancher:v2.15-head');
  });

  // A feature branch carries no usable version signal, so don't invent one.
  it.each(['task/17295-multi-idp', 'master', '', undefined])('falls back to head for %s', (branch) => {
    expect(backendImageForBranch(branch as string)).toBe(DEFAULT_BACKEND_IMAGE);
  });
});

describe('cidrsOverlap', () => {
  it('detects a containing range', () => {
    expect(cidrsOverlap('10.42.0.0/24', '10.42.0.0/16')).toBe(true);
  });

  it('separates adjacent ranges', () => {
    expect(cidrsOverlap('10.44.0.0/16', '10.45.0.0/16')).toBe(false);
    expect(cidrsOverlap('10.42.0.0/16', '10.43.0.0/16')).toBe(false);
  });

  it('handles addresses above 2^31 without sign errors', () => {
    expect(cidrsOverlap('172.31.0.0/16', '172.31.5.0/24')).toBe(true);
    expect(cidrsOverlap('192.168.0.0/16', '10.0.0.0/8')).toBe(false);
  });

  it('treats an unparseable range as overlapping, so the candidate is skipped', () => {
    expect(cidrsOverlap('10.44.0.0/16', '')).toBe(true);
    expect(cidrsOverlap('10.44.0.0/16', 'nonsense')).toBe(true);
  });
});

describe('widenToSixteen', () => {
  it('rounds a node slice out to the range that contains it', () => {
    expect(widenToSixteen('10.42.0.0/24')).toBe('10.42.0.0/16');
  });

  it('accepts a bare address, as read off a Service ClusterIP', () => {
    expect(widenToSixteen('10.43.0.1')).toBe('10.43.0.0/16');
  });

  it('returns empty for junk rather than a plausible-looking range', () => {
    expect(widenToSixteen('')).toBe('');
    expect(widenToSixteen('10.43')).toBe('');
  });
});

describe('pickNestedCidrs', () => {
  it('takes the first candidate when the host uses the k3s defaults', () => {
    expect(pickNestedCidrs('10.42.0.0/16', '10.43.0.0/16')).toStrictEqual({
      nestedPodCidr:     '10.44.0.0/16',
      nestedServiceCidr: '10.45.0.0/16',
    });
  });

  it('steps past a candidate the host has already claimed', () => {
    // A host on 10.44/10.45 is exactly the case that would recreate the
    // original collision if the first candidate were used unconditionally.
    expect(pickNestedCidrs('10.44.0.0/16', '10.45.0.0/16')).toStrictEqual({
      nestedPodCidr:     '10.46.0.0/16',
      nestedServiceCidr: '10.47.0.0/16',
    });
  });

  it('skips a candidate that collides on either half', () => {
    expect(pickNestedCidrs('10.45.0.0/16', '10.99.0.0/16').nestedPodCidr).toBe('10.46.0.0/16');
  });

  it('falls back to the default pair when the host ranges are unreadable', () => {
    expect(pickNestedCidrs('', '')).toStrictEqual({
      nestedPodCidr:     '10.44.0.0/16',
      nestedServiceCidr: '10.45.0.0/16',
    });
  });
});
