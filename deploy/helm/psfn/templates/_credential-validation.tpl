{{/* Shared policy is also consumed by src/shared/security/credentials.ts. */}}
{{- define "psfn.validateCredential" -}}
{{- $value := .value | default "" -}}
{{- $policy := .root.Files.Get "files/credential-policy.json" | fromJson -}}
{{- $error := printf "%s credential must be %v-%v characters with at least %v distinct characters; placeholders and repeated patterns are forbidden. Generate a fresh random value or select an existing Secret." .label $policy.minimumLength $policy.maximumLength $policy.minimumDistinctCharacters -}}
{{- if or (lt (len $value) (int $policy.minimumLength)) (gt (len $value) (int $policy.maximumLength)) (ne $value (trim $value)) (regexMatch "[^!-~]" $value) (regexMatch $policy.placeholderPattern $value) -}}
{{- fail $error -}}
{{- end -}}
{{- $characters := dict -}}
{{- range splitList "" $value -}}{{- $_ := set $characters . true -}}{{- end -}}
{{- if lt (len $characters) (int $policy.minimumDistinctCharacters) -}}{{- fail $error -}}{{- end -}}
{{- range untilStep 1 (int (add 1 (div (len $value) 2))) 1 -}}
{{- if and (eq (mod (len $value) .) 0) (eq $value (repeat (int (div (len $value) .)) (substr 0 . $value))) -}}{{- fail $error -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "psfn.validateCredentials" -}}
{{- $root := . -}}
{{- $credentials := dict -}}
{{- range $label, $name := dict "secrets.existingSecret" .Values.secrets.existingSecret "postgres.auth.existingSecret" .Values.postgres.auth.existingSecret "redis.auth.existingSecret" .Values.redis.auth.existingSecret -}}
{{- if and $name (or (gt (len $name) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $name))) -}}
{{- fail (printf "%s must name a valid Kubernetes Secret" $label) -}}
{{- end -}}
{{- end -}}
{{- $roleKeys := dict -}}
{{- range $role := list "apiKey" "adminToken" "gatewaySessionHmacKey" "gatewaySessionIntegrityAuthToken" "gatewayCompanionAuthToken" "backupEncryptionKey" "satelliteHubApiKey" "satelliteHubControlToken" "satelliteApiKeys" -}}
{{- $key := get $root.Values.secrets.keys $role | default "" -}}
{{- if or (not (regexMatch "^[a-zA-Z0-9._-]+$" $key)) (hasKey $roleKeys $key) -}}
{{- fail "secrets.keys must assign a valid, distinct Secret data key to each credential role" -}}
{{- end -}}
{{- $_ := set $roleKeys $key true -}}
{{- end -}}
{{- if .Values.secrets.allowMissingRequired -}}{{- fail "secrets.allowMissingRequired=true is no longer supported; select secrets.existingSecret or provide strong, distinct credentials" -}}{{- end -}}
{{- if not .Values.secrets.existingSecret -}}
{{- if not .Values.secrets.create -}}{{- fail "secrets.create=false requires secrets.existingSecret; no credential may be omitted" -}}{{- end -}}
{{- range $role := list "apiKey" "adminToken" "gatewaySessionHmacKey" "gatewaySessionIntegrityAuthToken" "gatewayCompanionAuthToken" "backupEncryptionKey" -}}
{{- $_ := set $credentials (printf "secrets.values.%s" $role) (get $root.Values.secrets.values $role | default "") -}}
{{- end -}}
{{- range $role := list "satelliteHubApiKey" "satelliteHubControlToken" "homeAssistantToken" "eidoverseJoinToken" "providerApiKey" "openRouterApiKey" "openAiApiKey" "embeddingApiKey" "hfToken" "discordToken" "deepgramApiKey" "elevenLabsApiKey" "falApiKey" "ntfyToken" -}}
{{- with get $root.Values.secrets.values $role -}}{{- $_ := set $credentials (printf "secrets.values.%s" $role) . -}}{{- end -}}
{{- end -}}
{{- if .Values.satelliteHub.enabled -}}
{{- $_ := set $credentials "secrets.values.satelliteHubApiKey" (.Values.secrets.values.satelliteHubApiKey | default "") -}}
{{- end -}}
{{- with .Values.secrets.values.extraSatelliteApiKeys -}}
{{- range $index, $value := splitList "," . -}}
{{- $_ := set $credentials (printf "secrets.values.extraSatelliteApiKeys[%d]" $index) (trim $value) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and .Values.postgres.enabled (not .Values.postgres.external.enabled) (not .Values.postgres.auth.existingSecret) -}}
{{- $_ := set $credentials "postgres.auth.password" (.Values.postgres.auth.password | default "") -}}
{{- end -}}
{{- if and .Values.redis.enabled (eq .Values.redis.mode "internal") (not .Values.redis.auth.existingSecret) -}}
{{- $_ := set $credentials "redis.auth.password" (.Values.redis.auth.password | default "") -}}
{{- end -}}
{{- $seen := dict -}}
{{- range $label, $value := $credentials -}}
{{- include "psfn.validateCredential" (dict "root" $root "label" $label "value" $value) -}}
{{- if hasKey $seen $value -}}{{- fail (printf "%s credential must not reuse another role's credential" $label) -}}{{- end -}}
{{- $_ := set $seen $value true -}}
{{- end -}}
{{- end -}}
