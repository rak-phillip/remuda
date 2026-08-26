package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
)

// The same environment the extension's manifests.test.ts renders, field for
// field, so the two files can be diffed by eye. A divergence between the two
// renderers should show up as a failing assertion here rather than as an
// environment that behaves differently depending on which one created it.
//
// A constructor rather than a package var: several cases below clear a field the
// way the TS tests spread-override one, and Go tests share package state.
func testSpec() *renderSpec {
	return &renderSpec{
		Name:      "multi-idp",
		Namespace: "rancher-remuda",
		Owner:     "prak",

		Repo:   "https://github.com/rak-phillip/dashboard",
		Branch: "task/17295-multi-idp",

		BackendImage: "rancher/rancher:head",
		Hostname:     "multi-idp.prak-bf3b08bd.ui.rancher.space",

		IngressClass:  "traefik",
		StorageClass:  "local-path",
		ClusterIssuer: "remuda-le",

		DataSizeGB:  20,
		UISizeGB:    2,
		CacheSizeGB: 8,

		NestedPodCIDR:     "10.44.0.0/16",
		NestedServiceCIDR: "10.45.0.0/16",

		OwnerRef: metav1.OwnerReference{
			APIVersion: "remuda.rancher.io/v1alpha1",
			Kind:       "Environment",
			Name:       "multi-idp",
			UID:        "8b1a9953-c461-4f5e-9b8f-1a2b3c4d5e6f",
		},
	}
}

// envOf collects the plain-valued environment variables. Anything sourced from a
// secret is deliberately excluded -- see the bootstrap password test.
func envOf(c corev1.Container) map[string]string {
	out := map[string]string{}

	for _, e := range c.Env {
		if e.ValueFrom == nil {
			out[e.Name] = e.Value
		}
	}

	return out
}

func backendPod(spec *renderSpec) corev1.PodSpec {
	return spec.backendDeployment(1).Spec.Template.Spec
}

func TestLabels(t *testing.T) {
	want := map[string]string{
		LabelManaged: "true",
		LabelName:    "multi-idp",
		LabelOwner:   "prak",
	}

	got := testSpec().labels("")
	for k, v := range want {
		if got[k] != v {
			t.Errorf("labels()[%q] = %q, want %q", k, got[k], v)
		}
	}

	// Omitted rather than emitted empty when nobody owns the environment, which
	// a scripted create may well leave unset. An empty label value is legal but
	// matches a selector for "" and reads as an owner named nothing.
	spec := testSpec()
	spec.Owner = ""

	if _, found := spec.labels("")[LabelOwner]; found {
		t.Error("an empty owner should produce no owner label at all")
	}
}

func TestEveryObjectIsLabelledForTheSweep(t *testing.T) {
	// Delete sweeps by label, so an object that misses these is an object that
	// survives its environment.
	for _, m := range desiredObjects(testSpec(), "pw", "1", 1) {
		if m.Shared {
			continue
		}

		labels, err := labelsOf(m)
		if err != nil {
			t.Fatalf("%s %s: %v", m.GVK.Kind, m.Name, err)
		}

		if labels[LabelManaged] != "true" || labels[LabelName] != "multi-idp" {
			t.Errorf("%s %s has labels %v", m.GVK.Kind, m.Name, labels)
		}
	}
}

