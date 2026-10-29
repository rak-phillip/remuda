package main

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// An environment fronting a Rancher that already exists, rather than running
// its own. See EnvironmentSpec.BackendURL.
func proxySpec() *renderSpec {
	spec := testSpec()
	spec.BackendURL = "https://prak-6b7be798.ui.rancher.space"
	spec.BackendImage = ""
	spec.NestedPodCIDR = ""
	spec.NestedServiceCIDR = ""

	return spec
}

func kindsAndNames(objects []manifest) map[string]bool {
	out := map[string]bool{}

	for _, m := range objects {
		out[m.GVK.Kind+"/"+m.Name] = true
	}

	return out
}

func TestNormalizeBackendURL(t *testing.T) {
	for _, c := range []struct {
		in, want string
		ok       bool
	}{
		{"https://rancher.example.com", "https://rancher.example.com", true},
		{"https://rancher.example.com/", "https://rancher.example.com", true},
		{"  https://rancher.example.com:8443  ", "https://rancher.example.com:8443", true},
		{"http://10.0.0.5", "http://10.0.0.5", true},
		// Copied from a browser tab: proxying to it would look right and not be.
		{"https://rancher.example.com/dashboard/home", "", false},
		{"https://rancher.example.com/?x=1", "", false},
		{"https://admin:pw@rancher.example.com", "", false},
		{"rancher.example.com", "", false},
		{"ftp://rancher.example.com", "", false},
		{"https://", "", false},
	} {
		got, err := NormalizeBackendURL(c.in)

		if c.ok && (err != nil || got != c.want) {
			t.Errorf("NormalizeBackendURL(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}

		if !c.ok && err == nil {
			t.Errorf("NormalizeBackendURL(%q) = %q, want an error", c.in, got)
		}
	}
}

func TestExternalBackendRendersOnlyTheUI(t *testing.T) {
	objects := kindsAndNames(desiredObjects(proxySpec(), "", "1", 1))

	for _, absent := range []string{
		"Secret/multi-idp-bootstrap",
		"ConfigMap/multi-idp-k3s-config",
		"PersistentVolumeClaim/multi-idp-data",
		"Service/multi-idp",
		"Deployment/multi-idp",
	} {
		if objects[absent] {
			t.Errorf("an external-backend environment renders %s, which only a backend of its own needs", absent)
		}
	}

	for _, present := range []string{
		"ConfigMap/multi-idp-ui-nginx",
		"PersistentVolumeClaim/multi-idp-ui",
		"PersistentVolumeClaim/multi-idp-cache",
		"Service/multi-idp-ui",
		"Deployment/multi-idp-ui",
		"Ingress/multi-idp",
		"Job/multi-idp-build-1",
	} {
		if !objects[present] {
			t.Errorf("an external-backend environment is missing %s", present)
		}
	}
}

func TestExternalBackendIngressSendsEverythingToNginx(t *testing.T) {
	paths := proxySpec().ingress().Spec.Rules[0].HTTP.Paths

	if len(paths) != 1 || paths[0].Path != "/" || paths[0].Backend.Service.Name != "multi-idp-ui" {
		t.Errorf("paths = %+v, want one / path to multi-idp-ui", paths)
	}

	// Unchanged for an environment with its own backend.
	own := testSpec().ingress().Spec.Rules[0].HTTP.Paths
	if len(own) != 2 || own[1].Backend.Service.Name != "multi-idp" {
		t.Errorf("own-backend paths = %+v", own)
	}
}

func TestExternalBackendProxyConfig(t *testing.T) {
	config := proxySpec().uiNginxConfig().Data["default.conf"]

	for _, want := range []string{
		// Resolved per request, so a backend that is down or gone cannot stop
		// nginx starting and take the bundle with it.
		"resolver ${NGINX_LOCAL_RESOLVERS} valid=30s;",
		"set $remuda_backend https://prak-6b7be798.ui.rancher.space;",
		"proxy_pass $remuda_backend;",
		// TLS ends at the ingress; an absolute redirect would say http://.
		"absolute_redirect off;",
		// The backend's ingress routes on Host, and its certificate on SNI.
		"proxy_set_header Host prak-6b7be798.ui.rancher.space;",
		"proxy_ssl_name prak-6b7be798.ui.rancher.space;",
		"proxy_ssl_server_name on;",
		// Links in API responses come back to this host, not the backend's.
		"proxy_set_header X-API-Host $host;",
		// Rancher refuses a websocket from an origin that is not its own.
		"default https://prak-6b7be798.ui.rancher.space;",
		"proxy_set_header Origin $remuda_origin;",
		"proxy_set_header Upgrade $http_upgrade;",
		"proxy_set_header Connection $remuda_connection;",
		// Every route of the app is its index, as Rancher serves it.
		"location /dashboard/ {",
		"try_files /ui-bundle/index.html =404;",
		"location /ui-bundle/ {",
		"proxy_redirect https://prak-6b7be798.ui.rancher.space/ /;",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("proxy config is missing %q", want)
		}
	}

	// The wildcard CORS header belongs to the bundle, not to proxied API
	// responses.
	bundle := config[strings.Index(config, "location /ui-bundle/"):strings.Index(config, "location = /")]
	if strings.Count(config, "Access-Control-Allow-Origin") != 1 || !strings.Contains(bundle, "Access-Control-Allow-Origin") {
		t.Error("Access-Control-Allow-Origin is set somewhere other than the bundle location")
	}
}

func TestExternalBackendKeepsAPortInTheHostHeader(t *testing.T) {
	spec := proxySpec()
	spec.BackendURL = "https://rancher.example.com:8443"

	config := spec.uiNginxConfig().Data["default.conf"]

	if !strings.Contains(config, "proxy_set_header Host rancher.example.com:8443;") {
		t.Error("the Host header drops the backend's port")
	}

	if !strings.Contains(config, "proxy_ssl_name rancher.example.com;") {
		t.Error("the SNI name carries the port")
	}
}

func TestExternalBackendMountsTheConfigAsATemplate(t *testing.T) {
	container := proxySpec().uiDeployment(1).Spec.Template.Spec.Containers[0]

	if envOf(container)["NGINX_ENTRYPOINT_LOCAL_RESOLVERS"] != "1" {
		t.Error("the entrypoint is not asked to fill in NGINX_LOCAL_RESOLVERS")
	}

	var mount string

	for _, m := range container.VolumeMounts {
		if m.Name == "nginx-config" {
			mount = m.MountPath
		}
	}

	if mount != NginxTemplatePath {
		t.Errorf("nginx-config is mounted at %q, want %q", mount, NginxTemplatePath)
	}

	// Unchanged for an environment with its own backend.
	own := testSpec().uiDeployment(1).Spec.Template.Spec.Containers[0]
	if len(own.Env) != 0 || own.VolumeMounts[1].MountPath != NginxConfPath {
		t.Errorf("own-backend nginx: env = %v, mounts = %v", own.Env, own.VolumeMounts)
	}
}

func TestOwnBackendNginxConfigIsUnchanged(t *testing.T) {
	config := testSpec().uiNginxConfig().Data["default.conf"]

	if strings.Contains(config, "proxy_pass") {
		t.Error("an environment with its own backend proxies through nginx")
	}
}

func TestWorkloadName(t *testing.T) {
	if got := testSpec().workloadName(); got != "multi-idp" {
		t.Errorf("own backend: workloadName = %q", got)
	}

	if got := proxySpec().workloadName(); got != "multi-idp-ui" {
		t.Errorf("external backend: workloadName = %q", got)
	}
}

func TestRequirePinnedSkipsTheCIDRsForAnExternalBackend(t *testing.T) {
	env := &Environment{}
	env.Name = "multi-idp"
	env.Spec.ClusterID = "c-m-abc"

	spec := proxySpec()

	if err := requirePinned(env, spec); err != nil {
		t.Errorf("requirePinned = %v; an external backend has no nested k3s to configure", err)
	}

	spec.StorageClass = ""

	if err := requirePinned(env, spec); err == nil || !strings.Contains(err.Error(), "spec.storageClass") {
		t.Errorf("requirePinned = %v, want spec.storageClass named", err)
	}
}

func TestPrimeSetsTheVersionType(t *testing.T) {
	spec := testSpec()

	if _, set := envOf(backendPod(spec).Containers[0])[PrimeEnvVar]; set {
		t.Errorf("%s is set on a community backend", PrimeEnvVar)
	}

	spec.Prime = true

	if got := envOf(backendPod(spec).Containers[0])[PrimeEnvVar]; got != "prime" {
		t.Errorf("%s = %q, want prime", PrimeEnvVar, got)
	}

	// Same image: Prime is a runtime setting, not a different build.
	if got := backendPod(spec).Containers[0].Image; got != "rancher/rancher:head" {
		t.Errorf("image = %q", got)
	}
}

func TestWebhookWatchdogSharesTheNestedKubeconfig(t *testing.T) {
	pod := backendPod(testSpec())

	if len(pod.Containers) != 2 || pod.Containers[1].Name != "webhook-watchdog" {
		t.Fatalf("containers = %d, want rancher and webhook-watchdog", len(pod.Containers))
	}

	rancher, watchdog := pod.Containers[0], pod.Containers[1]

	mounted := func(c corev1.Container) bool {
		for _, m := range c.VolumeMounts {
			if m.Name == "k3s-etc" && m.MountPath == K3sConfigDir {
				return true
			}
		}

		return false
	}

	if !mounted(rancher) || !mounted(watchdog) {
		t.Error("the k3s kubeconfig directory is not shared between rancher and the watchdog")
	}

	var emptyDir bool

	for _, v := range pod.Volumes {
		if v.Name == "k3s-etc" && v.EmptyDir != nil {
			emptyDir = true
		}
	}

	if !emptyDir {
		t.Error("k3s-etc is not an emptyDir")
	}

	// The config file still lands inside the shared directory.
	var configMounted bool

	for _, m := range rancher.VolumeMounts {
		if m.MountPath == K3sConfigPath && m.SubPath == "config.yaml" {
			configMounted = true
		}
	}

	if !configMounted {
		t.Error("the k3s config file is no longer mounted")
	}

	// Never privileged: it only talks to the nested apiserver.
	if watchdog.SecurityContext != nil && watchdog.SecurityContext.Privileged != nil && *watchdog.SecurityContext.Privileged {
		t.Error("the watchdog is privileged")
	}
}

func TestWebhookWatchdogScript(t *testing.T) {
	script := WebhookWatchdogScript()

	for _, want := range []string{
		"KUBECONFIG=/etc/rancher/k3s/k3s.yaml",
		"get endpoints rancher-webhook",
		"validatingwebhookconfiguration mutatingwebhookconfiguration",
		`delete "$kind" rancher.cattle.io`,
		// Acting only once the apiserver answers keeps it quiet while k3s is
		// still coming up.
		"get --raw /readyz",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("watchdog script is missing %q", want)
		}
	}
}

