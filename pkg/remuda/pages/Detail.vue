<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { useRoute, useRouter } from 'vue-router';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import { useText } from '../utils/i18n';
import ConfirmDelete from '../components/ConfirmDelete.vue';
import {
  hopAddresses, list, rebuildUi, resourceUrl, resyncHop
} from '../utils/api';
import { ingressEntry } from '../utils/discovery';
import { hopHasDrifted } from '../utils/hop';
import { isIncomplete, runStateOf } from '../utils/status';
import {
  canRebuild, crIncomplete, crRunState, deleteRecord, findEnvironment, setRecordRunning
} from '../utils/environments';
import { environmentUrl, resourceBase, sharedDashboardIndexUrl } from '../utils/manifests';
import {
  BLANK_CLUSTER, ENDPOINTS, HOST_CLUSTER_ID, LABEL_NAME, PRODUCT_NAME, WILDCARD_DNS_SUFFIX,
  BOOTSTRAP_USERNAME
} from '../utils/constants';
import type { EnvironmentRecord, IngressEntry, RemudaSpec, RunState } from '../types';

const store = useStore();
const route = useRoute();
const router = useRouter();
const i18n = useText(store);

const clusterId = route.params.clusterId as string;
const envName = route.params.name as string;

const loading = ref(true);
const error = ref('');
const spec = ref<RemudaSpec | null>(null);
/** Kept alongside spec so the actions know which record they are acting on. */
const record = ref<EnvironmentRecord | null>(null);
/** Rebuild has no CR equivalent yet -- the controller builds once. */
const rebuildable = computed(() => !!record.value && canRebuild(record.value));
const password = ref('');
const revealed = ref(false);
const runState = ref<RunState>('pending');
const backendReady = computed(() => runState.value === 'ready');
// Distinct from runState: the Deployment existing at all is what says the create
// got far enough, regardless of whether its pod is up -- or scaled to zero.
const hasBackend = ref(false);
const jobs = ref<any[]>([]);
const confirmDelete = ref<any>(null);
// Both sides of the drift comparison, refreshed on every poll: what the target
// cluster says its ingress is, and what the hop is actually dialling.
const liveEntry = ref<IngressEntry | undefined>(undefined);
const activeAddresses = ref<string[]>([]);
let timer: any = null;

const url = computed(() => (spec.value ? environmentUrl(spec.value) : ''));
const assetBase = computed(() => (spec.value ? resourceBase(spec.value) : ''));
const indexUrl = computed(() => (spec.value ? sharedDashboardIndexUrl(spec.value) : ''));
// A Rancher elsewhere fetches this index server-side and verifies the certificate
// like any other client. Without an issuer the ingress has no TLS block and
// traefik answers with its own self-signed default, which that fetch rejects --
// so the URL is still worth showing, but it will not work off this host as-is.
const indexTrusted = computed(() => !!spec.value?.clusterIssuer);

const latestJob = computed(() => [...jobs.value]
  .sort((a, b) => (b.metadata?.creationTimestamp || '').localeCompare(a.metadata?.creationTimestamp || ''))[0]);

const buildState = computed(() => {
  const job = latestJob.value;

  if (!job) {
    return 'unknown';
  }

  if (job.status?.succeeded) {
    return 'ready';
  }

  return job.status?.failed ? 'failed' : 'building';
});

/**
 * Rancher's service proxy reaches the backend without leaving the host, which is
 * useful for checking the pod answers at all. It is not a usable way to browse
 * the nested UI -- absolute /dashboard and /v1 paths break under a path prefix.
 */
// Recorded but never built. The page still renders, because deleting it is the
// way out and that needs the spec.
const incomplete = computed(() => !!spec.value && isIncomplete(spec.value, backendReady.value || hasBackend.value));

const hop = computed(() => spec.value?.hop);
const hopDrifted = computed(() => hopHasDrifted(activeAddresses.value, liveEntry.value?.addresses || []));
const hopIsPublic = computed(() => hop.value?.addressType === 'ExternalIP');

/**
 * A downstream environment with no hop is reached directly on its own cluster's
 * ingress -- see exposureFor(). Read off the spec rather than recorded on it,
 * so environments created before the mode existed classify correctly too.
 */
const usesDirect = computed(() => !!spec.value && spec.value.clusterId !== HOST_CLUSTER_ID && !spec.value.hop);
const directAddresses = computed(() => liveEntry.value?.addresses?.join(', ') || '');
const directIsPublic = computed(() => usesDirect.value && liveEntry.value?.addressType === 'ExternalIP');

/**
 * A direct environment whose cluster has moved out from under its hostname.
 *
 * Only detectable for a wildcard-derived name, where the address is *in* the
 * hostname -- and only reportable, not repairable: the address is also baked
 * into the UI bundle's asset URLs at build time, so the way back is to recreate
 * the environment. The hop exists precisely because it can be repointed instead.
 */
