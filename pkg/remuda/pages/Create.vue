<script setup lang="ts">
import {
  computed, onMounted, onUnmounted, ref, watch
} from 'vue';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import Loading from '@shell/components/Loading.vue';
import Banner from '@components/Banner/Banner.vue';
import AsyncButton from '@shell/components/AsyncButton.vue';
import AdvancedSection from '@shell/components/AdvancedSection.vue';
import LabeledInput from '@components/Form/LabeledInput/LabeledInput.vue';
import LabeledSelect from '@shell/components/form/LabeledSelect.vue';
import { useFormValidation } from '@shell/composables/useFormValidation';
import type { RuleSet } from '@shell/composables/useFormValidation';
import { useText } from '../utils/i18n';
import { createEnvironment, hostnameTaken, installLocalPathStorage, readyClusters } from '../utils/api';
import {
  backendImageForBranch, discoverDefaults, exposureFor, hostIngressDefaults, hostnameFor, ingressEntry,
  isIpLiteral, isWildcardFallbackDomain, probeBaseDomain, saveDefaults, wildcardDomainFor,
} from '../utils/discovery';
import { isCloneableRepo } from '../utils/validate';
import { createBranchField } from '../utils/branch-field';
import { checkRepo, listBranches, parseGitHubRepo, searchBranches } from '../utils/github';
import type { RepoCheck } from '../utils/github';
import {
  BLANK_CLUSTER, DEFAULT_CACHE_SIZE_GB, DEFAULT_DATA_SIZE_GB, DEFAULT_NESTED_POD_CIDR,
  DEFAULT_NESTED_SERVICE_CIDR, DEFAULT_UI_SIZE_GB, GITHUB_DEBOUNCE_MS, HOST_CLUSTER_ID, REMUDA_NS,
  PRODUCT_NAME, WILDCARD_DNS_SUFFIX,
} from '../utils/constants';
import type { AcmeIssuer, IngressEntry, IssuerKind, RemudaSpec } from '../types';

const store = useStore();
const router = useRouter();
const i18n = useText(store);

/**
 * Which fields the form cannot be submitted without.
 *
 * These four are the whole of it deliberately: everything else on the form is
 * either discovered from the cluster and prefilled, or genuinely optional. The
 * `translationKey` is what the shell's rule generator interpolates into the
 * message, so the error names the field the way its label does.
 */
const ruleSets: RuleSet[] = [
  {
    path: 'clusterId', rules: ['required'], translationKey: 'remuda.create.clusterLabel'
  },
  {
    path: 'name', rules: ['required'], translationKey: 'remuda.create.nameLabel'
  },
  {
    path: 'repo', rules: ['required', 'cloneable'], translationKey: 'remuda.create.repoLabel'
  },
  {
    path: 'branch', rules: ['required'], translationKey: 'remuda.create.branchLabel'
  },
];

/**
 * Shape-only reachability check, folded in as a field rule so the repository
 * field has one error surface rather than a rule message and a separate banner
 * saying different things about the same input. Named `cloneable` because the
 * shell resolves extra rules by function name.
 */
const cloneable = (value: any): string | undefined => (
  !value || isCloneableRepo(value) ? undefined : i18n.t('remuda.warning.repoInvalid')
);

const { getRules, isFormValid } = useFormValidation(i18n.t as any, ruleSets, { cloneable });

const loading = ref(true);
const error = ref('');
const clusters = ref<{ id: string; name: string; isLocal: boolean }[]>([]);

const clusterId = ref('');
const name = ref('');
const repo = ref('');
const branch = ref('');
const gitSecretName = ref('');
const backendImage = ref('');
const backendTouched = ref(false);

/**
 * What GitHub says about the repository, and the branches it offers.
 *
 * Advisory throughout. `isCloneableRepo` stays the only hard gate on the field,
 * because this can be wrong for reasons that have nothing to do with the input:
 * a private fork looks identical to a missing repo without credentials, a repo
 * on any other host cannot be checked at all, and the unauthenticated API runs
 * out after 60 requests an hour per IP.
 */
const repoCheck = ref<RepoCheck | 'idle' | 'checking' | 'skipped'>('idle');
const branches = ref<string[]>([]);
/**
 * Prefix matches for what is currently typed. Only ever populated for a
 * repository too large to hold in full -- otherwise `branches` already has
 * everything and vue-select filters it locally by substring.
 */
