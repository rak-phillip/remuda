import { stateColor, tableHeaders, toRows } from '../table';
import type { RemudaSummary } from '../../types';

const summary = (over: Partial<RemudaSummary> = {}): RemudaSummary => ({
  spec: {
    name: 'one', branch: 'main', hostname: 'one.example.com', owner: 'u-1', createdAt: '2026-10-01T00:00:00Z',
  } as any,
  source:      'cr',
  clusterId:   'c-1',
  clusterName: 'prod',
  runState:    'ready',
  buildState:  'building',
  incomplete:  false,
  url:         'https://one.example.com',
  ...over,
});

const t = (key: string) => key;

describe('toRows', () => {
  it('flattens what the table sorts on', () => {
    const [row] = toRows([summary()], () => 'Alice', t);

    expect(row).toMatchObject({
      id:         'c-1/one',
      name:       'one',
      owner:      'Alice',
      createdAt:  '2026-10-01T00:00:00Z',
      runLabel:   'remuda.state.ready',
      buildLabel: 'remuda.state.building',
    });
  });

  it('keeps two clusters\' environments of one name apart', () => {
    const rows = toRows([summary(), summary({ clusterId: 'c-2' })], () => '', t);

    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('reports an incomplete environment as that, with no build', () => {
    const [row] = toRows([summary({ incomplete: true })], () => '', t);

    expect(row.runLabel).toBe('remuda.state.incomplete');
    expect(row.buildLabel).toBe('');
  });

  it('has no createdAt to sort by on a legacy environment that lacks one', () => {
    const [row] = toRows([summary({ spec: { name: 'one' } as any })], () => '', t);

    expect(row.createdAt).toBe('');
  });
});

describe('tableHeaders', () => {
  it('sorts age on the timestamp, newest first', () => {
    const age = tableHeaders(t).find((h) => h.name === 'age');

    expect(age.sort[0]).toBe('createdAt:desc');
  });

  it('every column but the actions sorts on a field of the row', () => {
    const [row] = toRows([summary()], () => 'Alice', t);

    for (const header of tableHeaders(t).filter((h) => h.name !== 'actions')) {
      for (const field of header.sort) {
        expect(row).toHaveProperty(field.replace(':desc', ''));
      }
    }
  });
});

describe('stateColor', () => {
  it.each([
    ['ready', 'bg-success'],
    ['failed', 'bg-error'],
    ['incomplete', 'bg-error'],
    ['building', 'bg-info'],
    ['pending', 'bg-info'],
    ['stopped', 'bg-darker'],
    ['unknown', 'bg-darker'],
  ])('%s is %s', (state, color) => {
    expect(stateColor(state as any)).toBe(color);
  });
});