func labelsOf(m manifest) (map[string]string, error) {
	raw, err := json.Marshal(m.Object)
	if err != nil {
		return nil, err
	}

	var object struct {
		Metadata struct {
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
	}

	return object.Metadata.Labels, json.Unmarshal(raw, &object)
}

func TestURLs(t *testing.T) {
	spec := testSpec()

	// The bundle's assets are fetched by the browser, so this must be the public
	// host. It is baked in at build time and cannot be changed afterwards.
	if got := spec.resourceBase(); got != "https://multi-idp.prak-bf3b08bd.ui.rancher.space/ui-bundle" {
		t.Errorf("resourceBase = %q", got)
	}

	// The index is fetched server-side by the Rancher pod, so keeping it
	// in-cluster avoids depending on hairpin routing back through the ingress.
	if got := spec.dashboardIndexURL(); got != "http://multi-idp-ui.rancher-remuda.svc.cluster.local/ui-bundle/index.html" {
		t.Errorf("dashboardIndexURL = %q", got)
	}

	if got := spec.EnvironmentURL(); got != "https://multi-idp.prak-bf3b08bd.ui.rancher.space" {
		t.Errorf("EnvironmentURL = %q", got)
	}

	// The in-cluster address is unreachable from a developer's own Rancher; this
	// one goes through the ingress, which already routes the bundle path.
	if got := spec.SharedBundleURL(); got != "https://multi-idp.prak-bf3b08bd.ui.rancher.space/ui-bundle/index.html" {
		t.Errorf("SharedBundleURL = %q", got)
	}
}

func TestURLsCarryTheEntryPort(t *testing.T) {
	// Direct exposure onto a NodePort: nothing normalises the port, so both
	// browser-facing URLs have to carry it -- and they have to agree, because the
	// bundle is only same-origin with the backend if they do.
	spec := testSpec()
	spec.Hostname = "multi-idp.44.247.97.31.sslip.io"
	spec.EntryPort = 31443

	if got := spec.EnvironmentURL(); got != "https://multi-idp.44.247.97.31.sslip.io:31443" {
		t.Errorf("EnvironmentURL = %q", got)
	}

	if got := spec.resourceBase(); got != "https://multi-idp.44.247.97.31.sslip.io:31443/ui-bundle" {
		t.Errorf("resourceBase = %q", got)
	}

	if got := spec.SharedBundleURL(); got != "https://multi-idp.44.247.97.31.sslip.io:31443/ui-bundle/index.html" {
		t.Errorf("SharedBundleURL = %q", got)
	}

	// traefik and nginx both match Host ignoring the port, which is what lets a
	// :31443 request reach a rule written for the bare name.
	ingress := spec.ingress()
	if got := ingress.Spec.Rules[0].Host; got != "multi-idp.44.247.97.31.sslip.io" {
		t.Errorf("Ingress host = %q, want the bare name", got)
	}

	if got := ingress.Spec.TLS[0].Hosts[0]; got != "multi-idp.44.247.97.31.sslip.io" {
		t.Errorf("TLS host = %q, want the bare name", got)
	}

	// The pod-facing URL is unaffected: the port belongs to the ingress, not to
	// the in-cluster Service.
	if got := spec.dashboardIndexURL(); got != "http://multi-idp-ui.rancher-remuda.svc.cluster.local/ui-bundle/index.html" {
		t.Errorf("dashboardIndexURL = %q, want it unchanged", got)
	}
}

func TestBackendDeployment(t *testing.T) {
	spec := testSpec()
	pod := backendPod(spec)
	container := pod.Containers[0]
	env := envOf(container)

	// "dynamic" gates on a canDownload() check wrapped in a sync.Once: if the
	// bundle is not up at that moment Rancher falls back to the embedded UI for
	// the life of the process. Our bundle is built asynchronously, so it would.
	if env["CATTLE_UI_OFFLINE_PREFERRED"] != "false" {
		t.Errorf("CATTLE_UI_OFFLINE_PREFERRED = %q, want exactly \"false\"", env["CATTLE_UI_OFFLINE_PREFERRED"])
	}

	if env["CATTLE_UI_DASHBOARD_INDEX"] != spec.dashboardIndexURL() {
		t.Errorf("CATTLE_UI_DASHBOARD_INDEX = %q", env["CATTLE_UI_DASHBOARD_INDEX"])
	}

	// Taken from the Secret rather than inlined, so the password is not readable
	// to anyone who can read a Deployment.
	var bootstrap *corev1.EnvVar

	for i := range container.Env {
		if container.Env[i].Name == "CATTLE_BOOTSTRAP_PASSWORD" {
			bootstrap = &container.Env[i]
		}
	}

	if bootstrap == nil || bootstrap.ValueFrom == nil || bootstrap.ValueFrom.SecretKeyRef == nil {
		t.Fatal("the bootstrap password does not come from a secret")
	}

	if bootstrap.Value != "" {
		t.Error("the bootstrap password is inlined as a literal value")
	}

	ref := bootstrap.ValueFrom.SecretKeyRef
	if ref.Name != "multi-idp-bootstrap" || ref.Key != "password" {
		t.Errorf("secretKeyRef = %s/%s", ref.Name, ref.Key)
	}

	// Rancher's single-container image embeds k3s, which needs privileged.
	if container.SecurityContext == nil || container.SecurityContext.Privileged == nil || !*container.SecurityContext.Privileged {
		t.Error("the backend container is not privileged")
	}

	if !contains(container.Args, "--no-cacerts") {
		t.Errorf("args = %v, want --no-cacerts", container.Args)
	}

	// Without this, Rancher may detect the token and drive the HOST cluster.
	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Error("the backend pod mounts a service account token")
	}

	// The RWO data volume must be released before the new pod starts.
	if got := spec.backendDeployment(1).Spec.Strategy.Type; got != appsv1.RecreateDeploymentStrategyType {
		t.Errorf("strategy = %q, want Recreate", got)
	}

	// Measured on a restart: 6m06s from pod start to /dashboard/ answering 200,
	// with readyReplicas=1 for all of it. Without a probe, "Ready" in the UI
	// means only that the process launched.
	probe := container.ReadinessProbe
	if probe == nil || probe.HTTPGet == nil {
		t.Fatal("no readiness probe")
	}

	if probe.HTTPGet.Path != "/healthz" || probe.HTTPGet.Port.IntValue() != 80 {
		t.Errorf("readiness probe = %s:%v", probe.HTTPGet.Path, probe.HTTPGet.Port)
	}

	// A liveness probe would kill the pod during the etcd cluster-reset a restart
	// goes through, and it would never finish recovering.
	if container.LivenessProbe != nil {
		t.Error("there is a liveness probe, which would kill the pod mid-recovery")
	}
}

