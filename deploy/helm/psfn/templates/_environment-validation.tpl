{{/* One authority for chart-owned environment bindings. The render tests derive
     collision cases from every literal binding to detect inventory drift. */}}
{{- define "psfn.managedEnvironmentNames" -}}
{{- $policy := .Files.Get "files/environment-authority.json" | fromJson -}}
{{- toJson (concat $policy.managed $policy.securitySensitive | uniq) -}}
{{- end -}}

{{/* Credential names are roles, not arbitrary extraEnv overrides. Each may use
     its canonical name or a distinct custom name, never another role's name. */}}
{{- define "psfn.credentialEnvironmentBindings" -}}
{{- $bindings := list
  (dict "label" "provider.envName" "name" .Values.provider.envName "canonical" "PSFN_PROVIDER_API_KEY")
  (dict "label" "satelliteHub.eidoverse.tokenRef" "name" .Values.satelliteHub.eidoverse.tokenRef "canonical" "EIDOVERSE_JOIN_TOKEN") -}}
{{- range $index, $entry := .Values.fleetAuth.credentialEnv -}}
{{- $bindings = append $bindings (dict "label" (printf "fleetAuth.credentialEnv[%d].name" $index) "name" ($entry.name | default "") "canonical" "") -}}
{{- end -}}
{{- toJson $bindings -}}
{{- end -}}

{{- define "psfn.validateCredentialEnvironmentNames" -}}
{{- $policy := .Files.Get "files/environment-authority.json" | fromJson -}}
{{- $reserved := concat $policy.managed $policy.securitySensitive -}}
{{- $seen := dict -}}
{{- range $binding := include "psfn.credentialEnvironmentBindings" . | fromJsonArray -}}
{{- $name := $binding.name -}}
{{- if not (regexMatch "^[A-Z][A-Z0-9_]*$" $name) -}}
{{- fail (printf "%s must name an uppercase credential environment variable" $binding.label) -}}
{{- end -}}
{{/* Keep the existing authority-floor migration diagnostic below. */}}
{{- $authorityFloorDiagnostic := and (eq $name "FLEET_AUTH_AUTHORITY_FLOOR_ROOT") (hasPrefix "fleetAuth.credentialEnv[" $binding.label) -}}
{{- if and (has $name $reserved) (ne $name $binding.canonical) (not $authorityFloorDiagnostic) -}}
{{- fail (printf "%s cannot shadow a managed environment or security-sensitive variable" $binding.label) -}}
{{- end -}}
{{- if hasKey $seen $name -}}
{{- fail (printf "%s must use a distinct credential environment name" $binding.label) -}}
{{- end -}}
{{- $_ := set $seen $name true -}}
{{- end -}}
{{- end -}}
