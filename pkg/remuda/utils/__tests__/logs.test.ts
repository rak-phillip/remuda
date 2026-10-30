import { newestPod, openLogs } from '../logs';
import { LABEL_NAME, LABEL_ROLE } from '../constants';

const pod = (name: string, env: string, role: string, created: string) => ({
  metadata: {
    name,
    creationTimestamp: created,
    labels:            { [LABEL_NAME]: env, [LABEL_ROLE]: role },
  },
  links: { view: `https://rancher/k8s/clusters/c-1/api/v1/namespaces/ns/pods/${ name }` },
});

const spec = { name: 'one', namespace: 'ns' } as any;

function storeWith(pods: any[]) {
  return {
    dispatch: jest.fn((action: string) => Promise.resolve(action === 'management/request' ? { data: pods } : undefined)),
    getters:  {},
  };
}

describe('newestPod', () => {
  const pods = [
    pod('evicted', 'one', 'backend', '2026-10-01T00:00:00Z'),
    pod('current', 'one', 'backend', '2026-10-02T00:00:00Z'),
    pod('build', 'one', 'build', '2026-10-03T00:00:00Z'),
    pod('other', 'two', 'backend', '2026-10-04T00:00:00Z'),
  ];

  it('takes the newest of that environment and role', () => {
    expect(newestPod(pods, 'one', 'backend')?.metadata.name).toBe('current');
  });

  it('has nothing for a role with no pods', () => {
    expect(newestPod(pods, 'two', 'build')).toBeUndefined();
  });
});

describe('openLogs', () => {
  it('opens the window on the container that matters', async() => {
    const store = storeWith([pod('b1', 'one', 'build', '2026-10-03T00:00:00Z')]);

    await expect(openLogs(store, 'c-1', spec, 'build')).resolves.toBe(true);

    const [action, tab, opts] = store.dispatch.mock.calls.find(([a]: any[]) => a === 'wm/open') as any[];

    expect(action).toBe('wm/open');
    expect(tab.component).toBe('ContainerLogs');
    expect(tab.attrs.initialContainer).toBe('build');
    expect(tab.attrs.pod.links.view).toContain('/pods/b1');
    expect(tab.attrs.pod.nameDisplay).toBe('b1');
    expect(opts).toEqual({ root: true });
  });

  it('reports a pod that is gone rather than opening an empty window', async() => {
    const store = storeWith([]);

    await expect(openLogs(store, 'c-1', spec, 'build')).resolves.toBe(false);
    expect(store.dispatch).not.toHaveBeenCalledWith('wm/open', expect.anything(), expect.anything());
  });
});
