import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import extensionRouting from './routing/extension-routing';
import { EXTENSION_VERSION, upgradeControllerIfBehind } from './utils/controller';

export default function(plugin: IPlugin): void {
  importTypes(plugin);

  plugin.metadata = require('./package.json');

  plugin.addProduct(require('./product'));
  plugin.addRoutes(extensionRouting);

  plugin.addNavHooks({
    // Every dashboard load, not only an explicit login -- which is what makes an
    // extension upgrade carry the controller with it. See upgradeControllerIfBehind.
    //
    // Not awaited: the shell runs each extension's hook in turn before it calls
    // extensions ready, and a Helm operation is minutes of nobody's dashboard.
    onLogin: (store: any) => {
      upgradeControllerIfBehind(store).then((outcome) => {
        if (outcome === 'upgraded') {
          store.dispatch('growl/success', {
            title:   store.getters['i18n/t']('remuda.controllerUpgrade.title'),
            message: store.getters['i18n/t']('remuda.controllerUpgrade.started', { version: EXTENSION_VERSION }),
          });
        }
      }).catch((e: any) => {
        store.dispatch('growl/error', {
          title:   store.getters['i18n/t']('remuda.controllerUpgrade.title'),
          message: store.getters['i18n/t']('remuda.controllerUpgrade.failed', { version: EXTENSION_VERSION, error: e?.message || e }),
        });
      });

      return Promise.resolve();
    },
  });
}
