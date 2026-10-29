package main

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// A Go port of the extension's utils/manifests.ts. The two must render the same
// objects: an environment created through the UI and one created with `kubectl
// apply` are the same environment, and the reason each field is what it is is
// documented there rather than repeated here.
const (
	RoleBackend = "backend"
	RoleUI      = "ui"
	RoleBuild   = "build"

	// Path the built bundle is served under, baked into its asset URLs at build
	// time via RESOURCE_BASE.
	UIBundlePath = "ui-bundle"

	BuildImage          = "node:24"
	ServeImage          = "nginx:alpine"
	DefaultBackendImage = "rancher/rancher:head"

	// The Issuer Remuda mirrors into its own namespace when the cluster has no
	// ClusterIssuer, and where that Issuer keeps its ACME account key.
	IssuerName          = "remuda-le"
	IssuerAccountSecret = "remuda-le-account"

	K3sConfigDir  = "/etc/rancher/k3s"
	K3sConfigPath = K3sConfigDir + "/config.yaml"
	NginxConfPath = "/etc/nginx/conf.d/default.conf"

	// Where the proxy config goes instead: the image renders templates into
	// conf.d at start, filling in the pod's resolver. See uiProxyConfig.
	NginxTemplatePath = "/etc/nginx/templates/default.conf.template"

	// What rancher/rancher reads to decide whether it is Prime. See
	// EnvironmentSpec.Prime.
	PrimeEnvVar   = "RANCHER_VERSION_TYPE"
	PrimeEnvValue = "prime"
)

// inotify limits to raise on the node before a backend starts. Counted per-uid
// across the whole host and not namespaced, so every nested k3s on a node draws
// from one budget -- which is what made exhaustion look intermittent.
var inotifyLimits = [][2]string{
	{"fs.inotify.max_user_instances", "8192"},
	{"fs.inotify.max_user_watches", "524288"},
}

var certManagerIssuers = schema.GroupVersionResource{
	Group:    "cert-manager.io",
	Version:  "v1",
	Resource: "issuers",
}

var traefikServersTransports = schema.GroupVersionResource{
	Group:    "traefik.io",
	Version:  "v1alpha1",
	Resource: "serverstransports",
}

// dynamicResources maps the kinds rendered as unstructured to the resource that
// creates them. Both share one Go type, so the kind is the only thing that
// distinguishes them.
var dynamicResources = map[schema.GroupVersionKind]schema.GroupVersionResource{
	gvk("cert-manager.io", "v1", "Issuer"):            certManagerIssuers,
	gvk("traefik.io", "v1alpha1", "ServersTransport"): traefikServersTransports,
}

// renderSpec is everything the manifests need, after resolution. It is the Go
// equivalent of the extension's RemudaSpec -- an Environment plus whatever
// discovery filled in.
type renderSpec struct {
	Name      string
	Namespace string
	Owner     string

	Repo          string
	Branch        string
	GitSecretName string

	BackendImage string
	Hostname     string
	EntryPort    int

	IngressClass  string
	StorageClass  string
	ClusterIssuer string
	IssuerKind    string
	ACME          map[string]any

	// Per-role overrides for StorageClass. Empty means "use StorageClass",
	// which is what every environment written before these existed does.
	DataStorageClass  string
	UIStorageClass    string
	CacheStorageClass string

	DataSizeGB  int
	UISizeGB    int
	CacheSizeGB int

	NestedPodCIDR     string
	NestedServiceCIDR string

	// BackendURL, when set, is an existing Rancher this environment fronts
	// instead of running its own: scheme and host only, normalised by
	// resolve(). Everything backend-shaped is left out of the render.
	BackendURL string
	Prime      bool

	// Set on every object, so deleting the Environment collects all of them.
	OwnerRef metav1.OwnerReference
}

func (s *renderSpec) labels(role string) map[string]string {
	out := map[string]string{
		LabelManaged: "true",
		LabelName:    s.Name,
	}

	if s.Owner != "" {
		out[LabelOwner] = s.Owner
	}

	if role != "" {
		out[LabelRole] = role
	}

	return out
}

func (s *renderSpec) meta(name, role string) metav1.ObjectMeta {
	out := metav1.ObjectMeta{
		Name:      name,
		Namespace: s.Namespace,
		Labels:    s.labels(role),
	}

	// Zero whenever these objects are bound for a cluster other than the one the
	// Environment lives on. An owner reference is resolved by UID *on the
	// cluster it is written to*, so carrying this downstream would name an object
	// that does not exist there -- and the collector deletes a dependent whose
	// owner is missing, which would take the whole environment down seconds after
	// creating it.
	if s.OwnerRef.UID != "" {
		out.OwnerReferences = []metav1.OwnerReference{s.OwnerRef}
	}

	return out
}

// browserOrigin carries the entry port when there is one. Shared by both
// browser-facing URLs so they cannot disagree: the environment's backend and its
// bundle are the same origin by design, and that sameness is what keeps the
// environment free of CORS.
func (s *renderSpec) browserOrigin() string {
	if s.EntryPort != 0 {
		return fmt.Sprintf("https://%s:%d", s.Hostname, s.EntryPort)
	}

	return "https://" + s.Hostname
}

func (s *renderSpec) resourceBase() string { return s.browserOrigin() + "/" + UIBundlePath }

// EnvironmentURL is where the environment answers once it is up.
func (s *renderSpec) EnvironmentURL() string { return s.browserOrigin() }

// SharedBundleURL is the bundle's index addressed the way a Rancher outside this
// cluster has to reach it -- public rather than in-cluster, because that Rancher
// fetches the index server-side from wherever it happens to be running.
func (s *renderSpec) SharedBundleURL() string { return s.resourceBase() + "/index.html" }

