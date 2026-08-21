<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from '@shell/composables/useI18n';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import {
  deleteEnvironment, list, readEnvironments, rebuildUi, resourceUrl
} from '../utils/api';
import { environmentUrl, resourceBase } from '../utils/manifests';
import { BLANK_CLUSTER, ENDPOINTS, LABEL_NAME, PRODUCT_NAME } from '../utils/constants';
import type { DevEnvSpec } from '../types';

const store = useStore();
const route = useRoute();
const router = useRouter();
const i18n = useI18n(store);

const clusterId = route.params.clusterId as string;
const envName = route.params.name as string;

const loading = ref(true);
const error = ref('');
const spec = ref<DevEnvSpec | null>(null);
const password = ref('');
const revealed = ref(false);
const backendReady = ref(false);
const jobs = ref<any[]>([]);
let timer: any = null;

const url = computed(() => (spec.value ? environmentUrl(spec.value) : ''));
const assetBase = computed(() => (spec.value ? resourceBase(spec.value) : ''));

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
const peekUrl = computed(() => (spec.value ? `/k8s/clusters/${ clusterId }/api/v1/namespaces/${ spec.value.namespace }/services/http:${ spec.value.name }:80/proxy/` : ''));

async function loadPassword(env: DevEnvSpec) {
  try {
    const secret = await store.dispatch('management/request', { url: resourceUrl(clusterId, ENDPOINTS.secret, env.namespace, `${ env.name }-bootstrap`) });

    password.value = secret?.data?.password ? atob(secret.data.password) : '';
  } catch {
    password.value = '';
  }
}

async function load() {
  try {
    const specs = await readEnvironments(store, clusterId);
    const found = specs.find((s) => s.name === envName) || null;

    spec.value = found;

    if (!found) {
      error.value = i18n.t('devEnvs.error.loadFailed');

      return;
    }

    const [deployments, allJobs] = await Promise.all([
      list(store, clusterId, ENDPOINTS.deployment).catch(() => ({ data: [] })),
      list(store, clusterId, ENDPOINTS.job).catch(() => ({ data: [] })),
    ]);

    backendReady.value = ((deployments.data || [])
      .find((d: any) => d.metadata?.name === found.name)?.status?.readyReplicas || 0) > 0;
    jobs.value = (allJobs.data || []).filter((j: any) => j.metadata?.labels?.[LABEL_NAME] === found.name);

    if (!password.value) {
      await loadPassword(found);
    }
  } catch (e: any) {
    error.value = e?.message || i18n.t('devEnvs.error.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function rebuild(cb: (ok: boolean) => void) {
  try {
    await rebuildUi(store, clusterId, spec.value as DevEnvSpec);
    await load();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t('devEnvs.error.rebuildFailed');
    cb(false);
  }
}

async function remove(cb: (ok: boolean) => void) {
  try {
    await deleteEnvironment(store, clusterId, spec.value as DevEnvSpec);
    cb(true);
    router.push({ name: `${ PRODUCT_NAME }-c-cluster-environments`, params: { cluster: BLANK_CLUSTER } });
  } catch (e: any) {
    error.value = e?.message || i18n.t('devEnvs.error.deleteFailed');
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
      <h3>{{ i18n.t('devEnvs.detail.access') }}</h3>
      <dl class="dev-env-facts">
        <dt>{{ i18n.t('devEnvs.detail.url') }}</dt>
        <dd>
          <a
            :href="url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ url }}</a>
        </dd>

        <dt>{{ i18n.t('devEnvs.detail.password') }}</dt>
        <dd>
          <code v-if="revealed">{{ password }}</code>
          <code v-else>••••••••••••</code>
          <button
            class="btn btn-sm role-link"
            @click="revealed = !revealed"
          >
            {{ revealed ? 'Hide' : 'Show' }}
          </button>
          <button
            class="btn btn-sm role-link"
            @click="copy(password)"
          >
            Copy
          </button>
        </dd>

        <dt>{{ i18n.t('devEnvs.list.columns.backend') }}</dt>
        <dd>{{ backendReady ? i18n.t('devEnvs.state.ready') : i18n.t('devEnvs.state.pending') }}</dd>

        <dt>{{ i18n.t('devEnvs.list.columns.build') }}</dt>
        <dd>{{ i18n.t(`devEnvs.state.${buildState}`) }}</dd>
      </dl>

      <h3>{{ i18n.t('devEnvs.detail.source') }}</h3>
      <dl class="dev-env-facts">
        <dt>{{ i18n.t('devEnvs.create.repoLabel') }}</dt>
        <dd><code>{{ spec.repo }}</code></dd>

        <dt>{{ i18n.t('devEnvs.create.branchLabel') }}</dt>
        <dd><code>{{ spec.branch }}</code></dd>

        <dt>{{ i18n.t('devEnvs.detail.backendImage') }}</dt>
        <dd><code>{{ spec.backendImage }}</code></dd>

        <dt>Asset base</dt>
        <dd><code>{{ assetBase }}</code></dd>

        <dt>{{ i18n.t('devEnvs.detail.peek') }}</dt>
        <dd>
          <a
            :href="peekUrl"
            target="_blank"
            rel="noopener noreferrer"
          >{{ i18n.t('devEnvs.detail.peek') }}</a>
        </dd>
      </dl>

      <p class="text-muted">
        {{ i18n.t('devEnvs.detail.buildLogHint') }}
      </p>

      <div class="dev-env-actions">
        <AsyncButton
          mode="apply"
          :label="i18n.t('devEnvs.detail.rebuild')"
          @click="rebuild"
        />
        <AsyncButton
          mode="delete"
          @click="remove"
        />
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.dev-env-facts {
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

.dev-env-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
</style>
