{{/* Register physical namespace-local Secret name/key tuples, not merely the
     spelling of keys within one values map. Repeated consumers of one semantic
     role are allowed; different credential roles must never share a tuple. */}}
{{- define "psfn.registerSecretCredential" -}}
{{- $key := .key | default "" -}}
{{- if or (gt (len $key) 253) (not (regexMatch "^[A-Za-z0-9._-]+$" $key)) (has $key (list "." "..")) -}}
{{- fail (printf "%s must select a valid Kubernetes Secret data key" .label) -}}
{{- end -}}
{{- $name := .name | default "" -}}
{{- if or (gt (len $name) 253) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" $name)) -}}
{{- fail (printf "%s must name a valid Kubernetes Secret" .label) -}}
{{- end -}}
{{- $tuple := printf "%s/%s" $name $key -}}
{{- if and (hasKey .seen $tuple) (ne (get .seen $tuple) .role) -}}
{{- fail (printf "%s must assign a distinct Secret data key to each credential role" .label) -}}
{{- end -}}
{{- $_ := set .seen $tuple .role -}}
{{- end -}}

{{- define "psfn.validateSecretCredentialReferences" -}}
{{- $root := . -}}
{{- $seen := dict -}}
{{- $appName := include "psfn.appSecretName" . -}}
{{- $postgresName := include "psfn.postgresSecretName" . -}}
{{- $requiredRoles := .Files.Get "files/credential-key-roles.json" | fromJsonArray -}}
{{- range $role := concat $requiredRoles (keys .Values.secrets.keys) | uniq -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "secrets.keys" "role" (printf "app.%s" $role) "name" $appName "key" (get $root.Values.secrets.keys $role)) -}}
{{- end -}}
{{- if and .Values.postgres.enabled (not .Values.postgres.external.enabled) -}}
{{- range $role := concat (list "password" "databaseUrl") (keys .Values.postgres.auth.keys) | uniq -}}
{{- $semanticRole := printf "postgres.%s" $role -}}
{{- if eq $role "databaseUrl" -}}{{- $semanticRole = "postgres.runtimeDatabaseUrl" -}}{{- end -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "postgres.auth.keys" "role" $semanticRole "name" $postgresName "key" (get $root.Values.postgres.auth.keys $role)) -}}
{{- end -}}
{{- else if .Values.postgres.external.enabled -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "postgres.external.databaseUrlSecret" "role" "postgres.runtimeDatabaseUrl" "name" .Values.postgres.external.databaseUrlSecret.name "key" (include "psfn.databaseUrlSecretKey" .)) -}}
{{- end -}}
{{- if .Values.runtimeBootstrap.enabled -}}
{{- range $role := concat (list "adminDatabaseUrl" "companionDatabaseUrl" "sharedMigrationDatabaseUrl" "companionRoleKey" "sharedMigrationRoleKey") (keys .Values.runtimeBootstrap.keys) | uniq -}}
{{- $semanticRole := printf "postgres.%s" $role -}}
{{- if eq $role "companionDatabaseUrl" -}}{{- $semanticRole = "postgres.runtimeDatabaseUrl" -}}{{- end -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "runtimeBootstrap.keys" "role" $semanticRole "name" $postgresName "key" (get $root.Values.runtimeBootstrap.keys $role)) -}}
{{- end -}}
{{- end -}}
{{- if .Values.redis.enabled -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "redis password reference" "role" "redis.password" "name" (include "psfn.redisPasswordSecretName" .) "key" (include "psfn.redisPasswordSecretKey" .)) -}}
{{- end -}}
{{- range $entry := list
  (dict "label" "redis.external.tls.caSecret" "role" "redis.tlsCA" "ref" .Values.redis.external.tls.caSecret)
  (dict "label" "embeddings.api.apiKeySecret" "role" "app.embeddingApiKey" "ref" .Values.embeddings.api.apiKeySecret)
  (dict "label" "hubDeviceAssertions.auditPepperSecretRef" "role" "hub.auditPepper" "ref" .Values.hubDeviceAssertions.auditPepperSecretRef)
  (dict "label" "satelliteHub.deviceAssertion.privateKeySecretRef" "role" "hub.devicePrivateKey" "ref" .Values.satelliteHub.deviceAssertion.privateKeySecretRef) -}}
{{- if $entry.ref.name -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" $entry.label "role" $entry.role "name" $entry.ref.name "key" $entry.ref.key) -}}
{{- end -}}
{{- end -}}
{{- range $index, $entry := .Values.fleetAuth.credentialEnv -}}
{{- with $entry.secretRef -}}
{{- if and .name .key -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "fleetAuth.credentialEnv.secretRef" "role" (printf "fleetAuth.%s" $entry.name) "name" .name "key" .key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if .Values.fleet.enabled -}}
{{- range $index, $companion := .Values.fleet.companions -}}
{{- $authName := default $appName $companion.authSecret.name -}}
{{- range $role, $key := dict "gatewaySessionIntegrityAuthToken" (default $root.Values.secrets.keys.gatewaySessionIntegrityAuthToken $companion.authSecret.sessionIntegrityKey) "gatewayCompanionAuthToken" (default $root.Values.secrets.keys.gatewayCompanionAuthToken $companion.authSecret.companionAuthKey) -}}
{{- $semanticRole := printf "fleet.%s.%s" $companion.companionId $role -}}
{{- if eq $index 0 -}}{{- $semanticRole = printf "app.%s" $role -}}{{- end -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "fleet.companions.authSecret" "role" $semanticRole "name" $authName "key" $key) -}}
{{- end -}}
{{- with $companion.databaseUrlSecretKey -}}
{{- $semanticRole := "postgres.runtimeDatabaseUrl" -}}
{{- if ne . (include "psfn.databaseUrlSecretKey" $root) -}}{{- $semanticRole = printf "fleet.%s.databaseUrl" $companion.companionId -}}{{- end -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "fleet.companions.databaseUrlSecretKey" "role" $semanticRole "name" (include "psfn.databaseUrlSecretName" $root) "key" .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