const directDrifted = computed(() => {
  const hostname = spec.value?.hostname || '';
  const live = liveEntry.value?.addresses || [];

  return usesDirect.value && hostname.endsWith(WILDCARD_DNS_SUFFIX) &&
    live.length > 0 && !live.some((address) => hostname.includes(address));
});

const peekUrl = computed(() => (spec.value ? `/k8s/clusters/${ clusterId }/api/v1/namespaces/${ spec.value.namespace }/services/http:${ spec.value.name }:80/proxy/` : ''));

async function loadPassword(env: RemudaSpec) {
  try {
    const secret = await store.dispatch('management/request', { url: resourceUrl(clusterId, ENDPOINTS.secret, env.namespace, `${ env.name }-bootstrap`) });

    password.value = secret?.data?.password ? atob(secret.data.password) : '';
  } catch {
    password.value = '';
  }
}

async function load() {
  try {
    const found = await findEnvironment(store, clusterId, envName);

    record.value = found || null;
    spec.value = found?.spec || null;

    if (!found) {
      error.value = i18n.t('remuda.error.loadFailed');

      return;
    }

    const [deployments, allJobs] = await Promise.all([
      list(store, clusterId, ENDPOINTS.deployment).catch(() => ({ data: [] })),
      list(store, clusterId, ENDPOINTS.job).catch(() => ({ data: [] })),
    ]);

    const backend = (deployments.data || []).find((d: any) => d.metadata?.name === found.spec.name);

    // The controller writes the same objects with the same labels, so build
    // history reads identically either way. Only run state and completeness come
    // from the CR, because it reports them directly instead of being inferred.
    hasBackend.value = found.source === 'cr' ? !crIncomplete(found.cr!) : !!backend;
    runState.value = found.source === 'cr' ? crRunState(found.cr!) : runStateOf(backend);
    jobs.value = (allJobs.data || []).filter((j: any) => j.metadata?.labels?.[LABEL_NAME] === found.spec.name);

    if (!password.value) {
      await loadPassword(found.spec);
    }

    // The controller reconciles a CR's hop on its own schedule, so the page has
    // nothing to repair -- and rewriting the EndpointSlice from here would race
    // the thing that owns it.
    if (found.source === 'legacy') {
      await refreshHop(found.spec);
    }
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.loadFailed');
  } finally {
    loading.value = false;
  }
}

/**
 * Notice, and quietly repair, a hop pointing at a node that no longer exists.
 *
 * Replacing a downstream node changes the addresses the hop dials and nothing
 * else, so the fix is to rewrite one EndpointSlice. Folded into the existing
 * poll rather than made a separate concern: an environment that has silently
 * stopped answering is exactly what someone opens this page to find out about.
 *
 * This only self-heals while the page is open, which is the whole reason a
 * controller is worth building later.
 */
async function refreshHop(env: RemudaSpec) {
  // A direct environment has no hop to repair, but its cluster's entry point is
  // still worth reading: it is what the page compares the hostname against to
  // notice the one kind of drift this mode cannot recover from.
  if (!env.hop) {
    if (env.clusterId !== HOST_CLUSTER_ID) {
      liveEntry.value = await ingressEntry(store, env.clusterId, env.ingressClass);
    }

    return;
  }

  const [entry, active] = await Promise.all([
    ingressEntry(store, env.hop.targetClusterId, env.ingressClass),
    hopAddresses(store, env),
  ]);

  liveEntry.value = entry;
  activeAddresses.value = active;

  if (!hopHasDrifted(active, entry?.addresses || [])) {
    return;
  }

  try {
    await resyncHop(store, env, entry as IngressEntry);
    activeAddresses.value = entry?.addresses || [];
  } catch {
    // Reported by the button, not by the poll -- a background repair that
    // failed should not replace whatever the user is currently reading.
  }
}

async function resync(cb: (ok: boolean) => void) {
  try {
    const env = spec.value as RemudaSpec;
    const entry = await ingressEntry(store, env.hop?.targetClusterId || '', env.ingressClass);

    if (!entry || !await resyncHop(store, env, entry)) {
      throw new Error(i18n.t('remuda.error.resyncFailed'));
    }

    liveEntry.value = entry;
    activeAddresses.value = entry.addresses;
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.resyncFailed');
    cb(false);
  }
}

async function rebuild(cb: (ok: boolean) => void) {
  try {
    await rebuildUi(store, clusterId, spec.value as RemudaSpec);
    await load();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.rebuildFailed');
    cb(false);
  }
}

/**
 * Scaling both Deployments is the whole of stop and start, and nothing an
 * environment holds is lost either way, so neither asks for confirmation the way
 * delete does. Reloading immediately rather than waiting for the poll is what
 * stops the button offering the action it has just performed.
 */
