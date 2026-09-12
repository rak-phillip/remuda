package main

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A rebuild is asked for, never scheduled.
//
// spec.rebuildRequest is an opaque token: whoever wants a fresh build writes a
// value it has not held before, and the controller acts when that differs from
// status.observedRebuildRequest. A token rather than a `rebuild: true`, because
// this controller writes only status -- a flag it had acted on could never be
// reset, and would read as a standing request forever. Comparing for change also
// makes asking twice harmless: writing the same value again changes nothing.

// advanceBuild settles which build Job this pass renders, and reports whether a
// rebuild was asked for since the last one started.
//
// The first pass names the first build and takes whatever token the spec already
// carries as seen, so an Environment created with rebuildRequest set builds once
// rather than twice. After that the id moves only when the token does.
func advanceBuild(env *Environment, now time.Time) bool {
	requested := env.Spec.RebuildRequest

	if env.Status.BuildID == "" {
		env.Status.BuildID = strconv.FormatInt(now.Unix(), 10)
		env.Status.ObservedRebuildRequest = requested

		return false
	}

	if requested == env.Status.ObservedRebuildRequest {
		return false
	}

	env.Status.BuildID = nextBuildID(env.Status.BuildID, now)
	env.Status.ObservedRebuildRequest = requested

	return true
}

// nextBuildID is a fresh id that is never the one it replaces.
//
// Seconds, like the first, but moved past the previous id when the clock has not:
// two rebuilds inside one second would otherwise render the same Job name, and
// create-if-absent would take the new build for the old one and do nothing.
func nextBuildID(previous string, now time.Time) string {
	next := now.Unix()

	if last, err := strconv.ParseInt(previous, 10, 64); err == nil && next <= last {
		next = last + 1
	}

	return strconv.FormatInt(next, 10)
}

// sweepSupersededBuilds deletes every build Job of this environment except the
// current one.
//
// Only the direct backend needs it. provision() only ever creates, so without
// this every rebuild would leave the previous Job behind; a Bundle declares
// exactly one Job, so downstream the old one leaves the release when its name
// does.
//
// Background propagation rather than the batch/v1 default of Orphan: an orphaned
// build pod keeps the ui and cache claims it mounted, and pvc-protection then
// stops those claims from ever finalising.
//
// Called before provision(), so a build still running when the next is asked for
// is already on its way out as its successor starts. Its pod gets the usual grace
// period, which is well inside the minutes a new build spends cloning and
// installing before it touches the volume.
func (c *controller) sweepSupersededBuilds(ctx context.Context, spec *renderSpec, buildID string) error {
	jobs, err := c.jobsFor(ctx, spec.Name)
	if err != nil {
		return err
	}

	current := spec.buildJobName(buildID)
	background := metav1.DeletePropagationBackground

	for i := range jobs {
		name := jobs[i].Name
		if name == current {
			continue
		}

		err := c.core.BatchV1().Jobs(spec.Namespace).Delete(ctx, name, metav1.DeleteOptions{
			PropagationPolicy: &background,
		})
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("deleting superseded build %s: %w", name, err)
		}

		log.Printf("%s: deleted superseded build %s", spec.Name, name)
	}

	return nil
}
