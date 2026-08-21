<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import AdvancedSection from '@shell/components/AdvancedSection.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import { useText } from '../utils/i18n';
import { createEnvironment, installLocalPathStorage, readyClusters } from '../utils/api';
import { backendImageForBranch, discoverDefaults, hostnameFor, saveDefaults } from '../utils/discovery';
import {
  BLANK_CLUSTER, DEFAULT_CACHE_SIZE_GB, DEFAULT_DATA_SIZE_GB, DEFAULT_NESTED_POD_CIDR,
  DEFAULT_NESTED_SERVICE_CIDR, DEFAULT_UI_SIZE_GB, REMUDA_NS, PRODUCT_NAME,
} from '../utils/constants';
import type { RemudaSpec } from '../types';

const store = useStore();
const router = useRouter();
const i18n = useText(store);

const loading = ref(true);
const error = ref('');
const clusters = ref<{ id: string; name: string; isLocal: boolean }[]>([]);

const clusterId = ref('');
const name = ref('');
const repo = ref('');
const branch = ref('');
const gitSecretName = ref('');
const backendImage = ref('');
const backendTouched = ref(false);

const baseDomain = ref('');
const serverVersion = ref('');
const ingressClass = ref('');
const storageClass = ref('');
const clusterIssuer = ref('');
const hasStorageClass = ref(true);
const installingStorage = ref(false);

// Chosen against the host cluster's own ranges when defaults are discovered.
const nestedPodCidr = ref(DEFAULT_NESTED_POD_CIDR);
const nestedServiceCidr = ref(DEFAULT_NESTED_SERVICE_CIDR);

const dataSizeGb = ref(DEFAULT_DATA_SIZE_GB);
const uiSizeGb = ref(DEFAULT_UI_SIZE_GB);
const cacheSizeGb = ref(DEFAULT_CACHE_SIZE_GB);

const clusterOptions = computed(() => clusters.value.map((c) => ({ label: c.name, value: c.id })));
const targetsLocal = computed(() => clusters.value.find((c) => c.id === clusterId.value)?.isLocal);
const hostname = computed(() => (name.value && baseDomain.value ? hostnameFor(name.value, baseDomain.value) : ''));

/**
 * No StorageClass means none of the three PVCs can ever bind, so the build pod
 * never schedules and the environment fails several minutes in with "pod has
 * unbound immediate PersistentVolumeClaims". Typing a class by hand is still
 * allowed -- the check is for a cluster that offers nothing at all.
 */
const storageUnavailable = computed(() => !hasStorageClass.value && !storageClass.value);

const canSubmit = computed(() => !!(
  clusterId.value && name.value && repo.value && branch.value && baseDomain.value &&
  ingressClass.value && !storageUnavailable.value
));

// Follow the branch until the user edits the image themselves.
watch(branch, (value) => {
  if (!backendTouched.value) {
    backendImage.value = backendImageForBranch(value, serverVersion.value);
  }
});

async function loadDefaults() {
  if (!clusterId.value) {
    return;
  }

  const defaults = await discoverDefaults(store, clusterId.value);

  baseDomain.value = defaults.baseDomain;
  serverVersion.value = defaults.serverVersion || '';
  ingressClass.value = defaults.ingressClass;
  storageClass.value = defaults.storageClass || '';
  clusterIssuer.value = defaults.clusterIssuer || '';
  hasStorageClass.value = defaults.hasStorageClass !== false;
  nestedPodCidr.value = defaults.nestedPodCidr || DEFAULT_NESTED_POD_CIDR;
  nestedServiceCidr.value = defaults.nestedServiceCidr || DEFAULT_NESTED_SERVICE_CIDR;

  // The version arrives asynchronously, so redo the image guess now that the
  // main-line comparison can actually be made.
  if (!backendTouched.value) {
    backendImage.value = backendImageForBranch(branch.value, serverVersion.value);
  }
}

watch(clusterId, loadDefaults);

function buildSpec(): RemudaSpec {
  return {
    name:          name.value,
    repo:          repo.value,
    branch:        branch.value,
    backendImage:  backendImage.value,
    hostname:      hostname.value,
    owner:         store.getters['auth/principalId']?.split('//')?.pop() || 'unknown',
    createdAt:     new Date().toISOString(),
    namespace:     REMUDA_NS,
    ingressClass:  ingressClass.value,
    storageClass:  storageClass.value || undefined,
    clusterIssuer: clusterIssuer.value || undefined,
    gitSecretName: gitSecretName.value || undefined,
    dataSizeGb:    Number(dataSizeGb.value),
    uiSizeGb:      Number(uiSizeGb.value),
    cacheSizeGb:   Number(cacheSizeGb.value),

    nestedPodCidr:     nestedPodCidr.value,
    nestedServiceCidr: nestedServiceCidr.value,
  };
}