async function setRunning(running: boolean, cb: (ok: boolean) => void) {
  try {
    await setRecordRunning(store, clusterId, record.value as EnvironmentRecord, running);
    await load();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t(running ? 'remuda.error.startFailed' : 'remuda.error.stopFailed');
    cb(false);
  }
}

const start = (cb: (ok: boolean) => void) => setRunning(true, cb);
const stop = (cb: (ok: boolean) => void) => setRunning(false, cb);

async function remove(cb: (ok: boolean) => void) {
  try {
    await deleteRecord(store, clusterId, record.value as EnvironmentRecord);
    cb(true);
    router.push({ name: `${ PRODUCT_NAME }-c-cluster-environments`, params: { cluster: BLANK_CLUSTER } });
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.deleteFailed');
    cb(false);
  }
}

const copy = (value: string) => navigator.clipboard?.writeText(value);

onMounted(() => {
  load();
  timer = setInterval(load, 15000);
});

onUnmounted(() => clearInterval(timer));
</script>

<template>
  <Loading v-if="loading" />
  <div v-else>
    <h1>{{ envName }}</h1>
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <template v-if="spec">
      <Banner
        v-if="incomplete"
        color="warning"
        :label="i18n.t('remuda.detail.incomplete')"
      />
      <Banner
        v-else-if="runState === 'stopped'"
        color="info"
        :label="i18n.t('remuda.detail.stopped')"
      />
      <Banner
        v-else-if="runState === 'stopping'"
        color="info"
        :label="i18n.t('remuda.detail.stoppingHint')"
      />

      <p class="text-muted">
        {{ i18n.t('remuda.detail.isolated') }}
      </p>

      <h3>{{ i18n.t('remuda.detail.access') }}</h3>
      <dl class="remuda-facts">
        <dt>{{ i18n.t('remuda.detail.url') }}</dt>
        <dd>
          <a
            :href="url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ url }}</a>
        </dd>

        <dt>{{ i18n.t('remuda.detail.username') }}</dt>
        <dd>
          <code>{{ BOOTSTRAP_USERNAME }}</code>
          <RcButton
            variant="link"
            size="small"
            @click="copy(BOOTSTRAP_USERNAME)"
          >
            Copy
          </RcButton>
        </dd>

        <dt>{{ i18n.t('remuda.detail.password') }}</dt>
        <dd>
          <code v-if="revealed">{{ password }}</code>
          <code v-else>••••••••••••</code>
          <RcButton
            variant="link"
            size="small"
            @click="revealed = !revealed"
          >
            {{ revealed ? 'Hide' : 'Show' }}
          </RcButton>
          <RcButton
            variant="link"
            size="small"
            @click="copy(password)"
          >
            Copy
          </RcButton>
        </dd>

        <dt>{{ i18n.t('remuda.list.columns.backend') }}</dt>
        <dd>{{ i18n.t(`remuda.state.${runState}`) }}</dd>

        <dt>{{ i18n.t('remuda.list.columns.build') }}</dt>
        <dd>{{ i18n.t(`remuda.state.${buildState}`) }}</dd>
      </dl>

      <h3>{{ i18n.t('remuda.detail.source') }}</h3>
      <dl class="remuda-facts">
        <dt>{{ i18n.t('remuda.create.repoLabel') }}</dt>
        <dd><code>{{ spec.repo }}</code></dd>

        <dt>{{ i18n.t('remuda.create.branchLabel') }}</dt>
        <dd><code>{{ spec.branch }}</code></dd>

        <dt>{{ i18n.t('remuda.detail.backendImage') }}</dt>
        <dd><code>{{ spec.backendImage }}</code></dd>

        <dt>Asset base</dt>
        <dd><code>{{ assetBase }}</code></dd>

        <dt>{{ i18n.t('remuda.detail.peek') }}</dt>
        <dd>
          <a
            :href="peekUrl"
            target="_blank"
            rel="noopener noreferrer"
          >{{ i18n.t('remuda.detail.peek') }}</a>
        </dd>
      </dl>

      <template v-if="!incomplete">
        <h3>{{ i18n.t('remuda.detail.share') }}</h3>
        <Banner
          color="info"
          :label="i18n.t('remuda.detail.shareHint')"
        />
        <Banner
          v-if="!indexTrusted"
          color="warning"
          :label="i18n.t('remuda.detail.shareUntrusted')"
        />
        <dl class="remuda-facts">
          <dt>{{ i18n.t('remuda.detail.shareIndex') }}</dt>
          <dd>
            <code>{{ indexUrl }}</code>
            <RcButton
              variant="link"
              size="small"
              @click="copy(indexUrl)"
            >
              Copy
            </RcButton>
          </dd>
        </dl>
      </template>

      <template v-if="hop">
        <h3>{{ i18n.t('remuda.detail.networking') }}</h3>
        <Banner
          v-if="hopDrifted"
          color="warning"
          :label="i18n.t('remuda.detail.hopDrifted')"
        />
        <Banner
          v-else-if="hopIsPublic"
          color="info"
          :label="i18n.t('remuda.warning.hopIsPublic', { address: hop.addresses.join(', ') })"
        />
        <dl class="remuda-facts">
          <dt>{{ i18n.t('remuda.detail.hopRoute') }}</dt>
          <dd><code>{{ hop.hostClusterId }} &rarr; {{ (activeAddresses.length ? activeAddresses : hop.addresses).join(', ') }}:{{ hop.port }}</code></dd>

          <dt>{{ i18n.t('remuda.detail.hopAddressType') }}</dt>
          <dd><code>{{ hop.addressType }}</code></dd>
        </dl>
        <p class="text-muted">
          {{ i18n.t('remuda.detail.hopSelfHealHint') }}
        </p>
      </template>

      <template v-else-if="usesDirect">
        <h3>{{ i18n.t('remuda.detail.networking') }}</h3>
        <Banner
          v-if="directDrifted"
          color="error"
          :label="i18n.t('remuda.detail.directDrifted', { address: directAddresses })"
        />
        <Banner
          v-else-if="directIsPublic"
          color="info"
          :label="i18n.t('remuda.warning.directIsPublic', { address: directAddresses })"
        />
        <dl class="remuda-facts">
          <dt>{{ i18n.t('remuda.detail.directRoute') }}</dt>
          <dd><code>{{ spec.clusterId }} &rarr; {{ directAddresses || spec.hostname }}:{{ spec.entryPort || 443 }}</code></dd>

          <dt>{{ i18n.t('remuda.detail.hopAddressType') }}</dt>
          <dd><code>{{ liveEntry?.addressType || '&mdash;' }}</code></dd>
        </dl>
        <p class="text-muted">
          {{ i18n.t('remuda.detail.directHint') }}
        </p>
      </template>

      <p class="text-muted">
        {{ i18n.t('remuda.detail.buildLogHint') }}
      </p>

      <!--
        Stop sits beside Delete, so an unexplained verb reads as destructive.
        The promise it makes is the same one `stopped` makes afterwards; saying
        it here is what lets someone decide rather than find out.
      -->
      <p
        v-if="runState === 'ready' || runState === 'pending'"
        class="text-muted"
      >
        {{ i18n.t('remuda.detail.stopHint') }}
      </p>

      <div class="remuda-actions">
        <!--
          AsyncButton has no `label` prop -- it takes a label per phase, and
          otherwise falls back to asyncButton.<mode>.<phase>. Passing `label`
          did nothing, so this button read "Apply" on a page where that means
          nothing to anyone.
        -->
        <!--
          Hidden rather than disabled for a CR-backed environment: the controller
          builds once and has no rebuild trigger yet, so there is nothing to
          explain by showing a control that cannot work.
        -->
        <AsyncButton
          v-if="rebuildable"
          mode="apply"
          :action-label="i18n.t('remuda.detail.rebuild')"
          :waiting-label="i18n.t('remuda.detail.rebuilding')"
          :success-label="i18n.t('remuda.detail.rebuild')"
          @click="rebuild"
        />
        <AsyncButton
          v-if="runState === 'ready' || runState === 'pending'"
          mode="apply"
          action-color="role-secondary"
          :action-label="i18n.t('remuda.detail.stop')"
          :waiting-label="i18n.t('remuda.detail.stopping')"
          :success-label="i18n.t('remuda.detail.stop')"
          @click="stop"
        />
        <!--
          A start issued while the old pod is still terminating produces one
          stuck Pending on a RWO volume that is still attached, so `stopping`
          offers the button and refuses it rather than hiding it.
        -->
        <AsyncButton
          v-else
          mode="apply"
          action-color="role-secondary"
          :action-label="i18n.t('remuda.detail.start')"
          :waiting-label="i18n.t('remuda.detail.starting')"
          :success-label="i18n.t('remuda.detail.start')"
          :disabled="runState === 'stopping'"
          @click="start"
        />
        <AsyncButton
          v-if="hop"
          mode="apply"
          :action-label="i18n.t('remuda.detail.resync')"
          :waiting-label="i18n.t('remuda.detail.resyncing')"
          :success-label="i18n.t('remuda.detail.resync')"
          @click="resync"
        />
        <AsyncButton
          mode="delete"
          @click="(cb) => { cb(true); confirmDelete?.show(); }"
        />
      </div>

      <ConfirmDelete
        ref="confirmDelete"
        :name="spec.name"
        @confirm="remove"
      />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.remuda-facts {
  display: grid;
  gap: 8px 20px;
  grid-template-columns: max-content 1fr;
  margin-bottom: 20px;

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
  }
}

.remuda-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
</style>
