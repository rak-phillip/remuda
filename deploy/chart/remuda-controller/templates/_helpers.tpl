{{- define "remuda-controller.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "remuda-controller.labels" -}}
app.kubernetes.io/name: {{ include "remuda-controller.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "remuda-controller.selectorLabels" -}}
app.kubernetes.io/name: {{ include "remuda-controller.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
