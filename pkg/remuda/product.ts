import { IPlugin } from '@shell/core/types';
import { BLANK_CLUSTER, PRODUCT_NAME } from './utils/constants';
import navIcon from './nav-icon';

export function init($plugin: IPlugin, store: any) {
  const { product, virtualType, basicType } = $plugin.DSL(store, PRODUCT_NAME);
  const route = (page: string) => ({
    name:   `${ PRODUCT_NAME }-c-cluster-${ page }`,
    params: {
      product: PRODUCT_NAME, cluster: BLANK_CLUSTER, pkg: PRODUCT_NAME,
    },
  });

  product({
    // `icon` is the font-glyph fallback; `svg` wins where the nav supports it.
    // The cast is upstream's: Product types `svg` as a Function, but the shell
    // passes it straight to an <img :src>, so what it actually wants is a string.
    icon:                'globe',
    svg:                 navIcon as unknown as () => void,
    // Global: environments are listed across every downstream cluster, so this
    // is not scoped to whichever cluster happens to be selected.
    inStore:             'management',
    showClusterSwitcher: false,
    weight:              100,
    to:                  route('environments'),
  });

  basicType(['environments']);

  virtualType({
    label:      store.getters['i18n/t']('remuda.nav.environments'),
    name:       'environments',
    namespaced: false,
    weight:     20,
    route:      route('environments'),
  });
}
