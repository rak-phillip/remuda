package main

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// Environments are what anyone outside the browser creates, deletes, starts and
// stops -- `kubectl apply`, or a POST through Steve with a Rancher API token.
// The extension writes one of these too, rather than composing a dozen objects
// itself, which is what stops a closed tab leaving half an environment behind.
var environments = schema.GroupVersionResource{
	Group:    "remuda.rancher.io",
	Version:  "v1alpha1",
	Resource: "environments",
}

// Environment is one dev environment as declared, plus what the controller made
// of it.
//
// Hand-written against the CRD schema in the chart rather than generated: the
// controller has no other typed API, and pulling in code-generation to describe
// one resource costs more than keeping these two files honest with each other.
// The schema is the contract -- the API server prunes anything not in it, so a
// field added here and not there silently disappears on write.
type Environment struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   EnvironmentSpec   `json:"spec"`
	Status EnvironmentStatus `json:"status,omitempty"`
}

// EnvironmentSpec is what was asked for.
//
// Only Repo and Branch are required. Every other field is either defaulted by
// the schema or left empty for the controller to resolve from the cluster --
// and setting one pins it, skipping that piece of discovery. That split is the
// whole reason a scripted create can be three lines while the UI still sends a
// fully-specified object.
type EnvironmentSpec struct {
	Repo   string `json:"repo"`
	Branch string `json:"branch"`

	// Start/stop, and the only field that is expected to be edited over an
	// environment's life. The schema defaults it to true, and CRD defaulting is
	// applied on read as well as on write, so this is never meaningfully unset.
	Running bool `json:"running"`

	ClusterID string `json:"clusterId,omitempty"`
	Owner     string `json:"owner,omitempty"`

	BackendImage  string `json:"backendImage,omitempty"`
	Hostname      string `json:"hostname,omitempty"`
	EntryPort     int    `json:"entryPort,omitempty"`
	HopPort       int    `json:"hopPort,omitempty"`
	GitSecretName string `json:"gitSecretName,omitempty"`

	DataSizeGB  int `json:"dataSizeGb,omitempty"`
	UISizeGB    int `json:"uiSizeGb,omitempty"`
	CacheSizeGB int `json:"cacheSizeGb,omitempty"`

	IngressClass  string         `json:"ingressClass,omitempty"`
	StorageClass  string         `json:"storageClass,omitempty"`
	ClusterIssuer string         `json:"clusterIssuer,omitempty"`
	IssuerKind    string         `json:"issuerKind,omitempty"`
	ACME          map[string]any `json:"acme,omitempty"`

	NestedPodCIDR     string `json:"nestedPodCidr,omitempty"`
	NestedServiceCIDR string `json:"nestedServiceCidr,omitempty"`
}

// EnvironmentStatus is what the controller actually did.
type EnvironmentStatus struct {
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	URL             string `json:"url,omitempty"`
	SharedBundleURL string `json:"sharedBundleUrl,omitempty"`

	Build string `json:"build,omitempty"`
	Run   string `json:"run,omitempty"`

	// BuildID names the environment's build Job. Recorded rather than derived
	// from the clock, so what desiredObjects() renders is stable across passes --
	// see reconcileEnvironment. Changing it is what a rebuild would mean.
	BuildID string `json:"buildId,omitempty"`

	// Named rather than inlined: the bootstrap password must not be readable to
	// everyone who can list Environments.
	BootstrapSecret string `json:"bootstrapSecret,omitempty"`

	Resolved   ResolvedSpec `json:"resolved,omitempty"`
	Conditions []Condition  `json:"conditions,omitempty"`
}

// Build states, from the environment's most recent build Job.
const (
	BuildUnknown  = "Unknown"
	BuildBuilding = "Building"
	BuildReady    = "Ready"
	BuildFailed   = "Failed"
)

// Run states, read back from the backend Deployment rather than from
// spec.running -- so an environment someone scaled by hand reads as stopped
// here, and there is no second copy of the truth to drift from the first.
//
// Stopping is worth separating from Stopped because the backend's pod holds the
// RWO data volume until it is gone, and a start issued in that window is what
// produces a pod stuck Pending on a volume still attached elsewhere.
const (
	RunPending  = "Pending"
	RunReady    = "Ready"
	RunStopped  = "Stopped"
	RunStopping = "Stopping"
)

// How an environment is reached. See the extension's exposureFor().
const (
	ExposureLocal  = "local"
	ExposureHop    = "hop"
	ExposureDirect = "direct"
)

