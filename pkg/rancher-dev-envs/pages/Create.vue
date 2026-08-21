<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import { useI18n } from '@shell/composables/useI18n';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import AdvancedSection from '@shell/components/AdvancedSection.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import { createEnvironment, readyClusters } from '../utils/api';
import { backendImageForBranch, discoverDefaults, hostnameFor, saveDefaults } from '../utils/discovery';
import {
  BLANK_CLUSTER, DEFAULT_CACHE_SIZE_GB, DEFAULT_DATA_SIZE_GB, DEFAULT_UI_SIZE_GB, DEV_ENV_NS, PRODUCT_NAME,
} from '../utils/constants';
import type { DevEnvSpec } from '../types';

const store = useStore();
const router = useRouter();
const i18n = useI18n(store);

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
const ingressClass = ref('');
const storageClass = ref('');
const clusterIssuer = ref('');

const dataSizeGb = ref(DEFAULT_DATA_SIZE_GB);
const uiSizeGb = ref(DEFAULT_UI_SIZE_GB);
const cacheSizeGb = ref(DEFAULT_CACHE_SIZE_GB);

const clusterOptions = computed(() => clusters.value.map((c) => ({ label: c.name, value: c.id })));
const targetsLocal = computed(() => clusters.value.find((c) => c.id === clusterId.value)?.isLocal);
const hostname = computed(() => (name.value && baseDomain.value ? hostnameFor(name.value, baseDomain.value) : ''));

const canSubmit = computed(() => !!(
  clusterId.value && name.value && repo.value && branch.value && baseDomain.value && ingressClass.value
));

// Follow the branch until the user edits the image themselves.
watch(branch, (value) => {
  if (!backendTouched.value) {
    backendImage.value = backendImageForBranch(value);
  }
});

async function loadDefaults() {
  if (!clusterId.value) {
    return;
  }

  const defaults = await discoverDefaults(store, clusterId.value);

  baseDomain.value = defaults.baseDomain;
  ingressClass.value = defaults.ingressClass;
  storageClass.value = defaults.storageClass || '';
  clusterIssuer.value = defaults.clusterIssuer || '';
}

watch(clusterId, loadDefaults);

function buildSpec(): DevEnvSpec {
  return {
    name:          name.value,
    repo:          repo.value,
    branch:        branch.value,
    backendImage:  backendImage.value,
    hostname:      hostname.value,
    owner:         store.getters['auth/principalId']?.split('//')?.pop() || 'unknown',
    createdAt:     new Date().toISOString(),
    namespace:     DEV_ENV_NS,
    ingressClass:  ingressClass.value,
    storageClass:  storageClass.value || undefined,
    clusterIssuer: clusterIssuer.value || undefined,
    gitSecretName: gitSecretName.value || undefined,
    dataSizeGb:    Number(dataSizeGb.value),
    uiSizeGb:      Number(uiSizeGb.value),
    cacheSizeGb:   Number(cacheSizeGb.value),
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
    // Persist what was used so the next create on this cluster prefills.
    await saveDefaults(store, clusterId.value, {
      baseDomain:    baseDomain.value,
      ingressClass:  ingressClass.value,
      storageClass:  storageClass.value || undefined,
      clusterIssuer: clusterIssuer.value || undefined,
    });
    cb(true);
    router.push({ name: `${ PRODUCT_NAME }-c-cluster-environments`, params: { cluster: BLANK_CLUSTER } });
  } catch (e: any) {
    error.value = e?.message || i18n.t('devEnvs.error.createFailed');
    cb(false);
  }
}

onMounted(async() => {
  try {
    clusters.value = await readyClusters(store);
    // Prefer a downstream cluster; local is discouraged but not blocked.
    clusterId.value = (clusters.value.find((c) => !c.isLocal) || clusters.value[0])?.id || '';
    await loadDefaults();
  } catch (e: any) {
    error.value = e?.message || i18n.t('devEnvs.error.loadFailed');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <Loading v-if="loading" />
  <div v-else>
    <h1>{{ i18n.t('devEnvs.create.title') }}</h1>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="targetsLocal"
      color="warning"
      :label="i18n.t('devEnvs.warning.localCluster')"
    />
    <Banner
      v-if="!clusterIssuer"
      color="warning"
      :label="i18n.t('devEnvs.warning.noIssuer')"
    />
    <Banner
      v-if="!baseDomain"
      color="warning"
      :label="i18n.t('devEnvs.warning.noBaseDomain')"
    />

    <div class="row mb-20">
      <div class="col span-6">
        <LabeledSelect
          v-model:value="clusterId"
          :label="i18n.t('devEnvs.create.clusterLabel')"
          :options="clusterOptions"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-model:value="name"
          :label="i18n.t('devEnvs.create.nameLabel')"
          :placeholder="i18n.t('devEnvs.create.namePlaceholder')"
          :tooltip="i18n.t('devEnvs.create.nameHint')"
        />
      </div>
    </div>

    <div class="row mb-20">
      <div class="col span-6">
        <LabeledInput
          v-model:value="repo"
          :label="i18n.t('devEnvs.create.repoLabel')"
          :placeholder="i18n.t('devEnvs.create.repoPlaceholder')"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-model:value="branch"
          :label="i18n.t('devEnvs.create.branchLabel')"
          :placeholder="i18n.t('devEnvs.create.branchPlaceholder')"
        />
      </div>
    </div>

    <div
      v-if="hostname"
      class="mb-20"
    >
      <label>{{ i18n.t('devEnvs.create.hostnameLabel') }}</label>
      <div><code>https://{{ hostname }}</code></div>
    </div>

    <AdvancedSection>
      <div class="row mb-20">
        <div class="col span-6">
          <LabeledInput
            v-model:value="backendImage"
            :label="i18n.t('devEnvs.create.backendLabel')"
            :tooltip="i18n.t('devEnvs.create.backendHint')"
            @update:value="backendTouched = true"
          />
        </div>
        <div class="col span-6">
          <LabeledInput
            v-model:value="gitSecretName"
            :label="i18n.t('devEnvs.create.gitSecretLabel')"
            :tooltip="i18n.t('devEnvs.create.gitSecretHint')"
          />
        </div>
      </div>

      <h3>{{ i18n.t('devEnvs.create.clusterConfig') }}</h3>
      <div class="row mb-20">
        <div class="col span-3">
          <LabeledInput
            v-model:value="baseDomain"
            :label="i18n.t('devEnvs.create.baseDomain')"
            :tooltip="i18n.t('devEnvs.create.baseDomainHint')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="ingressClass"
            :label="i18n.t('devEnvs.create.ingressClass')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="storageClass"
            :label="i18n.t('devEnvs.create.storageClass')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="clusterIssuer"
            :label="i18n.t('devEnvs.create.clusterIssuer')"
          />
        </div>
      </div>

      <h3>{{ i18n.t('devEnvs.create.sizes') }}</h3>
      <div class="row mb-20">
        <div class="col span-4">
          <LabeledInput
            v-model:value="dataSizeGb"
            type="number"
            :label="i18n.t('devEnvs.create.dataSize')"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="uiSizeGb"
            type="number"
            :label="i18n.t('devEnvs.create.uiSize')"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="cacheSizeGb"
            type="number"
            :label="i18n.t('devEnvs.create.cacheSize')"
          />
        </div>
      </div>
    </AdvancedSection>

    <AsyncButton
      mode="create"
      :disabled="!canSubmit"
      :label="i18n.t('devEnvs.create.submit')"
      @click="submit"
    />
  </div>
</template>

<style lang="scss" scoped>
h3 {
  margin-bottom: 10px;
}
</style>
