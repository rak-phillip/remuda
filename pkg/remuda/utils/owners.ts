/**
 * Turning a stored owner ID back into a name a person recognises.
 *
 * `Create.vue` records the *tail* of the creator's principal ID -- the part
 * after `//` -- because that is what a Kubernetes label value can hold. Label
 * values cannot contain spaces, so `LABEL_OWNER` has to stay an ID and the
 * display name cannot live there. The result is a column reading `u-98zl6` for
 * a local user and `835961` for an external one: unfriendly in two different
 * ways at once, and the second one is not even obviously a person.
 *
 * Resolving at display time rather than storing a name at create time is the
 * more useful half of the fix, because it also repairs every environment that
 * already exists. It can fail -- a standard user cannot list users, a principal
 * may no longer resolve, an ID may predate the account -- so every failure path
 * lands on the ID that is already being shown today. Nothing gets worse.
 */

const USER_TYPE = 'management.cattle.io.user';

/** The tail of a principal ID, which is what an owner is stored as. */
const principalTail = (principalId: string): string => principalId.split('//').pop() || '';

/**
 * Names for as many of these owner IDs as can be resolved.
 *
 * Returns a plain map rather than throwing, and simply omits what it could not
 * resolve -- callers fall back to the ID, so a partial answer is still useful
 * and an empty one is exactly today's behaviour.
 *
 * One `findAll` rather than a lookup per owner: the store caches the collection,
 * which matters because the environment list re-reads every fifteen seconds.
 */
export async function ownerNames(store: any, ids: string[]): Promise<Record<string, string>> {
  const wanted = new Set(ids.filter(Boolean));

  if (!wanted.size) {
    return {};
  }

  let users: any[] = [];

  try {
    users = await store.dispatch('management/findAll', { type: USER_TYPE }) || [];
  } catch {
    // Overwhelmingly the ordinary case for a non-admin, who cannot list users
    // and should still see a list of environments.
    return {};
  }

  const out: Record<string, string> = {};

  for (const user of users) {
    // `nameDisplay` is the shell User model's own `displayName || username ||
    // id` chain. Recomputing it here would be a second opinion about something
    // Rancher already answers, and would drift from what the rest of the UI
    // calls the same person.
    const name = user?.nameDisplay || user?.displayName || user?.username;

    if (!name) {
      continue;
    }

    // A user is reachable by either shape the owner field can hold: the
    // resource name for a local account, or the tail of any principal it is
    // linked to for an external one.
    const keys = [user?.id, user?.metadata?.name, ...(user?.principalIds || []).map(principalTail)];

    for (const key of keys) {
      if (key && wanted.has(key) && name !== key) {
        out[key] = name;
      }
    }
  }

  return out;
}

/** What to render for an owner: the resolved name, else the ID as stored. */
export const ownerLabel = (id: string, names: Record<string, string>): string => names[id] || id || '';