// dashboardIndexURL is pod-facing: Rancher fetches ui-dashboard-index
// server-side, so this stays in-cluster over plain HTTP and never depends on
// hairpinning through the ingress.
func (s *renderSpec) dashboardIndexURL() string {
	return fmt.Sprintf("http://%s-ui.%s.svc.cluster.local/%s/index.html", s.Name, s.Namespace, UIBundlePath)
}

// ownsBackend is false for an environment pointed at a Rancher that already
// exists, which brings only the UI and none of what a backend needs.
func (s *renderSpec) ownsBackend() bool { return s.BackendURL == "" }

// workloadName is the Deployment whose readiness says whether the environment
// is up: the backend when there is one, the bundle server when that is all
// there is.
func (s *renderSpec) workloadName() string {
	if s.ownsBackend() {
		return s.Name
	}

	return s.uiName()
}

// NormalizeBackendURL reduces an external backend to the origin it is proxied
// to, refusing anything that is not one.
//
// A path is refused rather than dropped: Rancher answers at the root of its
// host, and a URL copied from a browser tab -- `.../dashboard/home` -- would
// otherwise proxy somewhere that looks right and is not.
func NormalizeBackendURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("spec.backendUrl: %w", err)
	}

	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("spec.backendUrl must start with https:// (got %q)", raw)
	}

	if u.Host == "" {
		return "", fmt.Errorf("spec.backendUrl names no host (got %q)", raw)
	}

	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.User != nil {
		return "", fmt.Errorf("spec.backendUrl must be the Rancher's origin alone, e.g. https://rancher.example.com (got %q)", raw)
	}

	return u.Scheme + "://" + u.Host, nil
}

func (s *renderSpec) k3sConfigName() string       { return s.Name + "-k3s-config" }
func (s *renderSpec) uiNginxConfigName() string   { return s.Name + "-ui-nginx" }
func (s *renderSpec) bootstrapSecretName() string { return s.Name + "-bootstrap" }
func (s *renderSpec) uiName() string              { return s.Name + "-ui" }

// ClusterDNSFor is the tenth address of the service range, which is where k3s
// puts its DNS service.
func ClusterDNSFor(serviceCIDR string) string {
	octets := strings.Split(strings.SplitN(serviceCIDR, "/", 2)[0], ".")
	if len(octets) != 4 {
		return ""
	}

	return strings.Join([]string{octets[0], octets[1], octets[2], "10"}, ".")
}

var releaseBranch = regexp.MustCompile(`release-(\d+)\.(\d+)`)

// BackendImageForBranch picks the Rancher server image for a dashboard branch.
//
// The main line publishes `head`, not `vX.Y-head`; only older, branched lines
// get the versioned alias. Which minor that is moves every release, so it is
// compared against the host Rancher's own version rather than hardcoded: a
// branch at or ahead of the host's line is the main line, so it takes `head`.
func BackendImageForBranch(branch, hostVersion string) string {
	match := releaseBranch.FindStringSubmatch(branch)
	if match == nil {
		return DefaultBackendImage
	}

	branchMinor, ok := minorOf(match[1] + "." + match[2])
	hostMinor, hostOK := minorOf(hostVersion)

	if ok && hostOK && branchMinor >= hostMinor {
		return DefaultBackendImage
	}

	return fmt.Sprintf("rancher/rancher:v%s.%s-head", match[1], match[2])
}

// minorOf reads a version as a single comparable number, so 2.10 sorts after
// 2.9 rather than before it the way a string compare would have it.
func minorOf(version string) (int, bool) {
	match := regexp.MustCompile(`(\d+)\.(\d+)`).FindStringSubmatch(version)
	if match == nil {
		return 0, false
	}

	major, err := strconv.Atoi(match[1])
	if err != nil {
		return 0, false
	}

	minor, err := strconv.Atoi(match[2])
	if err != nil {
		return 0, false
	}

	return major*1000 + minor, true
}

func (s *renderSpec) bootstrapSecret(password string) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: s.meta(s.bootstrapSecretName(), ""),
		Type:       corev1.SecretTypeOpaque,
		StringData: map[string]string{"password": password},
	}
}

func (s *renderSpec) pvc(suffix string, sizeGB int, role string) *corev1.PersistentVolumeClaim {
	claim := &corev1.PersistentVolumeClaim{
		ObjectMeta: s.meta(s.Name+"-"+suffix, role),
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(fmt.Sprintf("%dGi", sizeGB)),
				},
			},
		},
	}

	// Omitted entirely when the cluster has no default class, rather than sent
	// as an explicit empty string the API server would take literally.
	if class := s.storageClassFor(role); class != "" {
		claim.Spec.StorageClassName = &class
	}

	return claim
}

// storageClassFor picks the class for one volume, falling back to the
// environment-wide StorageClass.
//
// The three volumes are not equally valuable and do not deserve the same
// storage. `data` is the nested k3s's etcd and is the only one whose loss is
// unrecoverable; `ui` holds a bundle rebuilt from git in minutes, and `cache`
// is a yarn cache whose loss costs nothing. Putting `data` on a network-attached
// class while the other two stay on something node-local is the point of this.
//
// Splitting the classes can split scheduling: with WaitForFirstConsumer, three
// volumes on one node-local class pin every pod to one node, and moving `data`
// alone to a network-attached class lets the backend land away from the build.
// That is fine -- they talk over Services -- and `ui`, which the ui Deployment
// and the build Job both mount, still shares one class and so still co-locates.
func (s *renderSpec) storageClassFor(role string) string {
	var override string

	switch role {
	case RoleBackend:
		override = s.DataStorageClass
	case RoleUI:
		override = s.UIStorageClass
	case RoleBuild:
		override = s.CacheStorageClass
	}

	if override != "" {
		return override
	}

	return s.StorageClass
}

