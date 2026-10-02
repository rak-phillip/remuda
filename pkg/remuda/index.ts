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
        // Every outcome, so a controller that did not follow the extension can be
        // explained from the console rather than reconstructed from the API.
        console.info(`Remuda ${ EXTENSION_VERSION }: controller check: ${ outcome }`); // eslint-disable-line no-console

        if (outcome === 'upgraded') {
          store.dispatch('growl/success', {
            title:   store.getters['i18n/t']('remuda.controllerUpgrade.title'),
            message: store.getters['i18n/t']('remuda.controllerUpgrade.started', { version: EXTENSION_VERSION }),
          });
        }

        // Only reached by someone allowed to upgrade it, so it is theirs to act on.
        // `forbidden` stays quiet: the user who sees it can do nothing about it,
        // and the next admin to load the dashboard upgrades it.
        if (outcome === 'no-chart') {
          store.dispatch('growl/warning', {
            title:   store.getters['i18n/t']('remuda.controllerUpgrade.title'),
            message: store.getters['i18n/t']('remuda.controllerUpgrade.noChart', { version: EXTENSION_VERSION }),
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