const branchMatches = ref<string[]>([]);
/** True when the repository has more branches than the fetch cap allowed. */
const branchesTruncated = ref(false);
let repoTimer: any = null;
let branchTimer: any = null;

const baseDomain = ref('');
// Whether the probe reached a verdict at all, and what it was. Both false while
// it is inconclusive, which is the state that must not produce a banner.
const wildcardChecked = ref(false);
const wildcardMissing = ref(false);
const derivedBaseDomain = ref('');
// The wildcard is missing *and* no address could be derived to fall back to, so
// the field has nothing to offer and has to ask.
const wildcardNoAddress = ref(false);
const serverVersion = ref('');
const ingressClass = ref('');
const storageClass = ref('');
const clusterIssuer = ref('');
// How the issuer above is referenced, and the ACME spec to mirror when nothing
// cluster-scoped exists. See utils/discovery.ts issuerFor().
const issuerKind = ref<IssuerKind | undefined>(undefined);
const acme = ref<AcmeIssuer | undefined>(undefined);
const hasStorageClass = ref(true);
const installingStorage = ref(false);

// Where the *target* cluster's ingress controller answers from outside it.
// Resolved once, at create. Either the address the hop dials (see HopSpec) or,
// when there is no hop, the address the environment's own hostname is built
// from -- one lookup, because both modes need the same answer.
const targetEntry = ref<IngressEntry | undefined>(undefined);
const hostIngressClass = ref('');
const hostBaseDomain = ref('');
// True while the lookups behind the mode are still in flight. Until they land
// the host looks like it has no ingress controller, which is a real condition
// and would otherwise be announced -- and acted on -- for every cluster the
// user clicks through on their way to the one they want.
const resolvingExposure = ref(false);
const hostClusterIssuer = ref('');
const hostIssuerKind = ref<IssuerKind | undefined>(undefined);
const hostAcme = ref<AcmeIssuer | undefined>(undefined);

// Chosen against the host cluster's own ranges when defaults are discovered.
const nestedPodCidr = ref(DEFAULT_NESTED_POD_CIDR);
const nestedServiceCidr = ref(DEFAULT_NESTED_SERVICE_CIDR);

const dataSizeGb = ref(DEFAULT_DATA_SIZE_GB);
const uiSizeGb = ref(DEFAULT_UI_SIZE_GB);
const cacheSizeGb = ref(DEFAULT_CACHE_SIZE_GB);

const clusterOptions = computed(() => clusters.value.map((c) => ({ label: c.name, value: c.id })));
const targetsLocal = computed(() => clusters.value.find((c) => c.id === clusterId.value)?.isLocal);
const hostname = computed(() => (name.value && baseDomain.value ? hostnameFor(name.value, baseDomain.value) : ''));

/**
 * No StorageClass means none of the three PVCs can ever bind, so the build pod
 * never schedules and the environment fails several minutes in with "pod has
 * unbound immediate PersistentVolumeClaims". Typing a class by hand is still
 * allowed -- the check is for a cluster that offers nothing at all.
 */
const storageUnavailable = computed(() => !hasStorageClass.value && !storageClass.value);

/**
 * How this environment will be reached, and why, when the answer is `direct`.
 *
 * Resolved from the *host* cluster's own ingress class and domain, because what
 * is being asked is whether the host can front an environment at all -- see
 * exposureFor().
 */
const exposure = computed(() => exposureFor({
  targetsLocal:     !!targetsLocal.value,
  hostIngressClass: hostIngressClass.value,
  hostBaseDomain:   hostBaseDomain.value,
}));

const usesDirect = computed(() => exposure.value.mode === 'direct');
const usesHop = computed(() => exposure.value.mode === 'hop');

/** Named in the banner that explains the fallback, so the two cannot drift. */
const wildcardSuffix = WILDCARD_DNS_SUFFIX;

/**
 * TLS terminates wherever the hostname actually resolves, so the issuer that
 * matters -- and the one to warn about -- moves with it. Only a hopped
 * environment terminates anywhere but its own cluster: `local` was always on the
 * target, and `direct` is reached on the target's own ingress, which is what
 * lets a downstream cluster with cert-manager issue for it.
 */