// ResolvedSpec records what discovery settled on, so `kubectl get -o yaml`
// shows what an environment is running with and not merely what was asked for.
type ResolvedSpec struct {
	BackendImage      string `json:"backendImage,omitempty"`
	Hostname          string `json:"hostname,omitempty"`
	EntryPort         int    `json:"entryPort,omitempty"`
	IngressClass      string `json:"ingressClass,omitempty"`
	StorageClass      string `json:"storageClass,omitempty"`
	ClusterIssuer     string `json:"clusterIssuer,omitempty"`
	IssuerKind        string `json:"issuerKind,omitempty"`
	NestedPodCIDR     string `json:"nestedPodCidr,omitempty"`
	NestedServiceCIDR string `json:"nestedServiceCidr,omitempty"`

	Exposure string `json:"exposure,omitempty"`
	Hop      *Hop   `json:"hop,omitempty"`
}

// Hop is the path by which the host cluster fronts a downstream environment.
//
// Addresses are the only part of this that drifts -- replacing a node changes
// them -- which is what reconcileAll's EndpointSlice resync exists for.
type Hop struct {
	HostClusterID   string         `json:"hostClusterId,omitempty"`
	TargetClusterID string         `json:"targetClusterId,omitempty"`
	Addresses       []string       `json:"addresses,omitempty"`
	AddressType     string         `json:"addressType,omitempty"`
	Port            int            `json:"port,omitempty"`
	IngressClass    string         `json:"ingressClass,omitempty"`
	ClusterIssuer   string         `json:"clusterIssuer,omitempty"`
	IssuerKind      string         `json:"issuerKind,omitempty"`
	ACME            map[string]any `json:"acme,omitempty"`
}

type Condition struct {
	Type               string      `json:"type"`
	Status             string      `json:"status"`
	Reason             string      `json:"reason,omitempty"`
	Message            string      `json:"message,omitempty"`
	LastTransitionTime metav1.Time `json:"lastTransitionTime"`
	ObservedGeneration int64       `json:"observedGeneration,omitempty"`
}

// environmentClient is the dynamic client narrowed to Environments in the one
// namespace they live in. Dynamic rather than typed for the same reason the
// mirrored nodes are: there is no generated clientset here, and unstructured
// plus the converter below is the whole of what a typed one would provide.
type environmentClient struct {
	dyn dynamic.Interface
}

func (e *environmentClient) resource() dynamic.ResourceInterface {
	return e.dyn.Resource(environments).Namespace(Namespace)
}

func (e *environmentClient) List(ctx context.Context) ([]Environment, error) {
	list, err := e.resource().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	out := make([]Environment, 0, len(list.Items))

	for i := range list.Items {
		env, err := environmentFrom(&list.Items[i])
		if err != nil {
			// One unreadable object must not hide every other environment: the
			// likely cause is a field this build does not know about yet.
			return nil, fmt.Errorf("%s: %w", list.Items[i].GetName(), err)
		}

		out = append(out, *env)
	}

	return out, nil
}

func (e *environmentClient) Get(ctx context.Context, name string) (*Environment, error) {
	obj, err := e.resource().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}

	return environmentFrom(obj)
}

// UpdateStatus writes only the status subresource, so a status write can never
// clobber a spec edit made while this pass was running.
func (e *environmentClient) UpdateStatus(ctx context.Context, env *Environment) error {
	obj, err := unstructuredFrom(env)
	if err != nil {
		return err
	}

	_, err = e.resource().UpdateStatus(ctx, obj, metav1.UpdateOptions{})

	return err
}

func environmentFrom(obj *unstructured.Unstructured) (*Environment, error) {
	env := &Environment{}

	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, env); err != nil {
		return nil, fmt.Errorf("decoding Environment: %w", err)
	}

	return env, nil
}

func unstructuredFrom(env *Environment) (*unstructured.Unstructured, error) {
	// TypeMeta survives a round-trip through the converter but is not filled in
	// by it, and an update with no apiVersion/kind is rejected.
	env.APIVersion = environments.GroupVersion().String()
	env.Kind = "Environment"

	raw, err := runtime.DefaultUnstructuredConverter.ToUnstructured(env)
	if err != nil {
		return nil, fmt.Errorf("encoding Environment: %w", err)
	}

	return &unstructured.Unstructured{Object: raw}, nil
}