func TestBackendDeploymentNestedK3sWiring(t *testing.T) {
	pod := backendPod(testSpec())

	var mount *corev1.VolumeMount

	for i := range pod.Containers[0].VolumeMounts {
		if pod.Containers[0].VolumeMounts[i].MountPath == K3sConfigPath {
			mount = &pod.Containers[0].VolumeMounts[i]
		}
	}

	if mount == nil {
		t.Fatal("the k3s config is not mounted")
	}

	// subPath matters: a whole-directory mount would make /etc/rancher/k3s
	// read-only and k3s could not write its generated kubeconfig there.
	if mount.Name != "k3s-config" || mount.SubPath != "config.yaml" {
		t.Errorf("mount = %+v", *mount)
	}

	var found bool

	for _, v := range pod.Volumes {
		if v.Name == "k3s-config" && v.ConfigMap != nil && v.ConfigMap.Name == "multi-idp-k3s-config" {
			found = true
		}
	}

	if !found {
		t.Error("the k3s-config volume does not come from the environment's ConfigMap")
	}

	// 'Default' would hand the pod the node's resolvers, under which the
	// *.svc.cluster.local host in CATTLE_UI_DASHBOARD_INDEX does not resolve.
	//
	// Go's zero value serialises absent and lets the API server default it to
	// ClusterFirst, which is the same outcome the TS renderer gets by omitting
	// the key.
	if pod.DNSPolicy != "" {
		t.Errorf("dnsPolicy = %q, want it left to the API server's ClusterFirst default", pod.DNSPolicy)
	}
}

func TestInotifyInitContainer(t *testing.T) {
	spec := testSpec()
	init := spec.inotifyInitContainer()
	script := init.Command[2]

	// fs.inotify.* is not a namespaced sysctl, so securityContext.sysctls cannot
	// set it and the write has to go through a privileged /proc/sys.
	for _, want := range []string{
		"> /proc/sys/fs/inotify/max_user_instances",
		"> /proc/sys/fs/inotify/max_user_watches",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("the script does not write %s", want)
		}
	}

	if init.SecurityContext == nil || init.SecurityContext.Privileged == nil || !*init.SecurityContext.Privileged {
		t.Error("the init container is not privileged, so it cannot write /proc/sys")
	}

	// Best-effort, so a locked-down node still starts the environment.
	if !strings.Contains(script, "|| echo") {
		t.Error("a failed write aborts the init container")
	}

	// Echoed so the init log shows what actually took hold.
	if !strings.Contains(script, "max_user_instances=$(cat /proc/sys/fs/inotify/max_user_instances)") {
		t.Error("the effective values are not echoed")
	}

	// The backend image, so this costs no extra pull.
	if init.Image != spec.BackendImage {
		t.Errorf("image = %q, want the backend image", init.Image)
	}

	pod := backendPod(spec)
	if len(pod.InitContainers) != 1 || pod.InitContainers[0].Name != "raise-inotify-limits" {
		t.Errorf("init containers = %+v", pod.InitContainers)
	}
}