const terminatesOnTarget = computed(() => !usesHop.value);
const effectiveIssuer = computed(() => (terminatesOnTarget.value ? clusterIssuer.value : hostClusterIssuer.value));
const effectiveIssuerKind = computed(() => (terminatesOnTarget.value ? issuerKind.value : hostIssuerKind.value));
const effectiveAcme = computed(() => (terminatesOnTarget.value ? acme.value : hostAcme.value));

/**
 * Whether TLS will come from an Issuer this extension creates rather than one
 * the cluster already had.
 *
 * Worth saying out loud: it registers an ACME account against the email on the
 * cluster's existing issuer, which is a side effect nobody asked for explicitly.
 */
const mirrorsIssuer = computed(() => effectiveIssuerKind.value === 'Issuer' && !!effectiveAcme.value);

/**
 * A downstream target whose entry point could not be found cannot be reached in
 * either mode: the hop has nothing to dial, and direct has no address to name
 * the environment after.
 */
const entryUnavailable = computed(() => !resolvingExposure.value && !targetsLocal.value && !!clusterId.value && !targetEntry.value);

/**
 * Every mode serves the environment from an Ingress on the target cluster, so a
 * cluster with no ingress class at all cannot host one. Split in two because the
 * advice differs sharply: a downstream cluster can be given a controller, and a
 * Rancher running in docker cannot -- its k3s starts with traefik and servicelb
 * disabled, and the container publishes only the Rancher server's own ports.
 */
const ingressClassMissing = computed(() => !resolvingExposure.value && !!clusterId.value && !ingressClass.value);

/**
 * A hostname under a bare IP resolves nowhere and no record can change that.
 * Normally handled by falling back to a wildcard domain, so this only fires when
 * the fallback could not apply -- a `local` target, or a base domain typed by
 * hand.
 */
const baseDomainUnresolvable = computed(() => isIpLiteral(baseDomain.value));

/** One line under the repository field. Empty when there is nothing to say. */
const repoStatus = computed(() => {
  switch (repoCheck.value) {
  case 'checking':
    return i18n.t('remuda.create.repoChecking');
  case 'ok':
    return i18n.t('remuda.create.repoFound');
  case 'missing':
    return i18n.t('remuda.create.repoMissing');
  case 'skipped':
    return i18n.t('remuda.create.repoNotChecked');
  default:
    return '';
  }
});

/**
 * How many branches are on offer, and whether that is all of them.
 *
 * Sits under the Branch field rather than the Repository one, because it
 * describes the contents of that list and not the outcome of the repository
 * lookup. The two notes divide cleanly: Repository answers "did we find it",
 * Branch answers "what can you pick from".
 */
const branchStatus = computed(() => {
  if (repoCheck.value !== 'ok' || !branches.value.length) {
    return '';
  }

  return branchesTruncated.value ? i18n.t('remuda.create.branchesPartial', { count: branches.value.length }) : i18n.t('remuda.create.branchesAvailable', { count: branches.value.length });
});

/**
 * Surfaced because it means traffic is in plain sight of the internet: the hop
 * leaves the VPC to reach it, and a direct environment is answered for by that
 * public address itself.
 */
const publicEntry = computed(() => targetEntry.value?.addressType === 'ExternalIP');

/** Where a direct environment will answer, for the banner that explains why. */
const entryAddress = computed(() => targetEntry.value?.addresses?.join(', ') || '');

/**
 * Whether the environment's address is *inside* its hostname, which is what
 * makes replacing the node a recreate rather than a repoint. Only true of the
 * wildcard default -- a domain of the team's own can be repointed in DNS like
 * any other, so saying otherwise would be wrong.
 */
const pinnedToAddress = computed(() => usesDirect.value && baseDomain.value.endsWith(WILDCARD_DNS_SUFFIX));

/**
 * Two separate things gate the button. `isFormValid` covers the fields the user
 * types, and is vee-validate's business. The rest are conditions of the target
 * cluster -- no storage class, no reachable ingress -- which no field can be
 * corrected to satisfy, so they stay here and are explained by their banners.
 *
 * An unsupported host ingress class is deliberately *not* one of them any more.
 * It used to block, which was the right answer when the hop was the only way to
 * reach a downstream environment; now it is simply the reason the create falls
 * back to reaching it directly.
 */
const canSubmit = computed(() => isFormValid.value && !resolvingExposure.value && !!(
  baseDomain.value && ingressClass.value &&
  !storageUnavailable.value && !entryUnavailable.value
));

