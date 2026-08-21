import { BLANK_CLUSTER, PRODUCT_NAME } from '../utils/constants';
import Environments from '../pages/Environments.vue';
import Create from '../pages/Create.vue';
import Detail from '../pages/Detail.vue';

const meta = {
  product: PRODUCT_NAME,
  cluster: BLANK_CLUSTER,
  pkg:     PRODUCT_NAME,
};

export default [
  {
    name:      `${ PRODUCT_NAME }-c-cluster-environments`,
    path:      `/${ PRODUCT_NAME }/c/:cluster/environments`,
    component: Environments,
    meta,
  },
  {
    name:      `${ PRODUCT_NAME }-c-cluster-create`,
    path:      `/${ PRODUCT_NAME }/c/:cluster/create`,
    component: Create,
    meta,
  },
  {
    // clusterId is the cluster the environment lives in, distinct from the
    // :cluster route param, which is the blank placeholder for a global product.
    name:      `${ PRODUCT_NAME }-c-cluster-detail`,
    path:      `/${ PRODUCT_NAME }/c/:cluster/detail/:clusterId/:name`,
    component: Detail,
    meta,
  },
];