func TestIngress(t *testing.T) {
	spec := testSpec()
	ingress := spec.ingress()
	paths := ingress.Spec.Rules[0].HTTP.Paths

	// The bundle path must precede '/', which catches everything else.
	if len(paths) != 2 || paths[0].Path != "/"+UIBundlePath || paths[1].Path != "/" {
		t.Fatalf("paths = %+v", paths)
	}

	if paths[0].Backend.Service.Name != "multi-idp-ui" || paths[1].Backend.Service.Name != "multi-idp" {
		t.Errorf("backends = %q, %q", paths[0].Backend.Service.Name, paths[1].Backend.Service.Name)
	}

	// traefik would need a ServersTransport CRD to talk HTTPS upstream; Rancher's
	// own ingress on the same cluster terminates TLS and uses port 80.
	for _, p := range paths {
		if p.Backend.Service.Port.Number != 80 {
			t.Errorf("%s targets port %d, want 80", p.Path, p.Backend.Service.Port.Number)
		}
	}

	if got := ingress.Annotations["cert-manager.io/cluster-issuer"]; got != "remuda-le" {
		t.Errorf("issuer annotation = %q", got)
	}

	if len(ingress.Spec.TLS) != 1 || ingress.Spec.TLS[0].SecretName != "multi-idp-tls" {
		t.Errorf("tls = %+v", ingress.Spec.TLS)
	}
}

func TestIngressOmitsTLSWithNoIssuer(t *testing.T) {
	// Omitted entirely rather than emitted as an empty block, which cert-manager
	// and the ingress controller would both read as a request they cannot serve.
	spec := testSpec()
	spec.ClusterIssuer = ""

	ingress := spec.ingress()

	if ingress.Spec.TLS != nil {
		t.Errorf("tls = %+v, want none", ingress.Spec.TLS)
	}

	if ingress.Annotations != nil {
		t.Errorf("annotations = %v, want none", ingress.Annotations)
	}
}

func TestPVC(t *testing.T) {
	spec := testSpec()
	claim := spec.pvc("data", spec.DataSizeGB, RoleBackend)

	if claim.Spec.StorageClassName == nil || *claim.Spec.StorageClassName != "local-path" {
		t.Errorf("storageClassName = %v", claim.Spec.StorageClassName)
	}

	// Compared as a string, never with reflect.DeepEqual: a Quantity carries an
	// unexported cached string and a format enum, so two Quantities holding the
	// same value compare unequal depending on how each was built. The serialised
	// form is what the API server sees and what the TS test asserts.
	got := claim.Spec.Resources.Requests[corev1.ResourceStorage]
	if got.String() != "20Gi" {
		t.Errorf("storage = %q, want 20Gi", got.String())
	}
}

func TestPVCOmitsTheStorageClassWhenThereIsNone(t *testing.T) {
	spec := testSpec()
	spec.StorageClass = ""

	// nil, not a pointer to "". The API server takes an explicit empty string
	// literally -- a PVC asking for the class named "" binds nothing -- which is
	// why the TS renderer asserts the key is absent rather than empty.
	claim := spec.pvc("data", 20, RoleBackend)
	if claim.Spec.StorageClassName != nil {
		t.Errorf("storageClassName = %q, want it absent entirely", *claim.Spec.StorageClassName)
	}

	// Belt and braces, because the pointer-versus-absent distinction is exactly
	// what a future refactor loses without noticing.
	raw, err := yaml.Marshal(claim)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(raw), "storageClassName") {
		t.Error("storageClassName reached the wire")
	}
}