// Follow the branch until the user edits the image themselves.
watch(branch, (value) => {
  if (!backendTouched.value) {
    backendImage.value = backendImageForBranch(value, serverVersion.value);
  }
});

async function loadDefaults() {
  if (!clusterId.value) {
    return;
  }

  resolvingExposure.value = true;

  try {
    await readDefaults();
  } finally {
    resolvingExposure.value = false;
  }
}

async function readDefaults() {
  const defaults = await discoverDefaults(store, clusterId.value);

  baseDomain.value = defaults.baseDomain;
  serverVersion.value = defaults.serverVersion || '';
  ingressClass.value = defaults.ingressClass;
  storageClass.value = defaults.storageClass || '';
  clusterIssuer.value = defaults.clusterIssuer || '';
  issuerKind.value = defaults.issuerKind;
  acme.value = defaults.acme;
  hasStorageClass.value = defaults.hasStorageClass !== false;
  nestedPodCidr.value = defaults.nestedPodCidr || DEFAULT_NESTED_POD_CIDR;
  nestedServiceCidr.value = defaults.nestedServiceCidr || DEFAULT_NESTED_SERVICE_CIDR;

  // The version arrives asynchronously, so redo the image guess now that the
  // main-line comparison can actually be made.
  if (!backendTouched.value) {
    backendImage.value = backendImageForBranch(branch.value, serverVersion.value);
  }

  await loadTargetExposure(defaults.ingressClass);
  await applyWildcardFallback(defaults.derivedBaseDomain);
}

/**
 * Check that the base domain can actually carry a subdomain, and fall back if
 * it cannot.
 *
 * The default comes from server-url, on the assumption that a wildcard record
 * was created under the host Rancher's own domain. When that holds -- the
 * shared team instances -- everything works with no DNS of ours involved, and
 * this changes nothing. When it does not, the Rancher's own name resolves while
 * every name beneath it is NXDOMAIN, so the form looks correct right up until
 * the environment is unreachable, its certificate never issues, and the ACME
 * self-check is the only thing that says why. Probing turns that into a
 * decision made before the build runs.
 *
 * Only ever applied to a domain this extension guessed. A domain the team typed
 * is left alone even if it fails to resolve: they may be about to create the
 * record, and silently rewriting what someone deliberately entered is worse than
 * letting them find out. A previous sslip.io fallback *is* re-probed, so a
 * cluster that later gains its wildcard goes back to using it.
 */
async function applyWildcardFallback(derived: string) {
  // `direct` is served by the *target* cluster's own ingress, and
  // loadTargetExposure has already named the environment after it. The host's
  // domain is not the serving one there, so probing it would answer a question
  // nobody asked -- and applying it would point the hostname at a cluster that
  // cannot reach the environment.
  if (usesDirect.value) {
    return;
  }

  const ours = !baseDomain.value ||
    baseDomain.value === derived ||
    isWildcardFallbackDomain(baseDomain.value);

  if (!ours || !derived || isIpLiteral(derived)) {
    return;
  }

  wildcardChecked.value = false;
  derivedBaseDomain.value = derived;

  const { wildcard, entryAddress } = await probeBaseDomain(store, HOST_CLUSTER_ID, derived, derived);

  // Inconclusive: no verdict is not a failing verdict, so nothing moves.
  if (wildcard === undefined) {
    return;
  }

  wildcardChecked.value = true;

  if (wildcard) {
    baseDomain.value = derived;
    wildcardMissing.value = false;

    return;
  }

  // The probe's own answer for where this Rancher's name resolves, which is the
  // address a browser reaches it at. Deliberately not the ingress Service's
  // address: k3s servicelb publishes the node's private VPC IP there, and an
  // environment named after that resolves to somewhere no browser can go.
  const fallback = wildcardDomainFor(entryAddress || '');

  wildcardMissing.value = true;
  wildcardNoAddress.value = !fallback;

  if (fallback) {
    baseDomain.value = fallback;
  }
}

/**
 * How this target will be reached, and whatever that mode needs.
 *
 * Only for a downstream target: on `local` the environment's own Ingress is
 * already on the cluster the base domain resolves to, and there is nothing to
 * decide.
 *
 * The fallback is applied here, by rewriting the base domain rather than by
 * computing the hostname a second way. Everything downstream of the field --
 * the hostname, the uniqueness check, the manifests, the prefill saved back to
 * the cluster -- then works exactly as it does for a Rancher with real DNS, and
 * the field stays editable, so a name the team actually controls replaces the
 * default by typing it.
 */
