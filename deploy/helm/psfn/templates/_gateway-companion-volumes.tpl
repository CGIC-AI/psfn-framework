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
{{- if gt $index 0 }}
# The union quarantined-artifact guard audits every companion's store on each
# fs.read/fs.search/shell.exec, so each follower companion also needs its
# writable CogSec state submount. Without it the store's write-lock fails
# EROFS against the read-only parent mount and every boundary read fails
# closed. The first companion's state submount lives in workloads.yaml.
- name: {{ printf "gateway-companion-data-%d" $index }}
  mountPath: {{ printf "%s/companions/%s/state" $.Values.fleet.runtimeRoot $companion.companionId }}
  subPath: state
{{- end }}
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

{{/*
Gateway Personal Workspace mounts.

The gateway executes workspace-scoped boundary tools (fs/git/shell sandbox)
for every registered companion, so fleet mode binds every follower
companion's workspace PVC writable at the canonical
resolveCompanionWorkspaceLayout path
<runtimeRoot>/workspaces/personal/<companionId>. The first companion keeps
the common "workspace" volume and mount (validations pin
runtime.workspacePath and persistence.workspace.existingClaim to the first
entry's canonical workspace), so the non-fleet render is unchanged.
*/}}
{{- define "psfn.gatewayAdditionalWorkspaceVolumeMounts" -}}
{{- range $index, $companion := .Values.fleet.companions }}
{{- if gt $index 0 }}
- name: {{ printf "gateway-workspace-%d" $index }}
  mountPath: {{ printf "%s/workspaces/personal/%s" $.Values.fleet.runtimeRoot $companion.companionId }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "psfn.gatewayAdditionalWorkspaceVolumes" -}}
{{- range $index, $companion := .Values.fleet.companions }}
{{- if gt $index 0 }}
- name: {{ printf "gateway-workspace-%d" $index }}
  persistentVolumeClaim:
    claimName: {{ $companion.workspaceClaim }}
{{- end }}
{{- end }}
{{- end -}}
