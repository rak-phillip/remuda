/**
 * The generated scaffold still ships a legacy `.eslintrc.js`, which ESLint 10 no
 * longer reads. `@rancher/shell` exports the flat successor, so consume that.
 */
import shellConfig from '@rancher/shell/eslint.config.base.mjs';
import globals from 'globals';

// Vue `<script setup>` compiler macros.
const compilerMacros = {
  defineProps:   'readonly',
  defineEmits:   'readonly',
  defineExpose:  'readonly',
  withDefaults:  'readonly',
  defineModel:   'readonly',
  defineOptions: 'readonly',
  defineSlots:   'readonly',
};

export default [
  { ignores: ['**/node_modules/', '**/dist/', '**/dist-pkg/', '**/.shell/'] },

  ...shellConfig,

  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
        ...compilerMacros,
      },
    },
  },

  // The published shell base omits these three, but rancher/dashboard's own
  // config turns all of them off. Match the dashboard so extension code is held
  // to the same bar as the code it is written against.
  {
    rules: {
      // The Vuex store and Steve responses are untyped.
      '@typescript-eslint/no-explicit-any': 'off',
      // AsyncButton's callback takes a boolean success flag, not a Node error.
      'n/no-callback-literal':              'off',
      'vue/multi-word-component-names':     'off',
    },
  },
];