// k3sConfig is the config file for the k3s the backend image starts inside its
// own pod.
//
// Rancher launches it as a plain subprocess, so the k3s binary does its own CLI
// parsing and picks up /etc/rancher/k3s/config.yaml. Neither CIDR is passed on
// that command line, so the file is free to set them -- and it is the only lever
// available, because the image entrypoint sends trailing args to `rancher`, not
// to `k3s`.
//
// disable-network-policy is what lets an environment start a second time. The
// nested node is named local-node for life but takes the pod's IP, and a pod gets
// a new IP on every start, while the Node object in the etcd on the data volume
// still lists the last one. kube-router's network policy controller looks for a
// local interface carrying that stored IP, finds none, and k3s shuts down:
//
//	failed to start networking: unable to initialize network policy controller:
//	error getting node subnet: failed to find interface with specified node ip
//
// Every start after the first, forever -- Rancher only reports the apiserver
// going away, as `[FATAL] ... unexpected EOF`. Measured on k3s v1.36.4+k3s1,
// after k3s-io/k3s#12891 was meant to fix it: that waits for a fresh Ready
// heartbeat, but with --cloud-provider=external the addresses are written by the
// embedded cloud controller rather than by the kubelet, and the heartbeat can
// land first. Upstream treats a changing node IP as unsupported (#12639, #12844)
// and names this setting as the workaround. Nothing here needs NetworkPolicy
// enforced; a dev Rancher is not a multi-tenant cluster.
func (s *renderSpec) k3sConfig() *corev1.ConfigMap {
	config := strings.Join([]string{
		"cluster-cidr:",
		fmt.Sprintf("  - %q", s.NestedPodCIDR),
		"service-cidr:",
		fmt.Sprintf("  - %q", s.NestedServiceCIDR),
		"cluster-dns:",
		fmt.Sprintf("  - %q", ClusterDNSFor(s.NestedServiceCIDR)),
		"disable-network-policy: true",
		"",
	}, "\n")

	return &corev1.ConfigMap{
		ObjectMeta: s.meta(s.k3sConfigName(), RoleBackend),
		Data:       map[string]string{"config.yaml": config},
	}
}

// uiNginxConfig replaces the image's stock default.conf, and exists for one
// directive.
//
// The environment's own backend is same-origin with the bundle and needs
// nothing, but a Rancher elsewhere pointed at this index serves index.html from
// its own origin while the browser still fetches assets from here, because
// RESOURCE_BASE is absolute and fixed at build time. @font-face is the one part
// of that which is CORS-checked, and without the header the dashboard loads but
// falls back to system fonts -- a poor result for a tool meant for looking at UI
// changes. releases.rancher.com serves the *-dev bundles with exactly this
// header.
func (s *renderSpec) uiNginxConfig() *corev1.ConfigMap {
	if !s.ownsBackend() {
		return &corev1.ConfigMap{
			ObjectMeta: s.meta(s.uiNginxConfigName(), RoleUI),
			Data:       map[string]string{"default.conf": s.uiProxyConfig()},
		}
	}

	config := strings.Join([]string{
		"server {",
		"    listen 80;",
		"    server_name _;",
		"    root /usr/share/nginx/html;",
		"    index index.html;",
		"",
		"    # `always` so the header is on error responses too -- a 404 for a font",
		"    # should surface as a 404 in the console, not as an opaque CORS failure.",
		`    add_header Access-Control-Allow-Origin "*" always;`,
		"",
		"    location / {",
		"        try_files $uri $uri/ =404;",
		"    }",
		"}",
		"",
	}, "\n")

	return &corev1.ConfigMap{
		ObjectMeta: s.meta(s.uiNginxConfigName(), RoleUI),
		Data:       map[string]string{"default.conf": config},
	}
}