func TestUIDeployment(t *testing.T) {
	spec := testSpec()
	pod := spec.uiDeployment(1).Spec.Template.Spec
	mounts := pod.Containers[0].VolumeMounts

	// Building into a directory named for the path means /ui-bundle/... resolves
	// straight off nginx's root with no rewrite rule.
	if mounts[0].Name != "bundle" || mounts[0].MountPath != "/usr/share/nginx/html" || !mounts[0].ReadOnly {
		t.Errorf("bundle mount = %+v", mounts[0])
	}

	if pod.Volumes[0].PersistentVolumeClaim.ClaimName != "multi-idp-ui" {
		t.Errorf("bundle claim = %q", pod.Volumes[0].PersistentVolumeClaim.ClaimName)
	}

	// Without subPath the ConfigMap mount shadows the whole of conf.d.
	if mounts[1].SubPath != "default.conf" || mounts[1].MountPath != NginxConfPath {
		t.Errorf("nginx config mount = %+v", mounts[1])
	}

	if pod.Volumes[1].ConfigMap.Name != spec.uiNginxConfigName() {
		t.Errorf("nginx config volume = %q", pod.Volumes[1].ConfigMap.Name)
	}
}

func TestUINginxConfig(t *testing.T) {
	spec := testSpec()
	cm := spec.uiNginxConfig()
	config := cm.Data["default.conf"]

	// Fonts are fetched in CORS mode whatever the markup says, so a bundle shared
	// with a Rancher on another origin renders in fallback fonts without this.
	if !strings.Contains(config, `add_header Access-Control-Allow-Origin "*" always;`) {
		t.Error("the bundle server sends no CORS header")
	}

	if !strings.Contains(config, "root /usr/share/nginx/html;") {
		t.Error("nginx does not serve from the root the PVC is mounted at")
	}

	if cm.Name != "multi-idp-ui-nginx" || cm.Labels[LabelName] != "multi-idp" {
		t.Errorf("metadata = %s %v", cm.Name, cm.Labels)
	}
}

func TestK3sConfig(t *testing.T) {
	spec := testSpec()
	cm := spec.k3sConfig()

	want := strings.Join([]string{
		"cluster-cidr:",
		`  - "10.44.0.0/16"`,
		"service-cidr:",
		`  - "10.45.0.0/16"`,
		"cluster-dns:",
		`  - "10.45.0.10"`,
		"",
	}, "\n")

	if got := cm.Data["config.yaml"]; got != want {
		t.Errorf("config.yaml =\n%s\nwant\n%s", got, want)
	}

	if cm.Name != "multi-idp-k3s-config" || spec.k3sConfigName() != "multi-idp-k3s-config" {
		t.Errorf("name = %q", cm.Name)
	}
}

func TestBuildScript(t *testing.T) {
	spec := testSpec()
	script := spec.BuildScript()

	for _, want := range []string{
		`RESOURCE_BASE="` + spec.resourceBase() + `"`,
		`ROUTER_BASE="/dashboard/"`,
		// build-hosted derives OUTPUT_DIR from the branch name, and this branch
		// has a slash in it, which would scatter the output across directories.
		`OUTPUT_DIR="dist/` + UIBundlePath + `"`,
		// shell/vue.config.js reads DASHBOARD_VERSION, not VERSION; without it
		// the About page in the deployed environment reads "undefined".
		`DASHBOARD_VERSION="$BRANCH $(cat /out/COMMIT.txt)"`,
		`git clone --depth 1 --branch "$BRANCH"`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("the build script is missing %s", want)
		}
	}

	if strings.Contains(script, "build-hosted") {
		t.Error("the script calls build-hosted, which derives OUTPUT_DIR from the branch")
	}

	// nginx serves straight off the volume, so a partial copy would be served.
	stage := strings.Index(script, `cp -r "dist/`+UIBundlePath+`" "/out/`+UIBundlePath+`.tmp"`)
	swap := strings.Index(script, `mv "/out/`+UIBundlePath+`.tmp" "/out/`+UIBundlePath+`"`)

	if stage < 0 || swap < stage {
		t.Errorf("the swap is not staged: stage=%d swap=%d", stage, swap)
	}

	if !strings.HasPrefix(script, "set -euo pipefail") {
		t.Error("the script does not abort on the first failing command")
	}
}