func TestAnEmptyBuildIDDeliversNoJob(t *testing.T) {
	for _, m := range desiredObjects(testSpec(), "pw", "", 1) {
		if m.GVK.Kind == "Job" {
			t.Errorf("rendered %s with no build id", m.Name)
		}
	}
}

// The message Fleet reported for supercharged-tables on 2026-10-14, with the
// pod template it quotes cut down to its ends.
const immutableJobMessage = `server-side apply failed for object rancher-remuda/supercharged-tables-build-1790804111 ` +
	`batch/v1, Kind=Job: Job.batch "supercharged-tables-build-1790804111" is invalid: spec.template: ` +
	`Invalid value: {"labels":{"job-name":"supercharged-tables-build-1790804111"}}: field is immutable`

func TestImmutableJobsIn(t *testing.T) {
	got := immutableJobsIn([]any{
		map[string]any{"bundleState": "ErrApplied", "message": immutableJobMessage},
		// A real failure on something else stays a real failure.
		map[string]any{"bundleState": "ErrApplied", "message": `server-side apply failed for object rancher-remuda/x apps/v1, Kind=Deployment: field is immutable`},
		map[string]any{"bundleState": "NotReady", "message": "deployment not ready"},
		"not a map",
	})

	if len(got) != 1 || got[0] != "supercharged-tables-build-1790804111" {
		t.Errorf("immutableJobsIn = %v", got)
	}
}

func TestRetireStuckBuild(t *testing.T) {
	spec := testSpec()
	env := &Environment{}
	env.Status.BuildID = "1790804111"

	stuck := observation{ImmutableJobs: []string{spec.buildJobName("1790804111")}}

	if retireStuckBuild(env, spec, observation{}) {
		t.Error("retired a build nothing reported stuck")
	}

	if retireStuckBuild(env, spec, observation{ImmutableJobs: []string{spec.buildJobName("1")}}) {
		t.Error("retired the current build over a different Job")
	}

	if !retireStuckBuild(env, spec, stuck) || env.Status.RetiredBuildID != "1790804111" {
		t.Fatalf("did not retire the stuck build; status = %+v", env.Status)
	}

	if deliveredBuildID(env) != "" {
		t.Error("a retired build's Job is still delivered")
	}

	// Once is enough.
	if retireStuckBuild(env, spec, stuck) {
		t.Error("retired the same build twice")
	}

	// A rebuild names a new Job, and that one is delivered as normal.
	env.Status.BuildID = "1791999999"

	if deliveredBuildID(env) != "1791999999" {
		t.Errorf("deliveredBuildID = %q after a rebuild", deliveredBuildID(env))
	}
}
