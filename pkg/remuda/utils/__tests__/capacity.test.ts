import { DISK_PRESSURE_FRACTION, ESTIMATED_DISK_GB, diskShortfall, readNodeDisk } from '../capacity';

const GB = 1e9;

// shared's target node on 2026-10-14: 155.9 GB, with the free space it had at
// each point that day.
const node = (availableGb: number, name = 'prak-dev-envs-pool1-zx8x5-w8vh5') => ({
  name, capacityBytes: 155.9 * GB, availableBytes: availableGb * GB
});

describe('diskShortfall', () => {
  it('says nothing when the environment fits above the pressure line', () => {
    // 40 GB free, 23.4 GB floor: one more full environment leaves 32.
    expect(diskShortfall([node(40)], ESTIMATED_DISK_GB.ownBackend)).toBeUndefined();
  });

  it('warns when the environment would push the node under the line', () => {
    // 18 GB free was the morning the backends crashlooped.
    const got = diskShortfall([node(18)], ESTIMATED_DISK_GB.ownBackend);

    expect(got).toEqual({
      node:        'prak-dev-envs-pool1-zx8x5-w8vh5',
      availableGb: 18,
      capacityGb:  155.9,
      afterGb:     10,
      floorGb:     23.4,
    });
    expect(got!.floorGb).toBeCloseTo(155.9 * DISK_PRESSURE_FRACTION, 1);
  });

  it('lets a lighter environment through where a full one would not fit', () => {
    expect(diskShortfall([node(30)], ESTIMATED_DISK_GB.ownBackend)).toBeDefined();
    expect(diskShortfall([node(30)], ESTIMATED_DISK_GB.externalBackend)).toBeUndefined();
  });

  it('judges by the roomiest node, since any of them could be picked', () => {
    expect(diskShortfall([node(5, 'full'), node(60, 'roomy')], ESTIMATED_DISK_GB.ownBackend)).toBeUndefined();
    expect(diskShortfall([node(5, 'full'), node(20, 'tight')], ESTIMATED_DISK_GB.ownBackend)?.node).toBe('tight');
  });

  it('has no opinion without numbers', () => {
    expect(diskShortfall([], 8)).toBeUndefined();
    expect(diskShortfall([{
      name: 'x', capacityBytes: 0, availableBytes: 0
    }], 8)).toBeUndefined();
  });
});

describe('readNodeDisk', () => {
  const storeFor = (answers: Record<string, any>) => ({
    dispatch: jest.fn((_action: string, { url }: { url: string }) => {
      const answer = answers[url];

      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }),
  });

  const root = '/k8s/clusters/c-m-v9ql777p/api/v1/nodes';

  it('reads each node through the cluster proxy', async() => {
    const store = storeFor({
      [root]:                              { items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] },
      [`${ root }/a/proxy/stats/summary`]: { node: { fs: { capacityBytes: 100, availableBytes: 40 } } },
      [`${ root }/b/proxy/stats/summary`]: new Error('403'),
    });

    expect(await readNodeDisk(store, 'c-m-v9ql777p')).toEqual([{
      name: 'a', capacityBytes: 100, availableBytes: 40
    }]);
  });

  it('answers nothing, rather than failing, without permission to list nodes', async() => {
    expect(await readNodeDisk(storeFor({ [root]: new Error('403') }), 'c-m-v9ql777p')).toEqual([]);
  });
});
