import type { BuildState, RemudaSummary, RunState } from '../types';

/**
 * What the environments table reads.
 *
 * SortableTable sorts and searches on the values in the row, not on what a cell
 * renders. So each column gets a flat field holding the thing a reader would
 * sort by: the timestamp rather than "17h", the owner's name rather than their
 * ID, and the translated state.
 */
export interface EnvironmentRow extends RemudaSummary {
  id: string;
  name: string;
  branch: string;
  hostname: string;
  owner: string;
  createdAt: string;
  runLabel: string;
  buildLabel: string;
}

/** The colour of a state, in the classes BadgeState takes. */
export function stateColor(state: RunState | BuildState | 'incomplete'): string {
  switch (state) {
  case 'ready':
    return 'bg-success';
  case 'failed':
  case 'incomplete':
    return 'bg-error';
  case 'pending':
  case 'building':
  case 'stopping':
    return 'bg-info';
  default:
    // `unknown` is permanent and normal for a downstream build, and `stopped`
    // was asked for. Neither is a warning.
    return 'bg-darker';
  }
}

export function toRows(
  rows: RemudaSummary[],
  ownerOf: (row: RemudaSummary) => string,
  t: (key: string) => string
): EnvironmentRow[] {
  return rows.map((row) => ({
    ...row,
    // A name is only unique within a cluster.
    id:         `${ row.clusterId }/${ row.spec.name }`,
    name:       row.spec.name,
    branch:     row.spec.branch,
    hostname:   row.spec.hostname,
    owner:      ownerOf(row),
    createdAt:  row.spec.createdAt || '',
    runLabel:   t(`remuda.state.${ row.incomplete ? 'incomplete' : row.runState }`),
    buildLabel: row.incomplete ? '' : t(`remuda.state.${ row.buildState }`),
  }));
}

export function tableHeaders(t: (key: string) => string): any[] {
  const column = (name: string, value: string, labelKey: string, sort: string[] = [value]) => ({
    name, value, sort, search: [value], label: t(`remuda.list.columns.${ labelKey }`),
  });

  return [
    column('name', 'name', 'name'),
    column('cluster', 'clusterName', 'cluster'),
    column('branch', 'branch', 'branch'),
    column('owner', 'owner', 'owner'),
    // Descending first, so the first click on Age puts the newest on top, and
    // the name keeps equal ages in a stable order between polls.
    {
      ...column('age', 'createdAt', 'age', ['createdAt:desc', 'name']),
      search: false,
    },
    column('backend', 'runLabel', 'backend'),
    column('build', 'buildLabel', 'build'),
    column('url', 'hostname', 'url'),
    {
      name: 'actions', label: '', value: 'id', sort: false, search: false, width: 40, align: 'right',
    },
  ];
}
