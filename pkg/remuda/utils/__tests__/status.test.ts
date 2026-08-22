import { buildStateOf, isIncomplete } from '../status';
import { INCOMPLETE_AFTER_MS, LABEL_NAME } from '../constants';
import type { RemudaSpec } from '../../types';

const job = (name: string, status: any, created: string) => ({
  metadata: { labels: { [LABEL_NAME]: name }, creationTimestamp: created },
  status,
});

describe('buildStateOf', () => {
  it('is unknown when the environment has no jobs', () => {
    expect(buildStateOf([], 'multi-idp')).toBe('unknown');
  });

  it('ignores other environments jobs', () => {
    expect(buildStateOf([job('other', { succeeded: 1 }, '2026-01-01T00:00:00Z')], 'multi-idp')).toBe('unknown');
  });

  it.each([
    [{ succeeded: 1 }, 'ready'],
    [{ failed: 1 }, 'failed'],
    [{ active: 1 }, 'building'],
  ])('maps %p to %s', (status, expected) => {
    expect(buildStateOf([job('multi-idp', status, '2026-01-01T00:00:00Z')], 'multi-idp')).toBe(expected);
  });

  it('lets a rebuild win over the build it replaced', () => {
    const jobs = [
      job('multi-idp', { failed: 1 }, '2026-01-01T00:00:00Z'),
      job('multi-idp', { active: 1 }, '2026-01-02T00:00:00Z'),
    ];

    expect(buildStateOf(jobs, 'multi-idp')).toBe('building');
  });
});

describe('isIncomplete', () => {
  const now = Date.parse('2026-08-22T12:00:00Z');
  const spec = (createdAt: string) => ({ name: 'multi-idp', createdAt } as RemudaSpec);
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('is false whenever the backend Deployment exists', () => {
    // Present means the create reached its ninth manifest, so it got far enough
    // to be a real environment however old the record is.
    expect(isIncomplete(spec(ago(10 * 60 * 1000)), true, now)).toBe(false);
  });

  it('is true when the record has outlived the grace period with no Deployment', () => {
    // The case that prompted this: a create that died on a PVC still terminating
    // from the previous environment of the same name.
    expect(isIncomplete(spec(ago(INCOMPLETE_AFTER_MS + 1000)), false, now)).toBe(true);
  });

  it('stays quiet while a healthy create is still writing its manifests', () => {
    // The record is written first and the Deployment ninth, so there is always a
    // window where both are true of a perfectly good environment.
    expect(isIncomplete(spec(ago(5000)), false, now)).toBe(false);
  });

  it('says nothing when the timestamp cannot be read', () => {
    expect(isIncomplete(spec(''), false, now)).toBe(false);
    expect(isIncomplete({ name: 'x' } as RemudaSpec, false, now)).toBe(false);
  });
});