async function loadTargetExposure(targetIngressClass: string) {
  targetEntry.value = undefined;
  hostIngressClass.value = '';
  hostBaseDomain.value = '';
  hostClusterIssuer.value = '';
  hostIssuerKind.value = undefined;
  hostAcme.value = undefined;

  if (targetsLocal.value || !clusterId.value) {
    return;
  }

  const [host, entry] = await Promise.all([
    hostIngressDefaults(store),
    ingressEntry(store, clusterId.value, targetIngressClass),
  ]);

  hostIngressClass.value = host.ingressClass;
  hostBaseDomain.value = host.baseDomain;
  hostClusterIssuer.value = host.clusterIssuer || '';
  hostIssuerKind.value = host.issuerKind;
  hostAcme.value = host.acme;
  targetEntry.value = entry;

  // A real name already in the field wins, even in the fallback: it is either
  // this same default written back to the cluster by an earlier create, or a
  // deliberate override, and neither should be quietly replaced. Only the two
  // domains that cannot work -- absent, or a bare IP -- are filled in.
  if (!usesDirect.value || (baseDomain.value && !isIpLiteral(baseDomain.value))) {
    return;
  }

  const wildcard = wildcardDomainFor(entry?.addresses?.[0] || '');

  // Empty when the entry is a hostname rather than an address, which already
  // has a name of its own -- nothing to derive, so the field asks for one.
  if (wildcard) {
    baseDomain.value = wildcard;
  }
}

watch(clusterId, loadDefaults);

/**
 * Ask GitHub about the repository, debounced, and fill the branch list.
 *
 * Skipped outright when a Git token secret is named: that is the private-fork
 * case, the check is unauthenticated, and GitHub answers 404 for a private repo
 * exactly as it does for one that does not exist. Reporting "not found" there
 * would be actively misleading, so the form says nothing instead and the field
 * hint explains why.
 */
async function lookupRepo() {
  const ref = parseGitHubRepo(repo.value);

  branches.value = [];
  branchMatches.value = [];
  branchesTruncated.value = false;

  if (!ref || !isCloneableRepo(repo.value)) {
    repoCheck.value = 'idle';

    return;
  }

  if (gitSecretName.value) {
    repoCheck.value = 'skipped';

    return;
  }

  repoCheck.value = 'checking';

  const result = await checkRepo(ref);

  // The field may have moved on while the request was in flight; a stale answer
  // about a repository the user has already replaced is worse than none.
  if (parseGitHubRepo(repo.value)?.repo !== ref.repo || parseGitHubRepo(repo.value)?.owner !== ref.owner) {
    return;
  }

  repoCheck.value = result;

  if (result === 'ok') {
    const list = await listBranches(ref);

    branches.value = list.names;
    branchesTruncated.value = list.truncated;
  }
}

watch([repo, gitSecretName], () => {
  clearTimeout(repoTimer);
  repoTimer = setTimeout(lookupRepo, GITHUB_DEBOUNCE_MS);
});

onUnmounted(() => {
  clearTimeout(repoTimer);
  clearTimeout(branchTimer);
});

/**
 * The typed-vs-committed dance vue-select's `taggable` requires, and the reason
 * `selecting` has to be wired as well as `on-blur`. See utils/branch-field.ts --
 * it lives there so the event ordering can actually be tested.
 */
const branchField = createBranchField(() => branch.value, (value) => {
  branch.value = value;
});

/**
 * Fallback for a repository with more branches than the fetch cap allowed.
 *
 * Prefix-only, because that is all matching-refs does, so it is strictly worse
 * than the local substring filter it stands in for. It exists so that a branch
 * past the cap can still be reached at all rather than looking as though it does
 * not exist.
 *
 * `loading` is vue-select's own toggle, handed over by LabeledSelect's `search`
 * event, so the dropdown shows a spinner rather than "no options" while the
 * request is in flight.
 */
function onBranchSearch(query: string, loading?: (state: boolean) => void) {
  const ref = parseGitHubRepo(repo.value);

  branchField.search(query);
  clearTimeout(branchTimer);

  // Nothing to ask for when the whole list is already here: vue-select filters
  // it by substring locally, which is both instant and better than anything the
  // API can do -- matching-refs only matches a prefix.
  if (!ref || repoCheck.value !== 'ok' || !query || !branchesTruncated.value) {
    return;
  }

  loading?.(true);

  branchTimer = setTimeout(async() => {
    try {
      const found = await searchBranches(ref, query);

      // Merged rather than replacing the browse list: the user may clear the
      // box and expect the original suggestions back.
      branchMatches.value = found;
    } finally {
      loading?.(false);
    }
  }, GITHUB_DEBOUNCE_MS);
}

