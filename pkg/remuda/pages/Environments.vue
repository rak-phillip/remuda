<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import { useText } from '../utils/i18n';
import ConfirmDelete from '../components/ConfirmDelete.vue';
import EmptyState from '../components/EmptyState.vue';
import { buildStateOf, isIncomplete, runStateOf } from '../utils/status';
import {
  deleteEnvironment, list, readEnvironments, readyClusters, setEnvironmentRunning
} from '../utils/api';
import { environmentUrl } from '../utils/manifests';
import { BLANK_CLUSTER, ENDPOINTS, PRODUCT_NAME } from '../utils/constants';
import type { RemudaSummary } from '../types';

const store = useStore();
const router = useRouter();
const i18n = useText(store);
const confirmDelete = ref<any>(null);
const pendingDelete = ref<RemudaSummary | null>(null);

const loading = ref(true);
const error = ref('');
const rows = ref<RemudaSummary[]>([]);
let timer: any = null;

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
      clusterId:   cluster.id,
      clusterName: cluster.name,
      runState:    runStateOf(backend),
      buildState:  buildStateOf(jobs.data || [], spec.name),
      incomplete:  isIncomplete(spec, !!backend),
      url:         environmentUrl(spec),
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

/**
 * Stop and start are offered from the row because that is where someone doing
 * housekeeping across several environments is already looking. Nothing is lost
 * either way, so unlike delete neither asks for confirmation.
 */
async function setRunning(row: RemudaSummary, running: boolean, cb: (ok: boolean) => void) {
  try {
    await setEnvironmentRunning(store, row.clusterId, row.spec, running);
    await load();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t(running ? 'remuda.error.startFailed' : 'remuda.error.stopFailed');
    cb(false);
  }
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

/**
 * The callback is AsyncButton's, and has to reach setRunning: it is what returns
 * the button from its spinner to a resting state, so dropping it would leave the
 * button spinning for the full five-second timeout on every click.
 */
const toggleRunning = (row: RemudaSummary, cb: (ok: boolean) => void) => setRunning(
  row, row.runState === 'stopped', cb
);

const isRunning = (row: RemudaSummary) => row.runState === 'ready' || row.runState === 'pending';

const stopStartLabel = (row: RemudaSummary) => i18n.t(isRunning(row) ? 'remuda.list.stop' : 'remuda.list.start');
const stopStartWaitingLabel = (row: RemudaSummary) => i18n.t(isRunning(row) ? 'remuda.list.stopping' : 'remuda.list.starting');

const isEmpty = computed(() => !loading.value && !rows.value.length);
const hasIncomplete = computed(() => rows.value.some((r) => r.incomplete));

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
    <Banner
      v-if="hasIncomplete"
      color="warning"
      :label="i18n.t('remuda.list.incompleteHint')"
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
            <span
              v-if="row.incomplete"
              class="remuda-incomplete"
            >{{ i18n.t('remuda.state.incomplete') }}</span>
            <template v-else>
              {{ i18n.t(`remuda.state.${row.runState}`) }}
            </template>
          </td>
          <td>{{ row.incomplete ? '—' : i18n.t(`remuda.state.${row.buildState}`) }}</td>
          <td>
            <span v-if="row.incomplete">—</span>
            <a
              v-else
              :href="row.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ row.spec.hostname }}</a>
          </td>
          <td>
            <!--
              The flex row is an inner element rather than the cell itself:
              `display: flex` on a <td> takes it out of the table layout, so it
              stops sharing the row's height and its border-bottom no longer
              lines up with the other cells'.
            -->
            <div class="remuda-row-actions">
              <!--
                AsyncButton rather than RcButton: scaling two Deployments is two
                sequential round trips, and without the spinner the row looks
                inert until the next poll repaints it.

                A start issued while the old pod is still terminating leaves the
                new one Pending on a RWO volume still attached to it, so
                `stopping` shows the button disabled rather than hiding it.
              -->
              <AsyncButton
                v-if="!row.incomplete"
                mode="apply"
                size="sm"
                action-color="role-secondary"
                :action-label="stopStartLabel(row)"
                :waiting-label="stopStartWaitingLabel(row)"
                :success-label="stopStartLabel(row)"
                :disabled="row.runState === 'stopping'"
                @click="(cb) => toggleRunning(row, cb)"
              />
              <!--
                Tertiary rather than a red destructive button: RcButton has no
                destructive variant, and the `bg-error` utility this used to
                carry is not one. Its hover rule is `.bg-error.btn:hover`, which
                RcButton's own scoped `.variant-*` rules outrank -- so the button
                sat blue at rest and turned red only on hover.
              -->
              <RcButton
                variant="tertiary"
                size="small"
                @click="askDelete(row)"
              >
                {{ i18n.t('remuda.list.delete') }}
              </RcButton>
            </div>
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

.remuda-row-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.remuda-incomplete {
  color: var(--error);
  font-weight: 600;
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