// uiProxyConfig serves the branch's UI in front of a Rancher that already
// exists, which is what `API=<url> yarn dev` does from a laptop.
//
// Everything that is not the UI is proxied rather than listed. The dev server
// enumerates /v1, /v3, /k8s, /meta and friends, but a path it forgets -- a new
// /v1-* auth callback, say -- fails there as a 404 from webpack, and fails here
// as a blank page with nothing to say why. So the UI claims its two paths and
// the backend gets the rest.
//
// The headers are the dev server's (shell/vue-config-helper.js), for the same
// reasons:
//
//   - Host is the backend's, so its ingress routes the request and its
//     certificate matches the SNI.
//   - X-API-Host is ours, so the links Rancher writes into API responses point
//     back here rather than sending the browser to the backend directly.
//   - Origin is rewritten to the backend's own, but only when the browser sent
//     one. Rancher refuses a websocket whose Origin is not its own host, and
//     every watch the UI opens is a websocket.
//
// Upstream TLS is not verified, matching the dev server: a Rancher with a
// self-signed certificate is a normal thing to point this at.
//
// The backend is resolved per request rather than once at start. A literal
// proxy_pass host is looked up when nginx loads its config, and a lookup that
// fails stops nginx starting at all -- so a backend that is down, or an ROA
// instance already torn down, would take the bundle down with it. Resolving
// through a variable needs a resolver address, which nginx will not read from
// resolv.conf; the image's entrypoint does, when NGINX_ENTRYPOINT_LOCAL_RESOLVERS
// is set, and substitutes it into this template.
func (s *renderSpec) uiProxyConfig() string {
	upstream, _ := url.Parse(s.BackendURL)

	return strings.Join([]string{
		"# Upgrade only when the client asked to; a plain request must not carry",
		"# `Connection: upgrade` to the backend.",
		"map $http_upgrade $remuda_connection {",
		"    default upgrade;",
		"    ''      close;",
		"}",
		"",
		"# Rewritten only when present, so a GET with no Origin does not grow one.",
		"map $http_origin $remuda_origin {",
		"    default " + s.BackendURL + ";",
		"    ''      '';",
		"}",
		"",
		"server {",
		"    listen 80;",
		"    server_name _;",
		"    root /usr/share/nginx/html;",
		"",
		"    # Relative Location headers: TLS ends at the ingress, so nginx sees",
		"    # plain HTTP and would otherwise redirect the browser to http://.",
		"    absolute_redirect off;",
		"",
		"    # Chart uploads and large YAML edits go through here.",
		"    client_max_body_size 0;",
		"",
		"    resolver ${NGINX_LOCAL_RESOLVERS} valid=30s;",
		"    set $remuda_backend " + s.BackendURL + ";",
		"",
		"    location /" + UIBundlePath + "/ {",
		"        # Only on the bundle. The API answers for itself, and a wildcard",
		"        # CORS header on it would be ours to explain rather than Rancher's.",
		`        add_header Access-Control-Allow-Origin "*" always;`,
		"        try_files $uri =404;",
		"    }",
		"",
		"    location = / {",
		"        return 302 /dashboard/;",
		"    }",
		"",
		"    # The single-page app: every route under /dashboard/ is index.html, which",
		"    # is what Rancher does when ui-dashboard-index points at a bundle.",
		"    location /dashboard/ {",
		`        add_header Cache-Control "no-cache" always;`,
		"        try_files /" + UIBundlePath + "/index.html =404;",
		"    }",
		"",
		"    location / {",
		"        proxy_pass $remuda_backend;",
		"        proxy_http_version 1.1;",
		"        proxy_set_header Host " + upstream.Host + ";",
		"        proxy_set_header X-API-Host $host;",
		"        proxy_set_header X-Forwarded-Proto https;",
		"        proxy_set_header Origin $remuda_origin;",
		"        proxy_set_header Upgrade $http_upgrade;",
		"        proxy_set_header Connection $remuda_connection;",
		"        proxy_ssl_server_name on;",
		"        proxy_ssl_name " + upstream.Hostname() + ";",
		"        proxy_ssl_verify off;",
		"        # Absolute redirects from the backend stay on this host.",
		"        proxy_redirect " + s.BackendURL + "/ /;",
		"        # Watches are long-lived websockets and streams; buffering would",
		"        # hold events back and the default 60s timeout would cut them.",
		"        proxy_buffering off;",
		"        proxy_read_timeout 1h;",
		"        proxy_send_timeout 1h;",
		"    }",
		"}",
		"",
	}, "\n")
}

// inotifyInitContainer raises the node's inotify limits before the backend
// starts. These are not namespaced sysctls, so securityContext.sysctls cannot
// set them and each environment has to widen the shared host budget itself.
//
// Best-effort on purpose: a node that already has generous limits, or one with a
// read-only /proc/sys, should not stop an environment from starting.
func (s *renderSpec) inotifyInitContainer() corev1.Container {
	var writes, reads []string

	for _, limit := range inotifyLimits {
		path := "/proc/sys/" + strings.ReplaceAll(limit[0], ".", "/")
		writes = append(writes, fmt.Sprintf("echo %s > %s 2>/dev/null || echo \"could not raise %s\"", limit[1], path, limit[0]))
		reads = append(reads, fmt.Sprintf("echo \"%s=$(cat %s)\"", limit[0], path))
	}

	script := strings.Join(writes, "; ") + "; " + strings.Join(reads, "; ")

	return corev1.Container{
		Name: "raise-inotify-limits",
		// The backend image, so this costs no additional pull.
		Image:           s.BackendImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Command:         []string{"sh", "-c", script},
		SecurityContext: &corev1.SecurityContext{Privileged: boolPtr(true)},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("10m"),
				corev1.ResourceMemory: resource.MustParse("16Mi"),
			},
		},
	}
}

func (s *renderSpec) backendEnv() []corev1.EnvVar {
	env := []corev1.EnvVar{
		{Name: "CATTLE_UI_OFFLINE_PREFERRED", Value: "false"},
		{Name: "CATTLE_UI_DASHBOARD_INDEX", Value: s.dashboardIndexURL()},
		{
			Name: "CATTLE_BOOTSTRAP_PASSWORD",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: s.bootstrapSecretName()},
					Key:                  "password",
				},
			},
		},
	}

	// Same image either way: /rancherversion reports RancherPrime from this
	// variable alone, and the backend's Prime-only gates read it too.
	if s.Prime {
		env = append(env, corev1.EnvVar{Name: PrimeEnvVar, Value: PrimeEnvValue})
	}

	return env
}

