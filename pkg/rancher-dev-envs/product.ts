import { IPlugin } from '@shell/core/types';
import { BLANK_CLUSTER, PRODUCT_NAME } from './utils/constants';

export function init($plugin: IPlugin, store: any) {
  const { product, virtualType, basicType } = $plugin.DSL(store, PRODUCT_NAME);
  const route = (page: string) => ({
    name:   `${ PRODUCT_NAME }-c-cluster-${ page }`,
    params: {
      product: PRODUCT_NAME, cluster: BLANK_CLUSTER, pkg: PRODUCT_NAME,
    },
  });

  product({
    icon:                'globe',
    // Global: environments are listed across every downstream cluster, so this
    // is not scoped to whichever cluster happens to be selected.
    inStore:             'management',
    showClusterSwitcher: false,
    weight:              100,
    to:                  route('environments'),
  });

  basicType(['environments', 'create']);

  virtualType({
    label:      store.getters['i18n/t']('devEnvs.nav.environments'),
    name:       'environments',
    namespaced: false,
    weight:     20,
    route:      route('environments'),
  });

  virtualType({
    label:      store.getters['i18n/t']('devEnvs.nav.create'),
    name:       'create',
    namespaced: false,
    weight:     10,
    route:      route('create'),
  });
}
