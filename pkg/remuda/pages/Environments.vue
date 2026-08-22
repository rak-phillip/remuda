<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import { useText } from '../utils/i18n';
import ConfirmDelete from '../components/ConfirmDelete.vue';
import EmptyState from '../components/EmptyState.vue';
import { deleteEnvironment, list, readEnvironments, readyClusters } from '../utils/api';
import { environmentUrl } from '../utils/manifests';
import { BLANK_CLUSTER, ENDPOINTS, LABEL_NAME, PRODUCT_NAME } from '../utils/constants';
import type { BuildState, RemudaSummary } from '../types';

const store = useStore();
const router = useRouter();
const i18n = useText(store);
const confirmDelete = ref<any>(null);
const pendingDelete = ref<RemudaSummary | null>(null);

const loading = ref(true);
const error = ref('');
const rows = ref<RemudaSummary[]>([]);
let timer: any = null;

function buildStateOf(jobs: any[], name: string): BuildState {
  const mine = jobs.filter((j) => j.metadata?.labels?.[LABEL_NAME] === name);

  if (!mine.length) {
    return 'unknown';
  }

  // Newest first, so a rebuild's state wins over the build it replaced.
  const latest = mine.sort((a, b) => (b.metadata?.creationTimestamp || '').localeCompare(a.metadata?.creationTimestamp || ''))[0];

  if (latest.status?.succeeded) {
    return 'ready';
  }

  return latest.status?.failed ? 'failed' : 'building';
}

async function loadCluster(cluster: { id: string; name: string }): Promise<RemudaSummary[]> {
  const specs = await readEnvironments(store, cluster.id);

  if (!specs.length) {
    return [];
  }

  const [deployments, jobs] = await Promise.all([
    list(store, cluster.id, ENDPOINTS.deployment).catch(() => ({ data: [] })),
    list(store, cluster.id, ENDPOINTS.job).catch(() => ({ data: [] })),
  ]);

  return specs.map((spec) => {
    const backend = (deployments.data || []).find((d: any) => d.metadata?.name === spec.name);

    return {
      spec,
      clusterId:    cluster.id,
      clusterName:  cluster.name,
      backendReady: (backend?.status?.readyReplicas || 0) > 0,
      buildState:   buildStateOf(jobs.data || [], spec.name),
      url:          environmentUrl(spec),
    };
  });
}

async function load() {
  try {
    const clusters = await readyClusters(store);
    // One cluster failing to answer must not blank the whole list.
    const results = await Promise.all(clusters.map((c) => loadCluster(c).catch(() => [])));

    rows.value = results.flat();
    error.value = '';
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.loadFailed');
  } finally {
    loading.value = false;
  }
}

function askDelete(row: RemudaSummary) {
  pendingDelete.value = row;
  confirmDelete.value?.show();
}

function confirmRemove(cb: (ok: boolean) => void) {
  const row = pendingDelete.value;

  if (!row) {
    cb(false);

    return;
  }

  remove(row, cb);
}

async function remove(row: RemudaSummary, cb: (ok: boolean) => void) {
  try {
    await deleteEnvironment(store, row.clusterId, row.spec);
    await load();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.deleteFailed');
    cb(false);
  }
}

const goCreate = () => router.push({
  name:   `${ PRODUCT_NAME }-c-cluster-create`,
  params: { cluster: BLANK_CLUSTER },
});

const goDetail = (row: RemudaSummary) => router.push({
  name:   `${ PRODUCT_NAME }-c-cluster-detail`,
  params: {
    cluster: BLANK_CLUSTER, clusterId: row.clusterId, name: row.spec.name
  },
});

const isEmpty = computed(() => !loading.value && !rows.value.length);

onMounted(() => {
  load();
  // Builds and rollouts take minutes; refresh so the list reflects them.
  timer = setInterval(load, 15000);
});

onUnmounted(() => clearInterval(timer));
</script>

<template>
  <Loading v-if="loading" />
  <div v-else>
    <header class="remuda-header">
      <h1>{{ i18n.t('remuda.list.title') }}</h1>
      <button
        class="btn role-primary"
        @click="goCreate"
      >
        {{ i18n.t('remuda.list.createAction') }}
      </button>
    </header>
    <p class="text-muted mb-20">
      {{ i18n.t('remuda.list.subtitle') }}
    </p>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <EmptyState
      v-if="isEmpty"
      icon="circle-plus"
      :title="i18n.t('remuda.list.emptyTitle')"
      :description="i18n.t('remuda.list.empty')"
    >
      <template #actions>
        <RcButton
          variant="primary"
          @click="goCreate"
        >
          {{ i18n.t('remuda.list.createAction') }}
        </RcButton>
      </template>
    </EmptyState>

    <table
      v-if="rows.length"
      class="remuda-table"
    >
      <thead>
        <tr>
          <th>{{ i18n.t('remuda.list.columns.name') }}</th>
          <th>{{ i18n.t('remuda.list.columns.cluster') }}</th>
          <th>{{ i18n.t('remuda.list.columns.branch') }}</th>
          <th>{{ i18n.t('remuda.list.columns.owner') }}</th>
          <th>{{ i18n.t('remuda.list.columns.backend') }}</th>
          <th>{{ i18n.t('remuda.list.columns.build') }}</th>
          <th>{{ i18n.t('remuda.list.columns.url') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="`${row.clusterId}/${row.spec.name}`"
        >
          <td>
            <a
              href="#"
              @click.prevent="goDetail(row)"
            >{{ row.spec.name }}</a>
          </td>
          <td>{{ row.clusterName }}</td>
          <td><code>{{ row.spec.branch }}</code></td>
          <td>{{ row.spec.owner }}</td>
          <td>
            {{ row.backendReady ? i18n.t('remuda.state.ready') : i18n.t('remuda.state.pending') }}
          </td>
          <td>{{ i18n.t(`remuda.state.${row.buildState}`) }}</td>
          <td>
            <a
              :href="row.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ row.spec.hostname }}</a>
          </td>
          <td>
            <RcButton
              size="small"
              class="bg-error"
              @click="askDelete(row)"
            >
              {{ i18n.t('remuda.list.delete') }}
            </RcButton>
          </td>
        </tr>
      </tbody>
    </table>

    <ConfirmDelete
      ref="confirmDelete"
      :name="pendingDelete?.spec?.name || ''"
      @confirm="confirmRemove"
    />
  </div>
</template>

<style lang="scss" scoped>
.remuda-header {
  align-items: center;
  display: flex;
  justify-content: space-between;
}

.remuda-table {
  border-collapse: collapse;
  width: 100%;

  th,
  td {
    border-bottom: 1px solid var(--border);
    padding: 8px 12px;
    text-align: left;
  }

  th {
    font-weight: 600;
  }
}
</style>