// WebhookWatchdogScript removes rancher-webhook's admission configuration
// from the nested cluster whenever the webhook has nothing serving it.
//
// Without this, an environment whose webhook went away -- evicted under disk
// pressure on 2026-10-14 -- never starts again. The configuration outlives the
// pod in the nested etcd with failurePolicy Fail, so the namespace Rancher
// creates during startup is refused:
//
//	[FATAL] failed calling webhook "rancher.cattle.io.namespaces.create-non-kubesystem":
//	no endpoints available for service "rancher-webhook"
//
// Rancher is what would redeploy the webhook, and it dies about 25 seconds in,
// taking the nested k3s with it. Every container restart repeats that, so the
// pod crashloops for good.
//
// Removing the configuration breaks the loop: Rancher starts, reinstalls the
// webhook chart, and the webhook registers its configuration again when it
// comes up. The cost is a few seconds without admission checks on a dev
// instance, which is a trade worth making. On a healthy start the webhook is
// briefly unready too, and removing the configuration then is just as
// harmless.
func WebhookWatchdogScript() string {
	return strings.Join([]string{
		"export KUBECONFIG=" + K3sConfigDir + "/k3s.yaml",
		"while true; do",
		"  if [ -f \"$KUBECONFIG\" ] && kubectl get --raw /readyz >/dev/null 2>&1; then",
		"    ready=\"$(kubectl -n cattle-system get endpoints rancher-webhook -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)\"",
		"    if [ -z \"$ready\" ]; then",
		"      for kind in validatingwebhookconfiguration mutatingwebhookconfiguration; do",
		"        if kubectl get \"$kind\" rancher.cattle.io >/dev/null 2>&1; then",
		"          kubectl delete \"$kind\" rancher.cattle.io --wait=false >/dev/null 2>&1 &&",
		"            echo \"$(date -u +%FT%TZ) rancher-webhook has no endpoints; removed $kind rancher.cattle.io so Rancher can start\"",
		"        fi",
		"      done",
		"    fi",
		"  fi",
		// Short, because the window is short: the apiserver answers about ten
		// seconds after k3s starts and Rancher gives up about fifteen later.
		"  sleep 3",
		"done",
	}, "\n")
}

// webhookWatchdog runs WebhookWatchdogScript beside Rancher. A sidecar rather
// than anything in the rancher container, because that container is the one
// that keeps dying; this one outlives every restart of it.
func (s *renderSpec) webhookWatchdog() corev1.Container {
	return corev1.Container{
		Name: "webhook-watchdog",
		// The backend image, for its kubectl and so it costs no extra pull.
		Image:           s.BackendImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Command:         []string{"sh", "-c", WebhookWatchdogScript()},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "k3s-etc", MountPath: K3sConfigDir, ReadOnly: true},
		},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("10m"),
				corev1.ResourceMemory: resource.MustParse("32Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU: resource.MustParse("200m"),
				// kubectl here is the k3s multi-call binary, not a slim one.
				corev1.ResourceMemory: resource.MustParse("256Mi"),
			},
		},
	}
}

func (s *renderSpec) backendDeployment(replicas int32) *appsv1.Deployment {
	selector := map[string]string{LabelName: s.Name, LabelRole: RoleBackend}

	return &appsv1.Deployment{
		ObjectMeta: s.meta(s.Name, RoleBackend),
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: selector},
			// The data PVC is RWO, so the old pod must go before the new starts.
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: s.labels(RoleBackend)},
				Spec: corev1.PodSpec{
					// Rancher picks embedded-k3s vs in-cluster mode partly on
					// whether a service account token is mounted. Without this
					// it can try to drive the HOST cluster instead.
					AutomountServiceAccountToken: boolPtr(false),
					// dnsPolicy is deliberately left at the ClusterFirst
					// default: it is what lets this pod resolve the UI Service
					// that CATTLE_UI_DASHBOARD_INDEX points at.
					InitContainers: []corev1.Container{s.inotifyInitContainer()},
					Containers: []corev1.Container{{
						Name:            "rancher",
						Image:           s.BackendImage,
						ImagePullPolicy: corev1.PullAlways,
						Args:            []string{"--no-cacerts", "--http-listen-port=80", "--https-listen-port=443"},
						SecurityContext: &corev1.SecurityContext{Privileged: boolPtr(true)},
						Ports: []corev1.ContainerPort{
							{ContainerPort: 80, Name: "http"},
							{ContainerPort: 443, Name: "https"},
						},
						Env: s.backendEnv(),
						VolumeMounts: []corev1.VolumeMount{
							{Name: "data", MountPath: "/var/lib/rancher"},
							// k3s writes its kubeconfig here, and the watchdog
							// reads it -- so an emptyDir both can see, rather
							// than the container's own filesystem.
							{Name: "k3s-etc", MountPath: K3sConfigDir},
							// subPath so the config file lands inside that
							// directory without shadowing the rest of it.
							{Name: "k3s-config", MountPath: K3sConfigPath, SubPath: "config.yaml"},
						},
						// Without this the pod is Ready the instant the process
						// starts -- seconds, while Rancher needs minutes.
						// Measured: pod start to /dashboard/ answering 200 was
						// 6m06s, with readyReplicas=1 for all of it.
						//
						// Readiness only, deliberately -- NO livenessProbe. A
						// restart takes k3s through an etcd cluster-reset that
						// can sit silent for minutes, and a liveness probe would
						// kill the pod mid-recovery.
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt32(80)},
							},
							InitialDelaySeconds: 30,
							PeriodSeconds:       10,
							TimeoutSeconds:      5,
							// Generous: once serving, a blip should not pull the
							// pod out of the Service and 503 someone mid-session.
							FailureThreshold: 6,
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("1"),
								corev1.ResourceMemory: resource.MustParse("3Gi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("2"),
								corev1.ResourceMemory: resource.MustParse("6Gi"),
							},
						},
					}, s.webhookWatchdog()},
					Volumes: []corev1.Volume{
						{
							Name:         "k3s-etc",
							VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
						},
						{
							Name: "data",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: s.Name + "-data"},
							},
						},
						{
							Name: "k3s-config",
							VolumeSource: corev1.VolumeSource{
								ConfigMap: &corev1.ConfigMapVolumeSource{
									LocalObjectReference: corev1.LocalObjectReference{Name: s.k3sConfigName()},
								},
							},
						},
					},
				},
			},
		},
	}
}

