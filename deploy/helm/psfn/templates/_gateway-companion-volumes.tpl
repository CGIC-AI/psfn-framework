{{/*
Gateway companion owner-root mounts.

Fleet mode binds every registered companion PVC at the canonical path that
resolveCompanionFleetPaths derives beneath PSFN_RUNTIME_ROOT. The first claim
retains the common "companion-data" volume name because the seed init container
and writable CogSec state submount share it.
*/}}
{{- define "psfn.gatewayCompanionDataVolumeMounts" -}}
{{- if .Values.fleet.enabled }}
{{- range $index, $companion := .Values.fleet.companions }}
- name: {{ ternary "companion-data" (printf "gateway-companion-data-%d" $index) (eq $index 0) }}
  mountPath: {{ printf "%s/companions/%s" $.Values.fleet.runtimeRoot $companion.companionId }}
  readOnly: true
{{- end }}
{{- else }}
- name: companion-data
  mountPath: {{ .Values.runtime.companionDataDir }}
  readOnly: true
{{- end }}
{{- end -}}

{{- define "psfn.gatewayAdditionalCompanionDataVolumes" -}}
{{- if .Values.fleet.enabled }}
{{- range $index, $companion := .Values.fleet.companions }}
{{- if gt $index 0 }}
- name: {{ printf "gateway-companion-data-%d" $index }}
  persistentVolumeClaim:
    claimName: {{ $companion.companionDataClaim }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}
