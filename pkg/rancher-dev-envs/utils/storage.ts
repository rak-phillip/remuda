import { ENDPOINTS, LABEL_MANAGED, LOCAL_PATH } from './constants';
import type { ManifestRequest } from '../types';

const labels = { [LABEL_MANAGED]: 'true', app: 'local-path-provisioner' };

/**
 * The provisioner's own config. `DEFAULT_PATH_FOR_NON_LISTED_NODES` is the
 * upstream sentinel meaning "every node that is not named explicitly", which is
 * what we want -- the extension has no reason to care which node it lands on.
 *
 * setup and teardown run in the helper pod to create and remove the directory
 * backing each volume; upstream ships them as shell scripts in this ConfigMap
 * rather than baking them into the image.
 */
const config = JSON.stringify({
  nodePathMap: [{
    node:  'DEFAULT_PATH_FOR_NON_LISTED_NODES',
    paths: [LOCAL_PATH.hostPath],
  }],
}, null, 2);

const setup = `#!/bin/sh
set -eu
mkdir -m 0777 -p "$VOL_DIR"
`;

const teardown = `#!/bin/sh
set -eu
rm -rf "$VOL_DIR"
`;

const helperPod = `apiVersion: v1
kind: Pod
metadata:
  name: helper-pod
spec:
  priorityClassName: system-node-critical
  tolerations:
    - key: node.kubernetes.io/disk-pressure
      operator: Exists
      effect: NoSchedule
  containers:
    - name: helper
      image: ${ LOCAL_PATH.helperImage }
      imagePullPolicy: IfNotPresent
`;

/**
 * Everything needed to give a cluster a default StorageClass, in dependency
 * order. Mirrors upstream's local-path-storage.yaml.
 *
 * Everything is labelled as managed by the extension so it is identifiable
 * later, but note this is *cluster* infrastructure, not an environment's: it is
 * deliberately not labelled with an environment name and is never removed when
 * an environment is deleted.
 */
export function localPathManifests(): ManifestRequest[] {
  const ns = LOCAL_PATH.namespace;
  const sa = LOCAL_PATH.serviceAccount;
  const meta = (name: string) => ({
    name, namespace: ns, labels
  });

  return [
    {
      endpoint: ENDPOINTS.namespace,
      body:     {
        apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels },
      },
    },
    {
      endpoint: ENDPOINTS.serviceaccount,
      body:     {
        apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(sa),
      },
    },
    {
      endpoint: ENDPOINTS.clusterrole,
      body:     {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind:       'ClusterRole',
        metadata:   { name: 'local-path-provisioner-role', labels },
        rules:      [
          {
            apiGroups: [''],
            resources: ['nodes', 'persistentvolumeclaims', 'configmaps', 'pods', 'pods/log'],
            verbs:     ['get', 'list', 'watch'],
          },
          {
            apiGroups: [''],
            resources: ['persistentvolumes'],
            verbs:     ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete'],
          },
          {
            apiGroups: [''], resources: ['events'], verbs: ['create', 'patch']
          },
          {
            apiGroups: [''], resources: ['pods'], verbs: ['create', 'delete'],
          },
          {
            apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: ['get', 'list', 'watch'],
          },
        ],
      },
    },
    {
      endpoint: ENDPOINTS.clusterrolebinding,
      body:     {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind:       'ClusterRoleBinding',
        metadata:   { name: 'local-path-provisioner-bind', labels },
        roleRef:    {
          apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'local-path-provisioner-role',
        },
        subjects: [{
          kind: 'ServiceAccount', name: sa, namespace: ns
        }],
      },
    },
    {
      endpoint: ENDPOINTS.configmap,
      body:     {
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   meta('local-path-config'),
        data:       {
          'config.json':    config,
          setup,
          teardown,
          'helperPod.yaml': helperPod,
        },
      },
    },
    {
      endpoint: ENDPOINTS.deployment,
      body:     {
        apiVersion: 'apps/v1',
        kind:       'Deployment',
        metadata:   meta('local-path-provisioner'),
        spec:       {
          replicas: 1,
          selector: { matchLabels: { app: 'local-path-provisioner' } },
          template: {
            metadata: { labels: { app: 'local-path-provisioner' } },
            spec:     {
              serviceAccountName: sa,
              containers:         [{
                name:            'local-path-provisioner',
                image:           LOCAL_PATH.image,
                imagePullPolicy: 'IfNotPresent',
                command:         [
                  'local-path-provisioner', 'start', '--config', '/etc/config/config.json',
                ],
                volumeMounts: [{ name: 'config-volume', mountPath: '/etc/config/' }],
                env:          [{
                  name:      'POD_NAMESPACE',
                  valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
                }],
              }],
              volumes: [{ name: 'config-volume', configMap: { name: 'local-path-config' } }],
            },
          },
        },
      },
    },
    {
      endpoint: ENDPOINTS.storageclass,
      body:     {
        apiVersion: 'storage.k8s.io/v1',
        kind:       'StorageClass',
        metadata:   {
          name:        LOCAL_PATH.storageClass,
          labels,
          // Marked default so anything else on the cluster that omits a class
          // -- including this extension's own PVCs -- also gets storage.
          annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
        },
        provisioner:       LOCAL_PATH.provisioner,
        // The bundle PVC is ReadWriteOnce and is shared between the build Job
        // and nginx, so binding must wait until a pod picks the node.
        volumeBindingMode: 'WaitForFirstConsumer',
        reclaimPolicy:     'Delete',
      },
    },
  ];
}