func (s *renderSpec) uiDeployment(replicas int32) *appsv1.Deployment {
	selector := map[string]string{LabelName: s.Name, LabelRole: RoleUI}

	// The proxy config is a template the image renders at start, so it is
	// mounted where the entrypoint looks for templates rather than over
	// default.conf -- which the rendering writes. See uiProxyConfig.
	configPath := NginxConfPath
	var env []corev1.EnvVar

	if !s.ownsBackend() {
		configPath = NginxTemplatePath
		env = []corev1.EnvVar{{Name: "NGINX_ENTRYPOINT_LOCAL_RESOLVERS", Value: "1"}}
	}

	return &appsv1.Deployment{
		ObjectMeta: s.meta(s.uiName(), RoleUI),
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: selector},
			Strategy: appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: s.labels(RoleUI)},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:  "nginx",
						Image: ServeImage,
						Env:   env,
						Ports: []corev1.ContainerPort{{ContainerPort: 80, Name: "http"}},
						// Building into a directory named for the path means
						// /ui-bundle/... resolves straight off nginx's root.
						VolumeMounts: []corev1.VolumeMount{
							{Name: "bundle", MountPath: "/usr/share/nginx/html", ReadOnly: true},
							// subPath so the ConfigMap replaces just
							// default.conf rather than shadowing conf.d.
							{Name: "nginx-config", MountPath: configPath, SubPath: "default.conf", ReadOnly: true},
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("10m"),
								corev1.ResourceMemory: resource.MustParse("32Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("256Mi"),
							},
						},
					}},
					Volumes: []corev1.Volume{
						{
							Name: "bundle",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: s.uiName(),
									ReadOnly:  true,
								},
							},
						},
						{
							Name: "nginx-config",
							VolumeSource: corev1.VolumeSource{
								ConfigMap: &corev1.ConfigMapVolumeSource{
									LocalObjectReference: corev1.LocalObjectReference{Name: s.uiNginxConfigName()},
								},
							},
						},
					},
				},
			},
		},
	}
}

func (s *renderSpec) service(name, role string, ports []corev1.ServicePort) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: s.meta(name, role),
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: map[string]string{LabelName: s.Name, LabelRole: role},
			Ports:    ports,
		},
	}
}

func (s *renderSpec) backendService() *corev1.Service {
	return s.service(s.Name, RoleBackend, []corev1.ServicePort{
		{Name: "http", Port: 80, TargetPort: intstr.FromInt32(80)},
		{Name: "https", Port: 443, TargetPort: intstr.FromInt32(443)},
	})
}

func (s *renderSpec) uiService() *corev1.Service {
	return s.service(s.uiName(), RoleUI, []corev1.ServicePort{
		{Name: "http", Port: 80, TargetPort: intstr.FromInt32(80)},
	})
}

// IssuerAnnotations is the cert-manager annotation for whichever issuer kind was
// discovered.
//
// `cluster-issuer` needs no kind because a ClusterIssuer is cluster-scoped and
// unambiguous. A namespaced Issuer needs both the name and `issuer-kind`, and is
// resolved in the Ingress's own namespace -- which is the whole reason the
// mirrored Issuer has to exist next to the Ingress.
func IssuerAnnotations(name, kind string) map[string]string {
	if name == "" {
		return nil
	}

	// Absent kind means ClusterIssuer, so environments recorded before the
	// mirrored path existed keep producing what they always produced.
	if kind == "Issuer" {
		return map[string]string{
			"cert-manager.io/issuer":      name,
			"cert-manager.io/issuer-kind": "Issuer",
		}
	}

	return map[string]string{"cert-manager.io/cluster-issuer": name}
}

// issuer mirrors whatever ACME configuration the cluster already has into this
// namespace.
//
// Only the account key is changed: pointing at the source Issuer's
// privateKeySecretRef would name a Secret in *its* namespace. cert-manager
// registers a fresh account against the same email instead, which is not
// meaningfully rate limited -- certificate issuance is, and that is unchanged.
//
// No environment labels and no owner reference: this is shared by every
// environment in the namespace, so it must not be collected when one is deleted.
func (s *renderSpec) issuer() *unstructured.Unstructured { return s.issuerFrom(s.ACME) }

// issuerFrom takes the ACME spec explicitly, because the hop mirrors the *host*
// cluster's issuer while the environment mirrors its target's -- and sharing one
// field between the two once wrote the host's Issuer onto a cluster that has no
// cert-manager at all.
func (s *renderSpec) issuerFrom(source map[string]any) *unstructured.Unstructured {
	acme := map[string]any{}
	for k, v := range source {
		acme[k] = v
	}

	acme["privateKeySecretRef"] = map[string]any{"name": IssuerAccountSecret}

	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "Issuer",
		"metadata": map[string]any{
			"name":      IssuerName,
			"namespace": s.Namespace,
		},
		"spec": map[string]any{"acme": acme},
	}}
}

