<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import { RcDropdown, RcDropdownItem, RcDropdownTrigger } from '@components/RcDropdown';
import { BadgeState } from '@components/BadgeState';
import SortableTable from '@shell/components/SortableTable';
import { useText } from '../utils/i18n';
import ConfirmDelete from '../components/ConfirmDelete.vue';
import EmptyState from '../components/EmptyState.vue';
import { buildStateOf, isIncomplete, runStateOf } from '../utils/status';
import { list, readyClusters } from '../utils/api';
import {
  crBuildState, crIncomplete, crRunState, deleteRecord, fillDownstreamBuildState, listEnvironments,
  setRecordRunning
} from '../utils/environments';
import { environmentUrl } from '../utils/manifests';
import { relativeAge } from '../utils/age';
import { stateColor, tableHeaders, toRows } from '../utils/table';
import { ownerLabel, ownerNames } from '../utils/owners';
import { BLANK_CLUSTER, ENDPOINTS, PRODUCT_NAME } from '../utils/constants';
import type { EnvironmentRow } from '../utils/table';
import type { EnvironmentRecord, RemudaSummary } from '../types';

const store = useStore();
const router = useRouter();
const i18n = useText(store);
const confirmDelete = ref<any>(null);
const pendingDelete = ref<RemudaSummary | null>(null);

const loading = ref(true);
const error = ref('');
const rows = ref<RemudaSummary[]>([]);
/**
 * Owner IDs resolved to names, best-effort. Empty is the honest answer for a
 * user who cannot list users, and the column falls back to the ID.
 */
const owners = ref<Record<string, string>>({});
/**
 * Rows with a stop, start or delete in flight. Their menu item is refused until
 * it lands: the menu closes on click and scaling two Deployments is two round
 * trips, so nothing else would stop the same action being asked for twice.
 */
const busy = ref<Set<string>>(new Set());
let timer: any = null;

/**
 * Both records, rendered identically.
 *
 * A CR reports its own state, so its row costs no extra reads here. A legacy
 * environment has no status to report and its state is still derived from the
 * Deployments and Jobs -- which is why those two collections are fetched only
 * when there is a legacy environment left to need them.
 *
 * The one thing a CR cannot report is a downstream build, which Fleet does not
 * carry back to the host. fillDownstreamBuildState resolves those afterwards,
 * once, per target cluster.
 */
async function loadCluster(cluster: { id: string; name: string }): Promise<RemudaSummary[]> {
  const records = await listEnvironments(store, cluster.id);

  if (!records.length) {
    return [];
  }

  const needsWorkloads = records.some((r) => r.source === 'legacy');

  const [deployments, jobs] = needsWorkloads ? await Promise.all([
    list(store, cluster.id, ENDPOINTS.deployment).catch(() => ({ data: [] })),
    list(store, cluster.id, ENDPOINTS.job).catch(() => ({ data: [] })),
  ]) : [{ data: [] }, { data: [] }];

  return records.map((record) => {
    const { spec } = record;
    const common = {
      spec,
      source:      record.source,
      clusterId:   cluster.id,
      clusterName: cluster.name,
      url:         environmentUrl(spec),
    };

    if (record.source === 'cr' && record.cr) {
      return {
        ...common,
        // The CR lives on the host; the workload does not. Everything that
        // addresses the environment -- the detail route, the workload lookups
        // there -- needs the cluster it actually runs on.
        clusterId:  spec.clusterId || cluster.id,
        runState:   crRunState(record.cr),
        buildState: crBuildState(record.cr),
        incomplete: crIncomplete(record.cr),
        url:        record.cr.status?.url || common.url,
      };
    }

    const backend = (deployments.data || []).find((d: any) => d.metadata?.name === spec.name);

    return {
      ...common,
      runState:   runStateOf(backend),
      buildState: buildStateOf(jobs.data || [], spec.name),
      incomplete: isIncomplete(spec, !!backend),
    };
  });
}

async function load() {
  try {
    const clusters = await readyClusters(store);
    // One cluster failing to answer must not blank the whole list.
    const results = await Promise.all(clusters.map((c) => loadCluster(c).catch(() => [])));

    const named = results.flat();

    // Resolved after the flatten because a CR row's cluster is only known from
    // its spec, and may be a cluster other than the one it was listed under.
    for (const row of named) {
      row.clusterName = clusters.find((c) => c.id === row.clusterId)?.name || row.clusterId;
    }

    // Also after the flatten, and for the same reason: a downstream row's target
    // is only known from its spec, and the reads are batched across all of them.
    await fillDownstreamBuildState(store, named);

    rows.value = named;
    // After the rows, and never allowed to fail the load: a list of environments
    // with raw owner IDs is far better than no list.
    owners.value = await ownerNames(store, rows.value.map((r) => r.spec.owner));
    error.value = '';
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.loadFailed');
  } finally {
    loading.value = false;
  }
}

