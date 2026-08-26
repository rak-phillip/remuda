package main

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func deployment(desired *int32, current, ready int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		Spec:   appsv1.DeploymentSpec{Replicas: desired},
		Status: appsv1.DeploymentStatus{Replicas: current, ReadyReplicas: ready},
	}
}

func TestRunStateOf(t *testing.T) {
	zero, one := int32(0), int32(1)

	// Stopping is separate from Stopped because the backend's pod holds the RWO
	// data volume until it is gone, and a start issued in that window produces a
	// pod stuck Pending on a volume still attached elsewhere.
	if got := RunStateOf(deployment(&zero, 1, 0)); got != RunStopping {
		t.Errorf("scaled to zero with a pod still up = %q, want %q", got, RunStopping)
	}

	if got := RunStateOf(deployment(&zero, 0, 0)); got != RunStopped {
		t.Errorf("scaled to zero and gone = %q, want %q", got, RunStopped)
	}

	// readyReplicas, not replicas: the readiness probe is what separates a
	// Rancher that is serving from one still six minutes into its k3s start.
	if got := RunStateOf(deployment(&one, 1, 0)); got != RunPending {
		t.Errorf("running but not ready = %q, want %q", got, RunPending)
	}

	if got := RunStateOf(deployment(&one, 1, 1)); got != RunReady {
		t.Errorf("ready = %q, want %q", got, RunReady)
	}

	if got := RunStateOf(nil); got != RunPending {
		t.Errorf("no deployment yet = %q, want %q", got, RunPending)
	}

	// Reading an unset replicas as stopped would be the damaging way to be
	// wrong, so it is assumed running.
	if got := RunStateOf(deployment(nil, 1, 1)); got != RunReady {
		t.Errorf("unset replicas = %q, want %q", got, RunReady)
	}
}

func job(age time.Duration, succeeded, failed int32) batchv1.Job {
	return batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			CreationTimestamp: metav1.NewTime(time.Now().Add(-age)),
		},
		Status: batchv1.JobStatus{Succeeded: succeeded, Failed: failed},
	}
}

func TestBuildStateOfPrefersTheNewestJob(t *testing.T) {
	// A rebuild's state has to win over the build it replaced, or a successful
	// rebuild of a previously failed branch keeps reporting Failed forever.
	jobs := []batchv1.Job{
		job(time.Hour, 0, 1),
		job(time.Minute, 1, 0),
	}

	if got := BuildStateOf(jobs); got != BuildReady {
		t.Errorf("got %q, want %q", got, BuildReady)
	}

	if got := BuildStateOf([]batchv1.Job{job(time.Minute, 0, 0)}); got != BuildBuilding {
		t.Errorf("running build = %q, want %q", got, BuildBuilding)
	}

	if got := BuildStateOf(nil); got != BuildUnknown {
		t.Errorf("no jobs = %q, want %q", got, BuildUnknown)
	}
}

func TestSetConditionKeepsTransitionTimeWhileStatusHolds(t *testing.T) {
	// The timestamp is meant to say when the state last flipped, not when it was
	// last confirmed -- a resync every 30 seconds must not keep bumping it.
	env := &Environment{}

	setCondition(env, ConditionResolved, "False", "ResolveFailed", "no defaults")
	first := env.Status.Conditions[0].LastTransitionTime

	setCondition(env, ConditionResolved, "False", "ResolveFailed", "still no defaults")

	if len(env.Status.Conditions) != 1 {
		t.Fatalf("expected one condition, got %d", len(env.Status.Conditions))
	}

	if !env.Status.Conditions[0].LastTransitionTime.Equal(&first) {
		t.Error("lastTransitionTime moved without the status changing")
	}

	if env.Status.Conditions[0].Message != "still no defaults" {
		t.Error("message did not update")
	}

	setCondition(env, ConditionResolved, "True", "Resolved", "")

	if env.Status.Conditions[0].LastTransitionTime.Equal(&first) {
		t.Error("lastTransitionTime did not move when the status flipped")
	}
}

func TestGeneratedPasswordsDiffer(t *testing.T) {
	a, err := generatePassword()
	if err != nil {
		t.Fatal(err)
	}

	b, err := generatePassword()
	if err != nil {
		t.Fatal(err)
	}

	if a == b {
		t.Fatal("two bootstrap passwords came out identical")
	}

	if len(a) < 20 {
		t.Fatalf("bootstrap password is only %d characters", len(a))
	}
}