func (s *renderSpec) ingress() *networkingv1.Ingress {
	prefix := networkingv1.PathTypePrefix
	backend := func(name string) networkingv1.IngressBackend {
		return networkingv1.IngressBackend{
			Service: &networkingv1.IngressServiceBackend{
				Name: name,
				Port: networkingv1.ServiceBackendPort{Number: 80},
			},
		}
	}

	meta := s.meta(s.Name, "")
	meta.Annotations = IssuerAnnotations(s.ClusterIssuer, s.IssuerKind)

	// The bundle path must precede '/', which catches everything else. With an
	// external backend nginx is the whole environment -- it proxies the rest
	// itself -- so one path is all there is.
	paths := []networkingv1.HTTPIngressPath{
		{Path: "/" + UIBundlePath, PathType: &prefix, Backend: backend(s.uiName())},
		{Path: "/", PathType: &prefix, Backend: backend(s.Name)},
	}

	if !s.ownsBackend() {
		paths = []networkingv1.HTTPIngressPath{
			{Path: "/", PathType: &prefix, Backend: backend(s.uiName())},
		}
	}

	ing := &networkingv1.Ingress{
		ObjectMeta: meta,
		Spec: networkingv1.IngressSpec{
			IngressClassName: &s.IngressClass,
			Rules: []networkingv1.IngressRule{{
				Host: s.Hostname,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{Paths: paths},
				},
			}},
		},
	}

	// Rancher's own ingress terminates TLS here and talks plain HTTP to port 80,
	// which is why the backend runs with --no-cacerts.
	if s.ClusterIssuer != "" {
		ing.Spec.TLS = []networkingv1.IngressTLS{{
			Hosts:      []string{s.Hostname},
			SecretName: s.Name + "-tls",
		}}
	}

	return ing
}