func TestBuildJob(t *testing.T) {
	spec := testSpec()

	// Jobs are immutable, so every rebuild is a distinct name.
	if got := spec.buildJob("1755792000").Name; got != "multi-idp-build-1755792000" {
		t.Errorf("name = %q", got)
	}

	if got := spec.buildJob("1755795600").Name; got != "multi-idp-build-1755795600" {
		t.Errorf("name = %q", got)
	}

	job := spec.buildJob("1")
	container := job.Spec.Template.Spec.Containers[0]
	env := envOf(container)

	if env["NODE_OPTIONS"] != "--max_old_space_size=4096" {
		t.Errorf("NODE_OPTIONS = %q", env["NODE_OPTIONS"])
	}

	memory := container.Resources.Limits[corev1.ResourceMemory]
	if memory.String() != "7Gi" {
		t.Errorf("memory limit = %q, want 7Gi", memory.String())
	}

	// The CPU limit caps os.availableParallelism() inside the container, which in
	// turn caps how many minifier isolates webpack opens -- so it sets the memory
	// peak (~5.3Gi measured at 4 CPU). Raising it without re-benchmarking memory
	// is what this guards against.
	cpu := container.Resources.Limits[corev1.ResourceCPU]
	if cpu.String() != "4" {
		t.Errorf("cpu limit = %q, want 4", cpu.String())
	}

	if _, found := envOf(container)["GIT_TOKEN"]; found {
		t.Error("a public fork should carry no git token")
	}

	for _, e := range container.Env {
		if e.Name == "GIT_TOKEN" {
			t.Error("a public fork should carry no GIT_TOKEN at all")
		}
	}

	if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 1 {
		t.Errorf("backoffLimit = %v, want 1 -- a broken branch must not retry forever", job.Spec.BackoffLimit)
	}
}

func TestBuildJobReadsAPrivateTokenFromASecret(t *testing.T) {
	spec := testSpec()
	spec.GitSecretName = "multi-idp-git"

	container := spec.buildJob("1").Spec.Template.Spec.Containers[0]

	for _, e := range container.Env {
		if e.Name != "GIT_TOKEN" {
			continue
		}

		if e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil {
			t.Fatal("GIT_TOKEN is not read from a secret")
		}

		ref := e.ValueFrom.SecretKeyRef
		if ref.Name != "multi-idp-git" || ref.Key != "token" {
			t.Errorf("secretKeyRef = %s/%s", ref.Name, ref.Key)
		}

		return
	}

	t.Error("no GIT_TOKEN when a git secret is configured")
}

func TestIssuer(t *testing.T) {
	spec := testSpec()
	spec.ACME = map[string]any{
		"email":               "admin@example.com",
		"server":              "https://acme-v02.api.letsencrypt.org/directory",
		"privateKeySecretRef": map[string]any{"name": "letsencrypt-production"},
		"solvers":             []any{map[string]any{"http01": map[string]any{"ingress": map[string]any{"class": "traefik"}}}},
	}

	issuer := spec.issuer()

	// cert-manager.io/issuer resolves in the Ingress's own namespace, which is
	// the entire reason this object exists rather than referencing the one the
	// cluster already has in cattle-system.
	if issuer.GetKind() != "Issuer" || issuer.GetNamespace() != spec.Namespace {
		t.Errorf("kind/namespace = %s/%s", issuer.GetKind(), issuer.GetNamespace())
	}

	acme, _, err := unstructured.NestedMap(issuer.Object, "spec", "acme")
	if err != nil {
		t.Fatal(err)
	}

	if acme["email"] != "admin@example.com" || acme["server"] != "https://acme-v02.api.letsencrypt.org/directory" {
		t.Errorf("acme = %v", acme)
	}

	// The source Issuer's secret lives in its own namespace and does not exist in
	// ours; cert-manager creates this one and registers a fresh account.
	ref, _, _ := unstructured.NestedMap(issuer.Object, "spec", "acme", "privateKeySecretRef")
	if ref["name"] != IssuerAccountSecret {
		t.Errorf("privateKeySecretRef = %v, want %q", ref, IssuerAccountSecret)
	}

	// Shared by every environment in the namespace, like remuda-config, so a
	// delete sweep must not be able to claim it.
	if _, found, _ := unstructured.NestedMap(issuer.Object, "metadata", "labels"); found {
		t.Error("the shared Issuer carries environment labels")
	}
}

