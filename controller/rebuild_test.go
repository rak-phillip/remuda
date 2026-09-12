package main

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

var buildClock = time.Unix(1789223188, 0)

func TestAdvanceBuildNamesTheFirstBuildOnce(t *testing.T) {
	env := &Environment{}

	if advanceBuild(env, buildClock) {
		t.Error("the first build was reported as a rebuild")
	}

	if env.Status.BuildID != "1789223188" {
		t.Fatalf("buildId = %q, want 1789223188", env.Status.BuildID)
	}

	// Every later pass has to render the same Job, or create-if-absent starts a
	// build every interval.
	if advanceBuild(env, buildClock.Add(30*time.Second)) || env.Status.BuildID != "1789223188" {
		t.Errorf("an unchanged spec moved the build to %q", env.Status.BuildID)
	}
}

func TestAdvanceBuildDoesNotRebuildForATokenSetAtCreate(t *testing.T) {
	// A scripted create may carry a token already. That asks for the first build,
	// not a second one on top of it.
	env := &Environment{Spec: EnvironmentSpec{RebuildRequest: "2026-09-12T14:26:00Z"}}

	advanceBuild(env, buildClock)

	if advanceBuild(env, buildClock.Add(time.Minute)) {
		t.Error("an Environment created with a token was rebuilt straight away")
	}
}

func TestAdvanceBuildRebuildsOncePerChangedToken(t *testing.T) {
	env := &Environment{}
	advanceBuild(env, buildClock)

	env.Spec.RebuildRequest = "2026-09-12T15:00:00Z"

	if !advanceBuild(env, buildClock.Add(time.Hour)) {
		t.Fatal("a changed token did not start a rebuild")
	}

	if env.Status.BuildID != "1789226788" {
		t.Errorf("buildId = %q, want 1789226788", env.Status.BuildID)
	}

	if env.Status.ObservedRebuildRequest != "2026-09-12T15:00:00Z" {
		t.Errorf("observedRebuildRequest = %q, want the token acted on", env.Status.ObservedRebuildRequest)
	}

	// Asked once, built once.
	if advanceBuild(env, buildClock.Add(2*time.Hour)) {
		t.Error("the same token started a second rebuild")
	}
}

func TestNextBuildIDNeverRepeatsTheLastOne(t *testing.T) {
	cases := []struct {
		name     string
		previous string
		now      time.Time
		want     string
	}{
		{"the clock has moved on", "1789223188", buildClock.Add(time.Minute), "1789223248"},
		// Two rebuilds inside one second would otherwise render one Job name, and
		// create-if-absent would take the new build for the old one.
		{"the same second", "1789223188", buildClock, "1789223189"},
		{"a clock behind the last id", "1789223188", buildClock.Add(-time.Minute), "1789223189"},
		// A hand-edited id cannot be compared, and the clock is still a fresh name.
		{"an unparseable previous id", "manual", buildClock, "1789223188"},
	}

	for _, tc := range cases {
		if got := nextBuildID(tc.previous, tc.now); got != tc.want {
			t.Errorf("%s: nextBuildID(%q) = %q, want %q", tc.name, tc.previous, got, tc.want)
		}
	}
}

func TestSweepSupersededBuildsKeepsOnlyTheCurrentBuild(t *testing.T) {
	spec := testSpec()
	neighbour := testSpec()
	neighbour.Name = "neighbour"

	core := fake.NewSimpleClientset(
		spec.buildJob("100"),
		spec.buildJob("200"),
		// Another environment's build in the same namespace, which is not this
		// environment's to retire.
		neighbour.buildJob("100"),
	)
	c := &controller{core: core}

	if err := c.sweepSupersededBuilds(context.Background(), spec, "200"); err != nil {
		t.Fatal(err)
	}

	jobs, err := core.BatchV1().Jobs(spec.Namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}

	left := map[string]bool{}
	for _, job := range jobs.Items {
		left[job.Name] = true
	}

	if len(left) != 2 || !left["multi-idp-build-200"] || !left["neighbour-build-100"] {
		t.Errorf("jobs left = %v, want the current build and the neighbour's", left)
	}

	// Orphan is the batch/v1 default, and an orphaned build pod keeps the ui and
	// cache claims from ever finalising.
	deletes := 0

	for _, action := range core.Actions() {
		deletion, ok := action.(k8stesting.DeleteAction)
		if !ok {
			continue
		}

		deletes++

		if policy := deletion.GetDeleteOptions().PropagationPolicy; policy == nil || *policy != metav1.DeletePropagationBackground {
			t.Errorf("deleted %s without Background propagation", deletion.GetName())
		}
	}

	if deletes != 1 {
		t.Errorf("%d deletes, want exactly the superseded build", deletes)
	}
}

func TestSweepSupersededBuildsIsQuietWhenNothingIsSuperseded(t *testing.T) {
	// The steady state, reached on every pass but the one after a rebuild.
	spec := testSpec()
	core := fake.NewSimpleClientset(spec.buildJob("200"))
	c := &controller{core: core}

	if err := c.sweepSupersededBuilds(context.Background(), spec, "200"); err != nil {
		t.Fatal(err)
	}

	for _, action := range core.Actions() {
		if action.GetVerb() == "delete" {
			t.Errorf("deleted %v with nothing superseded", action)
		}
	}
}