// BuildScript clones the branch and builds it with the asset URLs baked in.
//
// The expansions here are the build container's shell, not Go formatting -- they
// must reach the script verbatim.
func (s *renderSpec) BuildScript() string {
	return strings.Join([]string{
		"set -euo pipefail",
		`if [ -n "${GIT_TOKEN:-}" ]; then`,
		`  CLONE_URL="$(echo "$REPO" | sed -E "s#https://#https://x-access-token:${GIT_TOKEN}@#")"`,
		"else",
		`  CLONE_URL="$REPO"`,
		"fi",
		"rm -rf /src && mkdir -p /src",
		`git clone --depth 1 --branch "$BRANCH" "$CLONE_URL" /src`,
		"cd /src",
		"git rev-parse --short HEAD > /out/COMMIT.txt",
		"yarn install --frozen-lockfile",
		// build-hosted derives OUTPUT_DIR from the branch name, and branches
		// like task/17295-multi-idp contain a slash. Call the build directly so
		// the served path is predictable. DASHBOARD_VERSION feeds the About
		// page, which scripts/version would otherwise leave empty here.
		`COMMIT="$(cat /out/COMMIT.txt)" VERSION="$BRANCH" \`,
		fmt.Sprintf(`  DASHBOARD_VERSION="$BRANCH $(cat /out/COMMIT.txt)" OUTPUT_DIR="dist/%s" \`, UIBundlePath),
		fmt.Sprintf(`  ROUTER_BASE="/dashboard/" RESOURCE_BASE="%s" \`, s.resourceBase()),
		"  yarn run build",
		// Stage the swap so nginx never serves a half-written bundle.
		fmt.Sprintf(`rm -rf "/out/%s.tmp"`, UIBundlePath),
		fmt.Sprintf(`cp -r "dist/%s" "/out/%s.tmp"`, UIBundlePath, UIBundlePath),
		fmt.Sprintf(`rm -rf "/out/%s"`, UIBundlePath),
		fmt.Sprintf(`mv "/out/%s.tmp" "/out/%s"`, UIBundlePath, UIBundlePath),
		`echo "build complete"`,
	}, "\n")
}

// buildJobName is the Job a build id renders to, which is also how a superseded
// build is told apart from the current one.
func (s *renderSpec) buildJobName(buildID string) string {
	return fmt.Sprintf("%s-build-%s", s.Name, buildID)
}

func (s *renderSpec) buildJob(buildID string) *batchv1.Job {
	env := []corev1.EnvVar{
		{Name: "REPO", Value: s.Repo},
		{Name: "BRANCH", Value: s.Branch},
		// Belt and braces: dashboard's own build script sets this inline, which
		// wins over an inherited value. It only takes effect on a fork that has
		// dropped it -- the build OOMs below a 2Gi heap.
		{Name: "NODE_OPTIONS", Value: "--max_old_space_size=4096"},
		{Name: "YARN_CACHE_FOLDER", Value: "/cache/yarn"},
	}

	if s.GitSecretName != "" {
		env = append(env, corev1.EnvVar{
			Name: "GIT_TOKEN",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: s.GitSecretName},
					Key:                  "token",
				},
			},
		})
	}

	backoff := int32(1)

	return &batchv1.Job{
		ObjectMeta: s.meta(s.buildJobName(buildID), RoleBuild),
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: s.labels(RoleBuild)},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					// The bundle volume is ReadWriteOnce and the UI pod already
					// holds it, so the build has to land on the same node. Once
					// means once per node, not per pod: on local-path, or any
					// single-node cluster, this always held by accident. On
					// Longhorn across nodes the build waits forever on an
					// attach the UI pod never gives up.
					Affinity: &corev1.Affinity{
						PodAffinity: &corev1.PodAffinity{
							RequiredDuringSchedulingIgnoredDuringExecution: []corev1.PodAffinityTerm{{
								LabelSelector: &metav1.LabelSelector{
									MatchLabels: map[string]string{LabelName: s.Name, LabelRole: RoleUI},
								},
								TopologyKey: "kubernetes.io/hostname",
							}},
						},
					},
					Containers: []corev1.Container{{
						Name:    "build",
						Image:   BuildImage,
						Command: []string{"bash", "-c"},
						Args:    []string{s.BuildScript()},
						Env:     env,
						VolumeMounts: []corev1.VolumeMount{
							{Name: "out", MountPath: "/out"},
							{Name: "cache", MountPath: "/cache"},
						},
						// limits.cpu is load-bearing for memory, not just
						// throughput: node reads the cgroup CPU quota for
						// availableParallelism, and webpack's minifier opens
						// that many worker isolates, each with its own heap.
						// Measured on rancher/dashboard master, node 24: ~4.3Gi
						// at 2 CPU, ~5.3Gi at 4, ~6.0Gi at 8, ~7.4Gi uncapped
						// on a 24-core node. requests.cpu is only what the
						// scheduler reserves, so it stays small: a 2-core node
						// already gives 1 CPU to the Rancher backend, and a
						// 1 CPU request here left builds pending there.
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("4Gi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("4"),
								corev1.ResourceMemory: resource.MustParse("7Gi"),
							},
						},
					}},
					Volumes: []corev1.Volume{
						{
							Name: "out",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: s.uiName()},
							},
						},
						{
							Name: "cache",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: s.Name + "-cache"},
							},
						},
					},
				},
			},
		},
	}
}

func boolPtr(v bool) *bool { return &v }

// gvk is shorthand for the group/version/kind a rendered object needs to carry
// but a typed object out of client-go does not.
func gvk(group, version, kind string) schema.GroupVersionKind {
	return schema.GroupVersionKind{Group: group, Version: version, Kind: kind}
}

// manifest is one rendered object plus the little a delivery backend needs that
// the object itself does not carry.
//
// TypeMeta is empty on every typed object client-go produces. The direct backend
// does not care, because the client it calls already knows the type; anything
// serialising these -- a Fleet Bundle, a `kubectl apply -f` -- very much does.
type manifest struct {
	GVK    schema.GroupVersionKind
	Object runtime.Object
	Name   string

	// Shared objects belong to the namespace rather than to one environment --
	// today only the mirrored Issuer. No owner reference, never swept with an
	// individual environment, and created with "already exists" as success.
	Shared bool
}

// desiredObjects is the whole of an environment, in dependency order.
//
// Pure by design: no clients, no clock, no randomness. Everything that varies
// between two passes over the same environment -- the bootstrap password, the
// build id, the replica count -- arrives as an argument, so the same spec always
// renders byte-identical objects.
//
// That is not tidiness. A delivery backend that upserts rather than creates
// rewrites whatever it is handed, so a clock reading in here would rewrite the
// environment on every pass: a new build Job every thirty seconds, and a
// bootstrap password that no longer matches the Rancher it bootstrapped.
//
// The order is the one provision() used to apply by hand, and it matters in four
// places: the Secret before the backend Deployment that reads it, both
// ConfigMaps before the Deployments that mount them, the ui PVC before both the
// build Job that writes it and the ui Deployment that serves it, and the Issuer
// before the Ingress annotated for it.
func desiredObjects(spec *renderSpec, password, buildID string, replicas int32) []manifest {
	backend := spec.ownsBackend()
	out := []manifest{}

	// An external backend brings its own everything: no password to bootstrap,
	// no nested cluster to configure, no etcd to keep. What is left is the
	// bundle and the nginx that serves it in front of that Rancher.
	if backend {
		out = append(out,
			manifest{GVK: gvk("", "v1", "Secret"), Object: spec.bootstrapSecret(password), Name: spec.bootstrapSecretName()},
			manifest{GVK: gvk("", "v1", "ConfigMap"), Object: spec.k3sConfig(), Name: spec.k3sConfigName()},
		)
	}

	out = append(out, manifest{GVK: gvk("", "v1", "ConfigMap"), Object: spec.uiNginxConfig(), Name: spec.uiNginxConfigName()})

	claims := []*corev1.PersistentVolumeClaim{}
	if backend {
		claims = append(claims, spec.pvc("data", spec.DataSizeGB, RoleBackend))
	}

	claims = append(claims, spec.pvc("ui", spec.UISizeGB, RoleUI), spec.pvc("cache", spec.CacheSizeGB, RoleBuild))

	for _, claim := range claims {
		out = append(out, manifest{
			GVK: gvk("", "v1", "PersistentVolumeClaim"), Object: claim, Name: claim.Name,
		})
	}

	services := []*corev1.Service{spec.uiService()}
	deployments := []*appsv1.Deployment{spec.uiDeployment(replicas)}

	if backend {
		services = append([]*corev1.Service{spec.backendService()}, services...)
		deployments = append([]*appsv1.Deployment{spec.backendDeployment(replicas)}, deployments...)
	}

	for _, svc := range services {
		out = append(out, manifest{GVK: gvk("", "v1", "Service"), Object: svc, Name: svc.Name})
	}

	for _, deployment := range deployments {
		out = append(out, manifest{
			GVK: gvk("apps", "v1", "Deployment"), Object: deployment, Name: deployment.Name,
		})
	}

	// Only for the mirrored path. A ClusterIssuer already exists and is not ours
	// to create.
	if spec.ACME != nil {
		out = append(out, manifest{
			GVK: gvk("cert-manager.io", "v1", "Issuer"), Object: spec.issuer(), Name: IssuerName, Shared: true,
		})
	}

	ingress := spec.ingress()
	out = append(out, manifest{
		GVK: gvk("networking.k8s.io", "v1", "Ingress"), Object: ingress, Name: ingress.Name,
	})

	// No build id means no Job to deliver: a retired build, whose Job ran long
	// ago and can no longer be rewritten. See retireStuckBuild.
	if buildID != "" {
		job := spec.buildJob(buildID)
		out = append(out, manifest{GVK: gvk("batch", "v1", "Job"), Object: job, Name: job.Name})
	}

	return out
}