func TestDesiredObjectsAreOrdered(t *testing.T) {
	spec := testSpec()
	spec.ACME = map[string]any{"email": "a@b.c"}
	spec.IssuerKind = "Issuer"

	objects := desiredObjects(spec, "pw", "1", 1)

	// Several objects share the environment's name, so key on kind as well.
	at := func(kind, name string) int {
		for i, m := range objects {
			if m.GVK.Kind == kind && m.Name == name {
				return i
			}
		}

		return -1
	}

	for _, c := range []struct {
		firstKind, firstName, thenKind, thenName string
	}{
		{"Secret", "multi-idp-bootstrap", "Deployment", "multi-idp"},
		{"PersistentVolumeClaim", "multi-idp-ui", "Job", "multi-idp-build-1"},
		{"PersistentVolumeClaim", "multi-idp-ui", "Deployment", "multi-idp-ui"},
		{"PersistentVolumeClaim", "multi-idp-data", "Deployment", "multi-idp"},
		{"ConfigMap", "multi-idp-ui-nginx", "Deployment", "multi-idp-ui"},
		{"ConfigMap", "multi-idp-k3s-config", "Deployment", "multi-idp"},
		{"Issuer", IssuerName, "Ingress", "multi-idp"},
	} {
		first, then := at(c.firstKind, c.firstName), at(c.thenKind, c.thenName)

		if first < 0 || then < 0 {
			t.Errorf("missing %s %s (%d) or %s %s (%d)", c.firstKind, c.firstName, first, c.thenKind, c.thenName, then)

			continue
		}

		if first > then {
			t.Errorf("%s %s comes after %s %s, which references it", c.firstKind, c.firstName, c.thenKind, c.thenName)
		}
	}
}

func TestDesiredObjectsIssuerIsConditional(t *testing.T) {
	hasIssuer := func(spec *renderSpec) bool {
		for _, m := range desiredObjects(spec, "pw", "1", 1) {
			if m.GVK.Kind == "Issuer" {
				return true
			}
		}

		return false
	}

	// Not ours to create, and creating one would be a cluster-scoped mutation.
	withClusterIssuer := testSpec()
	withClusterIssuer.IssuerKind = "ClusterIssuer"

	if hasIssuer(withClusterIssuer) {
		t.Error("an Issuer was rendered for a cluster that already has a ClusterIssuer")
	}

	none := testSpec()
	none.ClusterIssuer = ""

	if hasIssuer(none) {
		t.Error("an Issuer was rendered for a cluster that offers nothing")
	}

	mirrored := testSpec()
	mirrored.ACME = map[string]any{"email": "a@b.c"}

	if !hasIssuer(mirrored) {
		t.Error("no Issuer was rendered for the mirrored path")
	}
}

func TestDesiredObjectsCarryNoOwnerReferenceWhenThereIsNoOwner(t *testing.T) {
	// An owner reference is resolved by UID on the cluster it is written to, so
	// one carried to a cluster where the Environment does not exist names an
	// object that is not there -- and the collector deletes a dependent whose
	// owner is missing, taking the environment down seconds after creating it.
	spec := testSpec()
	spec.OwnerRef = metav1.OwnerReference{}

	for _, m := range desiredObjects(spec, "pw", "1", 1) {
		raw, err := json.Marshal(m.Object)
		if err != nil {
			t.Fatal(err)
		}

		if strings.Contains(string(raw), "ownerReferences") {
			t.Errorf("%s %s carries an owner reference", m.GVK.Kind, m.Name)
		}
	}
}

func TestDesiredObjectsAreDeterministic(t *testing.T) {
	// A delivery backend that upserts rewrites whatever it is handed, so anything
	// varying between two renders of one spec is rewritten downstream on every
	// pass. This is what catches a time.Now() or a rand.Read() creeping back into
	// the render path.
	first, err := json.Marshal(desiredObjects(testSpec(), "pw", "1", 1))
	if err != nil {
		t.Fatal(err)
	}

	second, err := json.Marshal(desiredObjects(testSpec(), "pw", "1", 1))
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(first, second) {
		t.Error("two renders of the same spec differ")
	}
}

