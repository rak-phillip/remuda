<script setup lang="ts">
/**
 * Page-level empty state.
 *
 * Local on purpose: `pkg/rancher-components` exports no empty-state component,
 * and `shell/` already carries several one-offs that share this shape and agree
 * on nothing. This follows the shape proposed for a future `RcEmptyState` --
 * badged icon, heading, description, actions slot -- so that if one lands, this
 * collapses into it rather than having to be redesigned.
 *
 * The heading is an h2: an empty state sits under the page's h1, and dropping an
 * h1 into the middle of the outline would be wrong.
 */
import RcIcon from '@components/RcIcon/RcIcon.vue';
import type { RcIconType } from '@components/RcIcon/types';

defineProps<{
  icon?: RcIconType;
  title: string;
  description?: string;
}>();
</script>

<template>
  <div class="remuda-empty">
    <div
      v-if="icon"
      class="remuda-empty__badge"
    >
      <RcIcon :name="icon" />
    </div>

    <h2 class="remuda-empty__title">
      {{ title }}
    </h2>

    <p
      v-if="description"
      class="remuda-empty__description"
    >
      {{ description }}
    </p>

    <div
      v-if="$slots.actions"
      class="remuda-empty__actions"
    >
      <slot name="actions" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.remuda-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  padding: 64px 40px;
  border: 1px dashed var(--border);
  border-radius: var(--border-radius-lg, 8px);

  &__badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--default-hover, var(--body-bg));
    font-size: 24px;
    color: var(--primary);
  }

  &__title {
    margin: 0;
    font-size: 18px;
    line-height: 27px;
    font-weight: 600;
  }

  &__description {
    margin: 0;
    // Long lines are hard to read when centred; the design caps this.
    max-width: 520px;
    color: var(--muted);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 8px;
  }
}
</style>