/**
 * The row carries provenance but not the CR itself: both operations address the
 * environment by name and re-read it, so keeping a copy would only give them a
 * stale one.
 */
const recordFor = (row: RemudaSummary): EnvironmentRecord => ({ source: row.source, spec: row.spec });

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
async function setRunning(row: EnvironmentRow, running: boolean) {
  busy.value.add(row.id);

  try {
    await setRecordRunning(store, row.clusterId, recordFor(row), running);
    await load();
  } catch (e: any) {
    error.value = e?.message || i18n.t(running ? 'remuda.error.startFailed' : 'remuda.error.stopFailed');
  } finally {
    busy.value.delete(row.id);
  }
}

async function remove(row: RemudaSummary, cb: (ok: boolean) => void) {
  try {
    await deleteRecord(store, row.clusterId, recordFor(row));
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

const detailRoute = (row: RemudaSummary) => ({
  name:   `${ PRODUCT_NAME }-c-cluster-detail`,
  params: {
    cluster: BLANK_CLUSTER, clusterId: row.clusterId, name: row.spec.name
  },
});

const isRunning = (row: RemudaSummary) => row.runState === 'ready' || row.runState === 'pending';

const toggleRunning = (row: EnvironmentRow) => setRunning(row, !isRunning(row));

const stopStartLabel = (row: RemudaSummary) => i18n.t(isRunning(row) ? 'remuda.list.stop' : 'remuda.list.start');

const headers = computed(() => tableHeaders(i18n.t));
const tableRows = computed(() => toRows(rows.value, (row) => ownerLabel(row.spec.owner, owners.value), i18n.t));

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
      <RcButton
        variant="primary"
        size="large"
        @click="goCreate"
      >
        {{ i18n.t('remuda.list.createAction') }}
      </RcButton>
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

    <SortableTable
      v-if="rows.length"
      :rows="tableRows"
      :headers="headers"
      key-field="id"
      default-sort-by="age"
      :table-actions="false"
      :row-actions="false"
      :paging="false"
    >
      <template #cell:name="{ row }">
        <router-link :to="detailRoute(row)">
          {{ row.name }}
        </router-link>
      </template>
      <template #cell:branch="{ row }">
        <code>{{ row.branch }}</code>
      </template>
      <template #cell:age="{ row }">
        {{ relativeAge(row.createdAt) }}
      </template>
      <template #cell:backend="{ row }">
        <BadgeState
          :color="stateColor(row.incomplete ? 'incomplete' : row.runState)"
          :label="row.runLabel"
        />
      </template>
      <template #cell:build="{ row }">
        <span v-if="row.incomplete">—</span>
        <BadgeState
          v-else
          :color="stateColor(row.buildState)"
          :label="row.buildLabel"
        />
      </template>
      <template #cell:url="{ row }">
        <span v-if="row.incomplete">—</span>
        <a
          v-else
          :href="row.url"
          target="_blank"
          rel="noopener noreferrer"
        >{{ row.hostname }}</a>
      </template>
      <template #cell:actions="{ row }">
        <RcDropdown>
          <RcDropdownTrigger
            variant="ghost"
            :aria-label="i18n.t('remuda.detail.moreActions')"
          >
            <i class="icon icon-actions" />
          </RcDropdownTrigger>
          <template #dropdownCollection>
            <!--
              A start issued while the old pod is still terminating leaves the
              new one Pending on a RWO volume still attached to it, so
              `stopping` offers the item and refuses it rather than hiding it.
            -->
            <RcDropdownItem
              v-if="!row.incomplete"
              :disabled="row.runState === 'stopping' || busy.has(row.id)"
              @click="toggleRunning(row)"
            >
              {{ stopStartLabel(row) }}
            </RcDropdownItem>
            <RcDropdownItem
              :disabled="busy.has(row.id)"
              @click="askDelete(row)"
            >
              {{ i18n.t('remuda.list.delete') }}
            </RcDropdownItem>
          </template>
        </RcDropdown>
      </template>
    </SortableTable>

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
</style>
