package main

import (
	"fmt"
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

	K3sConfigPath = "/etc/rancher/k3s/config.yaml"
	NginxConfPath = "/etc/nginx/conf.d/default.conf"

	// Per-cluster defaults, discovered by the extension and persisted so a
	// scripted create does not have to restate them.
	ConfigMapName = "remuda-config"
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

	DataSizeGB  int
	UISizeGB    int
	CacheSizeGB int

	NestedPodCIDR     string
	NestedServiceCIDR string

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
	if s.StorageClass != "" {
		claim.Spec.StorageClassName = &s.StorageClass
	}

	return claim
}

// k3sConfig is the config file for the k3s the backend image starts inside its
// own pod.
//
// Rancher launches it as a plain subprocess, so the k3s binary does its own CLI
// parsing and picks up /etc/rancher/k3s/config.yaml. Neither CIDR is passed on
// that command line, so the file is free to set them -- and it is the only lever
// available, because the image entrypoint sends trailing args to `rancher`, not
// to `k3s`.
func (s *renderSpec) k3sConfig() *corev1.ConfigMap {
	config := strings.Join([]string{
		"cluster-cidr:",
		fmt.Sprintf("  - %q", s.NestedPodCIDR),
		"service-cidr:",
		fmt.Sprintf("  - %q", s.NestedServiceCIDR),
		"cluster-dns:",
		fmt.Sprintf("  - %q", ClusterDNSFor(s.NestedServiceCIDR)),
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
						Env: []corev1.EnvVar{
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
						},
						VolumeMounts: []corev1.VolumeMount{
							{Name: "data", MountPath: "/var/lib/rancher"},
							// subPath so k3s keeps a writable /etc/rancher/k3s
							// to drop its generated kubeconfig into.
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
					}},
					Volumes: []corev1.Volume{
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
						Ports: []corev1.ContainerPort{{ContainerPort: 80, Name: "http"}},
						// Building into a directory named for the path means
						// /ui-bundle/... resolves straight off nginx's root.
						VolumeMounts: []corev1.VolumeMount{
							{Name: "bundle", MountPath: "/usr/share/nginx/html", ReadOnly: true},
							// subPath so the ConfigMap replaces just
							// default.conf rather than shadowing conf.d.
							{Name: "nginx-config", MountPath: NginxConfPath, SubPath: "default.conf", ReadOnly: true},
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

	ing := &networkingv1.Ingress{
		ObjectMeta: meta,
		Spec: networkingv1.IngressSpec{
			IngressClassName: &s.IngressClass,
			Rules: []networkingv1.IngressRule{{
				Host: s.Hostname,
				IngressRuleValue: networkingv1.IngressRuleValue{
					HTTP: &networkingv1.HTTPIngressRuleValue{
						Paths: []networkingv1.HTTPIngressPath{
							// The bundle path must precede '/', which catches
							// everything else.
							{Path: "/" + UIBundlePath, PathType: &prefix, Backend: backend(s.uiName())},
							{Path: "/", PathType: &prefix, Backend: backend(s.Name)},
						},
					},
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
		ObjectMeta: s.meta(fmt.Sprintf("%s-build-%s", s.Name, buildID), RoleBuild),
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoff,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: s.labels(RoleBuild)},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
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
						// on a 24-core node.
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("1"),
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
	out := []manifest{
		{GVK: gvk("", "v1", "Secret"), Object: spec.bootstrapSecret(password), Name: spec.bootstrapSecretName()},
		{GVK: gvk("", "v1", "ConfigMap"), Object: spec.k3sConfig(), Name: spec.k3sConfigName()},
		{GVK: gvk("", "v1", "ConfigMap"), Object: spec.uiNginxConfig(), Name: spec.uiNginxConfigName()},
	}

	for _, claim := range []*corev1.PersistentVolumeClaim{
		spec.pvc("data", spec.DataSizeGB, RoleBackend),
		spec.pvc("ui", spec.UISizeGB, RoleUI),
		spec.pvc("cache", spec.CacheSizeGB, RoleBuild),
	} {
		out = append(out, manifest{
			GVK: gvk("", "v1", "PersistentVolumeClaim"), Object: claim, Name: claim.Name,
		})
	}

	for _, svc := range []*corev1.Service{spec.backendService(), spec.uiService()} {
		out = append(out, manifest{GVK: gvk("", "v1", "Service"), Object: svc, Name: svc.Name})
	}

	for _, deployment := range []*appsv1.Deployment{
		spec.backendDeployment(replicas),
		spec.uiDeployment(replicas),
	} {
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

	job := spec.buildJob(buildID)
	out = append(out, manifest{GVK: gvk("batch", "v1", "Job"), Object: job, Name: job.Name})

	return out
}