func TestDesiredObjectsHonourTheReplicaCount(t *testing.T) {
	// An environment created stopped must never briefly start a backend it is
	// about to scale away -- on this workload that means pulling a Rancher image
	// and starting a nested k3s for nothing.
	for _, replicas := range []int32{0, 1} {
		for _, m := range desiredObjects(testSpec(), "pw", "1", replicas) {
			deployment, ok := m.Object.(*appsv1.Deployment)
			if !ok {
				continue
			}

			if deployment.Spec.Replicas == nil || *deployment.Spec.Replicas != replicas {
				t.Errorf("%s has %v replicas, want %d", m.Name, deployment.Spec.Replicas, replicas)
			}
		}
	}
}

func TestThePasswordAppearsOnlyInTheBootstrapSecret(t *testing.T) {
	// The password belongs in exactly one object. Anything that serialises the
	// whole set -- a Fleet Bundle, a `kubectl get -o yaml` -- exposes every other
	// one to a wider audience than the Secret has.
	for _, m := range desiredObjects(testSpec(), "hunter2", "1", 1) {
		raw, err := json.Marshal(m.Object)
		if err != nil {
			t.Fatal(err)
		}

		if strings.Contains(string(raw), "hunter2") && m.Name != "multi-idp-bootstrap" {
			t.Errorf("%s %s carries the bootstrap password", m.GVK.Kind, m.Name)
		}
	}
}

func TestBackendImageForBranch(t *testing.T) {
	// The main line publishes `head`, not `vX.Y-head` -- only branched lines get
	// the versioned alias. Which minor that is moves every release, so it is
	// decided against the host's own version rather than hardcoded.
	cases := []struct {
		branch, host, want string
	}{
		{"master", "v2.13.0", DefaultBackendImage},
		{"task/17295-multi-idp", "v2.13.0", DefaultBackendImage},
		{"release-2.11", "v2.13.0", "rancher/rancher:v2.11-head"},
		// At or ahead of the host's line, so it is the main line.
		{"release-2.13", "v2.13.0", DefaultBackendImage},
		{"release-2.14", "v2.13.0", DefaultBackendImage},
		// 2.9 must sort below 2.10, which a string compare gets backwards.
		{"release-2.9", "v2.10.1", "rancher/rancher:v2.9-head"},
		// Nothing to compare against: assume the main line rather than invent a tag.
		{"release-2.11", "", "rancher/rancher:v2.11-head"},
	}

	for _, c := range cases {
		if got := BackendImageForBranch(c.branch, c.host); got != c.want {
			t.Errorf("BackendImageForBranch(%q, %q) = %q, want %q", c.branch, c.host, got, c.want)
		}
	}
}

func TestClusterDNSFor(t *testing.T) {
	// k3s puts its DNS service at the tenth address of the service range, and
	// the nested cluster cannot resolve anything if this disagrees with it.
	if got := ClusterDNSFor("10.45.0.0/16"); got != "10.45.0.10" {
		t.Errorf("got %q, want 10.45.0.10", got)
	}

	if got := ClusterDNSFor("172.31.0.0/16"); got != "172.31.0.10" {
		t.Errorf("got %q, want 172.31.0.10", got)
	}
}

func TestIssuerAnnotationsNeedsKindForNamespaced(t *testing.T) {
	// A namespaced Issuer resolves in the Ingress's own namespace and needs both
	// keys; a ClusterIssuer is unambiguous and needs neither.
	got := IssuerAnnotations("remuda-le", "Issuer")
	if got["cert-manager.io/issuer"] != "remuda-le" || got["cert-manager.io/issuer-kind"] != "Issuer" {
		t.Errorf("namespaced issuer: got %v", got)
	}

	got = IssuerAnnotations("letsencrypt", "ClusterIssuer")
	if got["cert-manager.io/cluster-issuer"] != "letsencrypt" {
		t.Errorf("cluster issuer: got %v", got)
	}

	// Absent kind means ClusterIssuer, so environments recorded before the
	// mirrored path existed keep producing what they always produced.
	got = IssuerAnnotations("letsencrypt", "")
	if got["cert-manager.io/cluster-issuer"] != "letsencrypt" {
		t.Errorf("absent kind: got %v", got)
	}

	if IssuerAnnotations("", "Issuer") != nil {
		t.Error("no issuer name should annotate nothing")
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}

	return false
}
