import { ownerLabel, ownerNames } from '../owners';

const storeOf = (users: any) => ({ dispatch: () => (users instanceof Error ? Promise.reject(users) : Promise.resolve(users)) });

const local = {
  id:           'u-98zl6',
  username:     'mmesgin',
  displayName:  'Mo Mesgin',
  nameDisplay:  'Mo Mesgin',
  principalIds: ['local://u-98zl6'],
};

const external = {
  id:           'u-abcde',
  nameDisplay:  'Ovi Nita',
  principalIds: ['local://u-abcde', 'openldap_user://835961'],
};

describe('ownerNames', () => {
  it('resolves a local owner by its resource name', async() => {
    expect(await ownerNames(storeOf([local]), ['u-98zl6'])).toEqual({ 'u-98zl6': 'Mo Mesgin' });
  });

  it('resolves an external owner by a principal tail', async() => {
    // Create.vue stores the part after `//`, and for an external provider that
    // is an account id that matches no user resource name at all.
    expect(await ownerNames(storeOf([external]), ['835961'])).toEqual({ 835961: 'Ovi Nita' });
  });

  it('resolves both shapes in one pass', async() => {
    const names = await ownerNames(storeOf([local, external]), ['u-98zl6', '835961']);

    expect(names).toEqual({ 'u-98zl6': 'Mo Mesgin', 835961: 'Ovi Nita' });
  });

  it('omits owners it cannot resolve rather than inventing them', async() => {
    // An account that has since been deleted still owns environments.
    expect(await ownerNames(storeOf([local]), ['u-98zl6', 'u-gone'])).toEqual({ 'u-98zl6': 'Mo Mesgin' });
  });

  it('returns nothing when the user list is refused', async() => {
    // The ordinary case for a standard user, who must still get a list of
    // environments -- with owner IDs, exactly as before.
    expect(await ownerNames(storeOf(new Error('403 forbidden')), ['u-98zl6'])).toEqual({});
  });

  it('does not map an id onto itself', async() => {
    // A user with no displayName or username falls back to its own id, which
    // would be a resolution that changes nothing and hides that it failed.
    const bare = {
      id: 'u-98zl6', nameDisplay: 'u-98zl6', principalIds: []
    };

    expect(await ownerNames(storeOf([bare]), ['u-98zl6'])).toEqual({});
  });

  it('asks for nothing when there is nothing to resolve', async() => {
    const store = { dispatch: jest.fn() };

    expect(await ownerNames(store, [])).toEqual({});
    expect(await ownerNames(store, ['', ''])).toEqual({});
    expect(store.dispatch).not.toHaveBeenCalled();
  });
});

describe('ownerLabel', () => {
  it('prefers the resolved name and falls back to the id', () => {
    expect(ownerLabel('u-98zl6', { 'u-98zl6': 'Mo Mesgin' })).toBe('Mo Mesgin');
    expect(ownerLabel('u-98zl6', {})).toBe('u-98zl6');
  });

  it('renders nothing for an environment with no owner recorded', () => {
    // Which is every environment created with kubectl: spec.owner is unset,
    // because a scripted create has no principal to attribute it to.
    expect(ownerLabel('', {})).toBe('');
  });
});
