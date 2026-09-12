package main

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestSyncK3sConfigRewritesAnOutdatedConfig(t *testing.T) {
	// An environment created before disable-network-policy was rendered.
	// Create-if-absent left its ConfigMap alone, and without the setting it
	// cannot survive its next start.
	spec := testSpec()
	outdated := spec.k3sConfig()
	outdated.Data = map[string]string{"config.yaml": "cluster-cidr:\n  - \"10.44.0.0/16\"\n"}

	core := fake.NewSimpleClientset(outdated)
	c := &controller{core: core}

	if err := c.syncK3sConfig(context.Background(), spec); err != nil {
		t.Fatal(err)
	}

	got, err := core.CoreV1().ConfigMaps(spec.Namespace).Get(context.Background(), spec.k3sConfigName(), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}

	if want := spec.k3sConfig().Data["config.yaml"]; got.Data["config.yaml"] != want {
		t.Errorf("config.yaml =\n%s\nwant\n%s", got.Data["config.yaml"], want)
	}

	// Rewritten in place, so the owner reference that collects it survives.
	if len(got.OwnerReferences) != len(outdated.OwnerReferences) {
		t.Errorf("owner references = %v, want %v", got.OwnerReferences, outdated.OwnerReferences)
	}
}

func TestSyncK3sConfigIsQuietWhenCurrent(t *testing.T) {
	// The steady state, reached on every pass after the first sync.
	spec := testSpec()
	core := fake.NewSimpleClientset(spec.k3sConfig())
	c := &controller{core: core}

	if err := c.syncK3sConfig(context.Background(), spec); err != nil {
		t.Fatal(err)
	}

	for _, action := range core.Actions() {
		if action.GetVerb() == "update" {
			t.Errorf("updated %v with nothing to change", action)
		}
	}
}

func TestSyncK3sConfigLeavesAMissingConfigToProvision(t *testing.T) {
	spec := testSpec()
	core := fake.NewSimpleClientset()
	c := &controller{core: core}

	if err := c.syncK3sConfig(context.Background(), spec); err != nil {
		t.Fatalf("a ConfigMap not created yet was reported as an error: %v", err)
	}

	for _, action := range core.Actions() {
		if action.GetVerb() != "get" {
			t.Errorf("unexpected %s on a missing ConfigMap", action.GetVerb())
		}
	}
}
