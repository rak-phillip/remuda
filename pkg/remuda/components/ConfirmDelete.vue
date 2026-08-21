<script setup lang="ts">
import { ref } from 'vue';
import { useStore } from 'vuex';
import AppModal from '@shell/components/AppModal.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import { useText } from '../utils/i18n';

/**
 * Confirmation for deleting an environment.
 *
 * Deleting one takes its PVCs and the whole nested cluster with it, and none of
 * that is recoverable, so it is not something to do on a single stray click.
 * The name has to be visible in the prompt because both the list and the detail
 * page can trigger this, and from the list it is easy to aim at the wrong row.
 */
const props = defineProps<{ name: string }>();
const emit = defineEmits<{(e: 'confirm', cb: (ok: boolean) => void): void }>();

const store = useStore();
const i18n = useText(store);
const open = ref(false);

const show = () => {
  open.value = true;
};
const close = () => {
  open.value = false;
};

function confirm(cb: (ok: boolean) => void) {
  emit('confirm', (ok: boolean) => {
    if (ok) {
      close();
    }
    cb(ok);
  });
}

defineExpose({ show });
</script>

<template>
  <AppModal
    v-if="open"
    :width="480"
    name="remuda-confirm-delete"
    aria-labelledby="remuda-confirm-delete-title"
    trigger-focus-trap
    @close="close"
  >
    <div class="remuda-confirm">
      <h4 id="remuda-confirm-delete-title">
        {{ i18n.t('remuda.confirmDelete.title', { name: props.name }) }}
      </h4>
      <p>{{ i18n.t('remuda.confirmDelete.body') }}</p>

      <div class="remuda-confirm-actions">
        <button
          type="button"
          class="btn role-secondary"
          @click="close"
        >
          {{ i18n.t('remuda.confirmDelete.cancel') }}
        </button>
        <AsyncButton
          mode="delete"
          @click="confirm"
        />
      </div>
    </div>
  </AppModal>
</template>

<style lang="scss" scoped>
.remuda-confirm {
  padding: 20px;

  p {
    margin: 10px 0 0;
  }
}

.remuda-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