/**
 * Free-text field until GitHub offers something to choose from. Matches first,
 * because they are what the user is currently typing towards.
 */
const branchOptions = computed(() => Array.from(new Set([...branchMatches.value, ...branches.value])));

function buildSpec(): RemudaSpec {
  return {
    name:         name.value,
    repo:         repo.value,
    branch:       branch.value,
    backendImage: backendImage.value,
    hostname:     hostname.value,
    // Only when the environment answers somewhere other than 443 -- which is
    // only ever the direct mode's NodePort case, since a hop always arrives on
    // the host ingress's own 443.
    entryPort:    usesDirect.value && targetEntry.value?.port !== 443 ? targetEntry.value?.port : undefined,
    owner:        store.getters['auth/principalId']?.split('//')?.pop() || 'unknown',
    createdAt:    new Date().toISOString(),
    namespace:    REMUDA_NS,
    clusterId:    clusterId.value,
    // Absent in the direct mode: the hostname resolves to the target cluster
    // already, so the Ingress written next to the workload is the whole of it
    // and a second one on the host would front nothing.
    hop:          !usesHop.value || !targetEntry.value ? undefined : {
      hostClusterId:   HOST_CLUSTER_ID,
      targetClusterId: clusterId.value,
      addresses:       targetEntry.value.addresses,
      addressType:     targetEntry.value.addressType,
      port:            targetEntry.value.port,
      ingressClass:    hostIngressClass.value,
      clusterIssuer:   hostClusterIssuer.value || undefined,
      issuerKind:      hostIssuerKind.value,
      acme:            hostAcme.value?.spec,
    },
    ingressClass:  ingressClass.value,
    storageClass:  storageClass.value || undefined,
    // The *target* cluster's issuer, describing the objects written there. The
    // host's lives on `hop` instead -- mixing them made a downstream create try
    // to write an Issuer onto a cluster with no cert-manager, which is exactly
    // the cluster the design says needs none.
    clusterIssuer: clusterIssuer.value || undefined,
    issuerKind:    issuerKind.value,
    acme:          acme.value?.spec,
    gitSecretName: gitSecretName.value || undefined,
    dataSizeGb:    Number(dataSizeGb.value),
    uiSizeGb:      Number(uiSizeGb.value),
    cacheSizeGb:   Number(cacheSizeGb.value),

    nestedPodCidr:     nestedPodCidr.value,
    nestedServiceCidr: nestedServiceCidr.value,
  };
}

