import {
  CONTROLLER_CHART, CONTROLLER_NAMESPACE, EXTENSION_VERSION, canInstallController,
  controllerAvailable, findControllerChart, installController
} from '../controller';

/**
 * A store that records what it was asked for, so a test can assert the request
 * as well as the answer -- the URLs here are the contract with Rancher.
 */
const storeOf = (handler: (req: any) => any) => {
  const calls: any[] = [];

  return {
    calls,
    dispatch: (_action: string, req: any) => {
      calls.push(req);

      const res = handler(req);

      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    },
  };
};

const repoList = (names: string[]) => ({ data: names.map((name) => ({ metadata: { name }, links: { index: `/x/${ name }` } })) });

describe('controllerAvailable', () => {
  it('probes the CRD, not the controller Deployment', async() => {
    // The API server accepts a CR the moment the CRD is registered, so a
    // restarting controller must not be reported as "cannot create".
    const store = storeOf(() => ({ id: 'environments.remuda.rancher.io' }));

    expect(await controllerAvailable(store)).toBe(true);
    expect(store.calls[0].url).toContain('apiextensions.k8s.io.customresourcedefinitions');
    expect(store.calls[0].url).toContain('environments.remuda.rancher.io');
  });

  it('treats a 404 as absent rather than as an error', async() => {
    // Which is the ordinary state of every cluster that has not installed it.
    expect(await controllerAvailable(storeOf(() => new Error('404')))).toBe(false);
  });
});

describe('canInstallController', () => {
  it('asks the API server whether this user may create a CRD', async() => {
    const store = storeOf(() => ({ status: { allowed: true } }));

    expect(await canInstallController(store)).toBe(true);

    const [req] = store.calls;

    // Steve's flattened selfsubjectaccessreviews rejects the POST with a 422,
    // so this has to go through the raw Kubernetes path.
    expect(req.url).toContain('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews');
    expect(req.method).toBe('POST');
    expect(req.data.spec.resourceAttributes).toEqual({
      group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions', verb: 'create',
    });
  });

  it('is false when the review says no', async() => {
    expect(await canInstallController(storeOf(() => ({ status: { allowed: false } })))).toBe(false);
  });

  it('is false rather than throwing when the review itself is refused', async() => {
    // A user who cannot even post the review certainly cannot install a CRD,
    // and the caller wants an answer rather than an exception.
    expect(await canInstallController(storeOf(() => new Error('403')))).toBe(false);
  });
});

describe('findControllerChart', () => {
  const withEntries = (byRepo: Record<string, string[]>) => storeOf((req: any) => {
    if (req.url.endsWith('clusterrepos')) {
      return repoList(Object.keys(byRepo));
    }

    const repo = req.url.split('/').pop().split('?')[0];
    const versions = byRepo[repo];

    return versions.length ? { entries: { [CONTROLLER_CHART]: versions.map((version) => ({ version })) } } : {};
  });

  it('finds the chart in whichever repository actually has it', async() => {
    const found = await findControllerChart(withEntries({ 'rancher-charts': [], 'my-own-name': ['9.9.9'] }));

    expect(found).toEqual({ repo: 'my-own-name', version: '9.9.9' });
  });

  it('prefers the version matching the extension, not the newest', async() => {
    // The two ship from one tag. A candidate extension paired with a stable
    // controller is a version skew nobody asked for.
    const found = await findControllerChart(withEntries({ stable: ['9.9.9'], rc: ['9.9.9', EXTENSION_VERSION] }));

    expect(found).toEqual({ repo: 'rc', version: EXTENSION_VERSION });
  });

  it('falls back to the newest when no version matches', async() => {
    const found = await findControllerChart(withEntries({ only: ['0.0.9', '0.0.1'] }));

    expect(found).toEqual({ repo: 'only', version: '0.0.9' });
  });

  it('returns nothing when no repository carries it', async() => {
    expect(await findControllerChart(withEntries({ 'rancher-charts': [] }))).toBeUndefined();
  });

  it('ignores a repository whose index cannot be read', async() => {
    // One unreachable repo must not hide a chart that another one has.
    const store = storeOf((req: any) => {
      if (req.url.endsWith('clusterrepos')) {
        return repoList(['broken', 'good']);
      }

      return req.url.includes('broken') ? new Error('500') : { entries: { [CONTROLLER_CHART]: [{ version: '1.2.3' }] } };
    });

    expect(await findControllerChart(store)).toEqual({ repo: 'good', version: '1.2.3' });
  });
});

describe('installController', () => {
  it('names the chart and version directly, bypassing catalog filtering', async() => {
    // Which is the whole point: Apps hides pre-release versions by default, so
    // a candidate repository renders as empty. The action does not care.
    const store = storeOf(() => ({ operationName: 'helm-operation-x' }));

    await installController(store, { repo: 'remuda-rc', version: '0.2.0-rc.5' });

    const [req] = store.calls;

    expect(req.url).toBe('/v1/catalog.cattle.io.clusterrepos/remuda-rc?action=install');
    expect(req.method).toBe('POST');
    expect(req.data.namespace).toBe(CONTROLLER_NAMESPACE);
    expect(req.data.wait).toBe(true);
    expect(req.data.charts[0]).toMatchObject({
      chartName: CONTROLLER_CHART, version: '0.2.0-rc.5', releaseName: CONTROLLER_CHART,
    });
  });

  it('does not swallow a failed install', async() => {
    // Unlike the probes, this one the user is waiting on and must hear about.
    await expect(installController(storeOf(() => new Error('403 forbidden')), { repo: 'remuda-rc', version: '0.2.0-rc.5' })).rejects.toThrow('403 forbidden');
  });
});
