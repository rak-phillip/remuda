package main

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

const crdPath = "../deploy/chart/remuda-controller/templates/crd.yaml"

// The schema is the contract: the API server prunes anything not in it, so a
// field added to the Go structs and not to the CRD silently disappears on
// write. That failure is invisible -- the object applies, and the value is just
// gone -- which is exactly the kind worth spending a test on.
func TestGoTypesMatchCRDSchema(t *testing.T) {
	schema := loadSchema(t)

	spec, ok := schema["spec"].(map[string]any)
	if !ok {
		t.Fatal("no spec in the CRD schema")
	}

	status, ok := schema["status"].(map[string]any)
	if !ok {
		t.Fatal("no status in the CRD schema")
	}

	compare(t, "spec", reflect.TypeOf(EnvironmentSpec{}), spec)
	compare(t, "status", reflect.TypeOf(EnvironmentStatus{}), status)
}

// The chart's CRD is a Helm template, but only its labels are templated. Lines
// carrying a directive are dropped rather than rendered, which keeps this test
// from needing helm on the path to run.
func loadSchema(t *testing.T) map[string]any {
	t.Helper()

	raw, err := os.ReadFile(crdPath)
	if err != nil {
		t.Fatalf("reading the CRD: %v", err)
	}

	var kept []string

	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.Contains(line, "{{") {
			kept = append(kept, line)
		}
	}

	var crd struct {
		Spec struct {
			Versions []struct {
				Name   string `json:"name"`
				Schema struct {
					OpenAPIV3Schema map[string]any `json:"openAPIV3Schema"`
				} `json:"schema"`
			} `json:"versions"`
		} `json:"spec"`
	}

	if err := yaml.Unmarshal([]byte(strings.Join(kept, "\n")), &crd); err != nil {
		t.Fatalf("parsing the CRD: %v", err)
	}

	for _, version := range crd.Spec.Versions {
		if version.Name != environments.Version {
			continue
		}

		properties, ok := version.Schema.OpenAPIV3Schema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s has no properties", version.Name)
		}

		return properties
	}

	t.Fatalf("the CRD serves no %s", environments.Version)

	return nil
}

// compare walks a struct against the schema node that is meant to describe it.
//
// One direction only: every Go field must be in the schema, because that is the
// direction that loses data. A schema field with no Go field is merely unread,
// which is what a spec the controller does not consume yet looks like.
func compare(t *testing.T, path string, goType reflect.Type, node map[string]any) {
	t.Helper()

	properties, _ := node["properties"].(map[string]any)

	for i := 0; i < goType.NumField(); i++ {
		field := goType.Field(i)

		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			continue
		}

		child, ok := properties[name].(map[string]any)
		if !ok {
			t.Errorf("%s.%s is in the Go struct but not the schema, so it would be pruned on write", path, name)

			continue
		}

		descend(t, path+"."+name, field.Type, child)
	}
}

func descend(t *testing.T, path string, goType reflect.Type, node map[string]any) {
	t.Helper()

	for goType.Kind() == reflect.Pointer {
		goType = goType.Elem()
	}

	switch goType.Kind() {
	case reflect.Struct:
		// metav1.Time and friends are scalars on the wire, not objects.
		if node["type"] == "string" {
			return
		}

		compare(t, path, goType, node)
	case reflect.Slice:
		items, ok := node["items"].(map[string]any)
		if !ok {
			t.Errorf("%s is a slice but the schema gives it no items", path)

			return
		}

		descend(t, path+"[]", goType.Elem(), items)
	case reflect.Map:
		// A free-form map only survives if the schema says to keep it.
		if node["x-kubernetes-preserve-unknown-fields"] != true {
			t.Errorf("%s is a free-form map, so the schema must set x-kubernetes-preserve-unknown-fields", path)
		}
	}
}