function generatePassword(): string {
  const bytes = new Uint8Array(24);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function submit(cb: (ok: boolean) => void) {
  try {
    // Checked here rather than left to the API because a collision can surface
    // on a cluster the user does not think they are creating anything on --
    // either the host cluster, where a hopped hostname is claimed, or the target
    // cluster, where a direct one is.
    if (await hostnameTaken(store, hostname.value, clusterId.value)) {
      error.value = i18n.t('remuda.error.hostnameTaken');
      cb(false);

      return;
    }

    await createEnvironment(store, clusterId.value, buildSpec(), generatePassword());
    // Persist what was used so the next create on this cluster prefills. The
    // environment already exists by this point, so a failure here must not be
    // reported as a failed create -- prefill is a convenience, not part of the
    // environment.
    await savePrefillDefaults();
    cb(true);
    router.push({ name: `${ PRODUCT_NAME }-c-cluster-environments`, params: { cluster: BLANK_CLUSTER } });
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.createFailed');
    cb(false);
  }
}

/**
 * Offered rather than done automatically: this installs a Deployment and a
 * cluster-default StorageClass, which is a change to the whole cluster and not
 * something to do behind someone's back. Once it lands, discovery re-runs and
 * fills the storage class field in, which the user can still override.
 */
async function installStorage(cb: (ok: boolean) => void) {
  installingStorage.value = true;
  try {
    await installLocalPathStorage(store, clusterId.value);
    await loadDefaults();
    cb(true);
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.storageInstallFailed');
    cb(false);
  } finally {
    installingStorage.value = false;
  }
}

async function savePrefillDefaults() {
  try {
    await saveDefaults(store, clusterId.value, {
      baseDomain:    baseDomain.value,
      ingressClass:  ingressClass.value,
      storageClass:  storageClass.value || undefined,
      clusterIssuer: clusterIssuer.value || undefined,

      nestedPodCidr:     nestedPodCidr.value,
      nestedServiceCidr: nestedServiceCidr.value,
    });
  } catch {
    // Deliberately swallowed -- see the call site.
  }
}

onMounted(async() => {
  try {
    clusters.value = await readyClusters(store);
    // Prefer a downstream cluster; local is discouraged but not blocked.
    clusterId.value = (clusters.value.find((c) => !c.isLocal) || clusters.value[0])?.id || '';
    await loadDefaults();
  } catch (e: any) {
    error.value = e?.message || i18n.t('remuda.error.loadFailed');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <Loading v-if="loading" />
  <div v-else>
    <h1>{{ i18n.t('remuda.create.title') }}</h1>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="targetsLocal"
      color="warning"
      :label="i18n.t('remuda.warning.localCluster')"
    />
    <Banner
      v-if="storageUnavailable"
      color="error"
    >
      <div class="remuda-banner">
        <span>{{ i18n.t('remuda.warning.noStorageClass') }}</span>
        <AsyncButton
          mode="apply"
          size="sm"
          :disabled="installingStorage"
          :action-label="i18n.t('remuda.create.installStorage')"
          :waiting-label="i18n.t('remuda.create.installingStorage')"
          @click="installStorage"
        />
      </div>
    </Banner>
    <Banner
      v-if="mirrorsIssuer"
      color="info"
      :label="i18n.t('remuda.create.issuerMirrored', { source: effectiveAcme?.source })"
    />
    <Banner
      v-if="!effectiveIssuer"
      color="warning"
      :label="i18n.t('remuda.warning.noIssuer')"
    />
    <Banner
      v-if="ingressClassMissing"
      color="error"
      :label="i18n.t(targetsLocal ? 'remuda.warning.noIngressClassLocal' : 'remuda.warning.noIngressClass')"
    />
    <Banner
      v-if="entryUnavailable"
      color="error"
      :label="i18n.t('remuda.warning.noIngressEntry')"
    />
    <template v-if="usesDirect && !entryUnavailable && !resolvingExposure">
      <Banner
        color="info"
        :label="i18n.t('remuda.warning.directExposure', {
          reason: i18n.t(`remuda.reason.${ exposure.reason }`),
          hostname,
        })"
      />
      <Banner
        v-if="pinnedToAddress"
        color="warning"
        :label="i18n.t('remuda.warning.directWildcard', { suffix: wildcardSuffix, address: entryAddress })"
      />
    </template>
    <Banner
      v-if="publicEntry"
      color="warning"
      :label="i18n.t(usesDirect ? 'remuda.warning.directIsPublic' : 'remuda.warning.hopIsPublic', { address: entryAddress })"
    />
    <Banner
      v-if="!baseDomain"
      color="warning"
      :label="i18n.t('remuda.warning.noBaseDomain')"
    />
    <Banner
      v-else-if="baseDomainUnresolvable"
      color="warning"
      :label="i18n.t('remuda.warning.baseDomainIsIp', { baseDomain })"
    />
    <Banner
      v-if="wildcardChecked && wildcardMissing && wildcardNoAddress"
      color="warning"
      :label="i18n.t('remuda.warning.wildcardNoAddress', { derived: derivedBaseDomain })"
    />
    <Banner
      v-else-if="wildcardChecked && wildcardMissing"
      color="info"
      :label="i18n.t('remuda.warning.wildcardMissing', { derived: derivedBaseDomain, baseDomain })"
    />

    <div class="row mb-20">
      <div class="col span-6">
        <LabeledSelect
          v-model:value="clusterId"
          name="clusterId"
          :rules="getRules('clusterId')"
          :label="i18n.t('remuda.create.clusterLabel')"
          :options="clusterOptions"
        />
      </div>
      <div class="col span-6">
        <LabeledInput
          v-model:value="name"
          name="name"
          :rules="getRules('name')"
          :label="i18n.t('remuda.create.nameLabel')"
          :placeholder="i18n.t('remuda.create.namePlaceholder')"
          :tooltip="i18n.t('remuda.create.nameHint')"
        />
      </div>
    </div>

    <div class="row mb-20">
      <div class="col span-6">
        <LabeledInput
          v-model:value="repo"
          name="repo"
          :rules="getRules('repo')"
          :label="i18n.t('remuda.create.repoLabel')"
          :placeholder="i18n.t('remuda.create.repoPlaceholder')"
          :tooltip="i18n.t('remuda.create.repoHint')"
        />
        <p
          v-if="repoStatus"
          class="remuda-field-note"
          :class="{ 'remuda-field-note--error': repoCheck === 'missing' }"
        >
          {{ repoStatus }}
        </p>
      </div>
      <div class="col span-6">
        <!--
          One component for the whole life of the form, never swapped.
          Previously this was a LabeledInput that became a LabeledSelect once
          GitHub answered: a user typing their branch while that request was in
          flight had the field replaced under them mid-word, losing what they had
          typed and the caret with it.

          So the select is here from the start and simply gains options later.
          `taggable` is what keeps it a free-text field -- the list is capped,
          and private and non-GitHub repositories never populate it at all, so a
          branch that is not in the list still has to be typeable.
        -->
        <LabeledSelect
          v-model:value="branch"
          name="branch"
          taggable
          searchable
          :rules="getRules('branch')"
          :label="i18n.t('remuda.create.branchLabel')"
          :placeholder="i18n.t('remuda.create.branchPlaceholder')"
          :tooltip="i18n.t('remuda.create.branchHint')"
          :options="branchOptions"
          @search="onBranchSearch"
          @selecting="branchField.select()"
          @on-blur="branchField.blur()"
        />
        <p
          v-if="branchStatus"
          class="remuda-field-note"
        >
          {{ branchStatus }}
        </p>
      </div>
    </div>

    <div
      v-if="hostname"
      class="mb-20"
    >
      <label>{{ i18n.t('remuda.create.hostnameLabel') }}</label>
      <div><code>https://{{ hostname }}</code></div>
    </div>

    <AdvancedSection>
      <div class="row mb-20">
        <div class="col span-6">
          <LabeledInput
            v-model:value="backendImage"
            :label="i18n.t('remuda.create.backendLabel')"
            :tooltip="i18n.t('remuda.create.backendHint')"
            @update:value="backendTouched = true"
          />
        </div>
        <div class="col span-6">
          <LabeledInput
            v-model:value="gitSecretName"
            :label="i18n.t('remuda.create.gitSecretLabel')"
            :tooltip="i18n.t('remuda.create.gitSecretHint')"
          />
        </div>
      </div>

      <h3>{{ i18n.t('remuda.create.clusterConfig') }}</h3>
      <div class="row mb-20">
        <div class="col span-3">
          <LabeledInput
            v-model:value="baseDomain"
            :label="i18n.t('remuda.create.baseDomain')"
            :tooltip="i18n.t('remuda.create.baseDomainHint')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="ingressClass"
            :label="i18n.t('remuda.create.ingressClass')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="storageClass"
            :label="i18n.t('remuda.create.storageClass')"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="clusterIssuer"
            :label="i18n.t('remuda.create.clusterIssuer')"
          />
        </div>
      </div>

      <h3>{{ i18n.t('remuda.create.sizes') }}</h3>
      <div class="row mb-20">
        <div class="col span-4">
          <LabeledInput
            v-model:value="dataSizeGb"
            type="number"
            :label="i18n.t('remuda.create.dataSize')"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="uiSizeGb"
            type="number"
            :label="i18n.t('remuda.create.uiSize')"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="cacheSizeGb"
            type="number"
            :label="i18n.t('remuda.create.cacheSize')"
          />
        </div>
      </div>
    </AdvancedSection>

    <div class="remuda-footer">
      <AsyncButton
        mode="create"
        :disabled="!canSubmit"
        :action-label="i18n.t('remuda.create.submit')"
        @click="submit"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
h3 {
  margin-bottom: 10px;
}

.remuda-field-note {
  color: var(--input-label);
  font-size: 12px;
  margin: 4px 0 0;

  &--error {
    color: var(--error);
  }
}

.remuda-banner {
  align-items: center;
  display: flex;
  gap: 16px;
  justify-content: space-between;
}

// Matches the other create forms: the action sits right, at its natural width,
// rather than stretching the full width of the page.
.remuda-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