function generatePassword(): string {
  const bytes = new Uint8Array(24);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function submit(cb: (ok: boolean) => void) {
  try {
    await createEnvironment(store, clusterId.value, buildSpec(), generatePassword());
    // Persist what was used so the next create on this cluster prefills. The
    // environment already exists by this point, so a failure here must not be
    // reported as a failed create -- prefill is a convenience, not part of the
    // environment.
    await savePrefillDefaults();
    cb(true);
    router.push({ name: `${ PRODUCT_NAME }-c-cluster-environments`, params: { cluster: BLANK_CLUSTER } });
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.createFailed');
    cb(false);
  }
}

/**
 * Offered rather than done automatically: this installs a Deployment and a
 * cluster-default StorageClass, which is a change to the whole cluster and not
 * something to do behind someone's back. Once it lands, discovery re-runs and
 * fills the storage class field in, which the user can still override.
 */
async function installStorage(cb: (ok: boolean) => void) {
  installingStorage.value = true;
  try {
    await installLocalPathStorage(store, clusterId.value);
    await loadDefaults();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.storageInstallFailed');
    cb(false);
  } finally {
    installingStorage.value = false;
  }
}

async function savePrefillDefaults() {
  try {
    await saveDefaults(store, clusterId.value, {
      baseDomain:    baseDomain.value,
      ingressClass:  ingressClass.value,
      storageClass:  storageClass.value || undefined,
      clusterIssuer: clusterIssuer.value || undefined,

      nestedPodCidr:     nestedPodCidr.value,
      nestedServiceCidr: nestedServiceCidr.value,
    });
  } catch {
    // Deliberately swallowed -- see the call site.
  }
}

onMounted(async() => {
  try {
    clusters.value = await readyClusters(store);
    // Prefer a downstream cluster; local is discouraged but not blocked.
    clusterId.value = (clusters.value.find((c) => !c.isLocal) || clusters.value[0])?.id || '';
    await loadDefaults();
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.loadFailed');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <Loading v-if="loading" />
  <div v-else>
    <h1>{{ i18n.t('remuda.create.title') }}</h1>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="targetsLocal"
      color="warning"
      :label="i18n.t('remuda.warning.localCluster')"
    />
    <Banner
      v-if="storageUnavailable"
      color="error"
    >
      <div class="remuda-banner">
        <span>{{ i18n.t('remuda.warning.noStorageClass') }}</span>
        <AsyncButton
          mode="apply"
          size="sm"
          :disabled="installingStorage"
          :action-label="i18n.t('remuda.create.installStorage')"
          :waiting-label="i18n.t('remuda.create.installingStorage')"
          @click="installStorage"
        />
      </div>
    </Banner>
    <Banner
      v-if="!clusterIssuer"
      color="warning"
      :label="i18n.t('remuda.warning.noIssuer')"
    />
    <Banner
      v-if="!baseDomain"
      color="warning"
      :label="i18n.t('remuda.warning.noBaseDomain')"
    />

    <div class="row mb-20">
      <div class="col span-6">
        <LabeledSelect
          v-model:value="clusterId"
          :label="i18n.t('remuda.create.clusterLabel')"
          :options="clusterOptions"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-model:value="name"
          :label="i18n.t('remuda.create.nameLabel')"
          :placeholder="i18n.t('remuda.create.namePlaceholder')"
          :tooltip="i18n.t('remuda.create.nameHint')"
        />
      </div>
    </div>

    <div class="row mb-20">
      <div class="col span-6">
        <LabeledInput
          v-model:value="repo"
          :label="i18n.t('remuda.create.repoLabel')"
          :placeholder="i18n.t('remuda.create.repoPlaceholder')"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-model:value="branch"
          :label="i18n.t('remuda.create.branchLabel')"
          :placeholder="i18n.t('remuda.create.branchPlaceholder')"
        />
      </div>
    </div>

    <div
      v-if="hostname"
      class="mb-20"
    >
      <label>{{ i18n.t('remuda.create.hostnameLabel') }}</label>
      <div><code>https://{{ hostname }}</code></div>
    </div>

    <AdvancedSection>
      <div class="row mb-20">
        <div class="col span-6">
          <LabeledInput
            v-model:value="backendImage"
            :label="i18n.t('remuda.create.backendLabel')"
            :tooltip="i18n.t('remuda.create.backendHint')"
            @update:value="backendTouched = true"
          />
        </div>
        <div class="col span-6">
          <LabeledInput
            v-model:value="gitSecretName"
            :label="i18n.t('remuda.create.gitSecretLabel')"
            :tooltip="i18n.t('remuda.create.gitSecretHint')"
          />
        </div>
      </div>

      <h3>{{ i18n.t('remuda.create.clusterConfig') }}</h3>
      <div class="row mb-20">
        <div class="col span-3">
          <LabeledInput
            v-model:value="baseDomain"
            :label="i18n.t('remuda.create.baseDomain')"
            :tooltip="i18n.t('remuda.create.baseDomainHint')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="ingressClass"
            :label="i18n.t('remuda.create.ingressClass')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="storageClass"
            :label="i18n.t('remuda.create.storageClass')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="clusterIssuer"
            :label="i18n.t('remuda.create.clusterIssuer')"
          />
        </div>
      </div>

      <h3>{{ i18n.t('remuda.create.sizes') }}</h3>
      <div class="row mb-20">
        <div class="col span-4">
          <LabeledInput
            v-model:value="dataSizeGb"
            type="number"
            :label="i18n.t('remuda.create.dataSize')"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="uiSizeGb"
            type="number"
            :label="i18n.t('remuda.create.uiSize')"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="cacheSizeGb"
            type="number"
            :label="i18n.t('remuda.create.cacheSize')"
          />
        </div>
      </div>
    </AdvancedSection>

    <div class="remuda-footer">
      <AsyncButton
        mode="create"
        :disabled="!canSubmit"
        :action-label="i18n.t('remuda.create.submit')"
        @click="submit"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
h3 {
  margin-bottom: 10px;
}

.remuda-banner {
  align-items: center;
  display: flex;
  gap: 16px;
  justify-content: space-between;
}

// Matches the other create forms: the action sits right, at its natural width,
// rather than stretching the full width of the page.
.remuda-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
