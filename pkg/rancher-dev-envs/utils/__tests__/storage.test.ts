import { localPathManifests } from '../storage';
import { ENDPOINTS, LABEL_MANAGED, LABEL_NAME, LOCAL_PATH } from '../constants';

describe('localPathManifests', () => {
  const manifests = localPathManifests();
  const byKind = (kind: string): any => {
    const found = manifests.find((m) => m.body.kind === kind);

    if (!found) {
      throw new Error(`no ${ kind } in the local-path manifests`);
    }

    return found.body;
  };

  it('creates the namespace before anything that lives in it', () => {
    const nsIndex = manifests.findIndex((m) => m.body.kind === 'Namespace');
    const first = manifests.findIndex((m) => m.body.metadata.namespace === LOCAL_PATH.namespace);

    expect(nsIndex).toBeGreaterThan(-1);
    expect(nsIndex).toBeLessThan(first);
  });

  it('marks the class default, so PVCs that name no class still get storage', () => {
    // The extension's own PVCs omit storageClassName entirely, so this
    // annotation is what makes them bind at all.
    const sc = byKind('StorageClass');

    expect(sc.metadata.annotations['storageclass.kubernetes.io/is-default-class']).toBe('true');
    expect(sc.provisioner).toBe(LOCAL_PATH.provisioner);
  });

  it('binds late, because the bundle PVC is shared between two pods', () => {
    // ReadWriteOnce plus node-local storage means the build Job and nginx have
    // to land on the same node; binding early could pin the volume elsewhere.
    expect(byKind('StorageClass').volumeBindingMode).toBe('WaitForFirstConsumer');
  });

  it('grants the provisioner the pod permissions it needs for helper pods', () => {
    const rules = byKind('ClusterRole').rules;
    const podRule = rules.find((r: any) => r.resources.includes('pods') && r.verbs.includes('create'));

    expect(podRule).toBeDefined();
    expect(rules.some((r: any) => r.resources.includes('persistentvolumes') && r.verbs.includes('create'))).toBe(true);
  });

  it('binds the ClusterRole to the provisioner service account', () => {
    const crb = byKind('ClusterRoleBinding');

    expect(crb.subjects[0]).toStrictEqual({
      kind: 'ServiceAccount', name: LOCAL_PATH.serviceAccount, namespace: LOCAL_PATH.namespace,
    });
  });

  it('ships the config the provisioner reads at startup', () => {
    const cm = byKind('ConfigMap');
    const config = JSON.parse(cm.data['config.json']);

    expect(config.nodePathMap[0].node).toBe('DEFAULT_PATH_FOR_NON_LISTED_NODES');
    expect(cm.data.setup).toContain('mkdir');
    expect(cm.data.teardown).toContain('rm -rf');
    expect(cm.data['helperPod.yaml']).toContain(LOCAL_PATH.helperImage);
  });

  it('is cluster infrastructure, never owned by one environment', () => {
    // deleteEnvironment matches on LABEL_NAME; nothing here may carry it, or
    // deleting an environment would take the cluster's storage with it.
    for (const m of manifests) {
      expect(m.body.metadata.labels[LABEL_MANAGED]).toBe('true');
      expect(m.body.metadata.labels[LABEL_NAME]).toBeUndefined();
    }
  });

  it('uses endpoints the Steve client knows', () => {
    const known = Object.values(ENDPOINTS);

    for (const m of manifests) {
      expect(known).toContain(m.endpoint);
    }
  });
});
