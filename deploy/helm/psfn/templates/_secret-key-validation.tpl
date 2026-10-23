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
{{- fail (printf "%s must assign a distinct Secret data key to each credential role (%s conflicts with %s)" .label .role (get .seen $tuple)) -}}
{{- end -}}
{{- $_ := set .seen $tuple .role -}}
{{- end -}}

{{- define "psfn.secretCredentialInventory" -}}
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
{{- range $role := concat (list "adminDatabaseUrl" "companionDatabaseUrl" "sharedMigrationDatabaseUrl" "companionRoleKey" "sharedMigrationRoleKey") (keys .Values.runtimeBootstrap.keys) | uniq -}}
{{- $semanticRole := printf "postgres.%s" $role -}}
{{- if eq $role "companionDatabaseUrl" -}}{{- $semanticRole = "postgres.runtimeDatabaseUrl" -}}{{- end -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "runtimeBootstrap.keys" "role" $semanticRole "name" $postgresName "key" (get $root.Values.runtimeBootstrap.keys $role)) -}}
{{- end -}}
{{/* Runtime URL consumers exist even when PostgreSQL or bootstrap is external/disabled.
     Resolve through the same helpers as env and file mounts, including fleet overrides. */}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "runtime database URL reference" "role" "postgres.runtimeDatabaseUrl" "name" (include "psfn.databaseUrlSecretName" .) "key" (include "psfn.databaseUrlSecretKey" .)) -}}
{{- if .Values.redis.enabled -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "redis password reference" "role" "redis.password" "name" (include "psfn.redisPasswordSecretName" .) "key" (include "psfn.redisPasswordSecretKey" .)) -}}
{{- end -}}
{{- range $entry := list
  (dict "label" "redis.external.tls.caSecret" "role" "redis.tlsCA" "ref" .Values.redis.external.tls.caSecret)
  (dict "label" "embeddings.api.apiKeySecret" "role" "app.embeddingApiKey" "ref" .Values.embeddings.api.apiKeySecret)
  (dict "label" "hubDeviceAssertions.auditPepperSecretRef" "role" "hub.auditPepper" "ref" .Values.hubDeviceAssertions.auditPepperSecretRef)
  (dict "label" "satelliteHub.voxta.authTokenSecretRef" "role" "app.voxtaAuthToken" "ref" .Values.satelliteHub.voxta.authTokenSecretRef)
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
{{/* extraEnv Secret references are credentials even under custom environment names. */}}
{{- range $surface, $entries := dict "gateway" .Values.workloads.gateway.extraEnv "agent" .Values.workloads.agent.extraEnv "garden" .Values.workloads.garden.extraEnv "satelliteHub" .Values.satelliteHub.extraEnv -}}
{{- range $entry := $entries -}}
{{- if kindIs "map" $entry -}}
{{- $source := $entry.valueFrom | default dict -}}
{{- with $source.secretKeyRef -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" (printf "%s.extraEnv.valueFrom.secretKeyRef" $surface) "role" (printf "extraEnv.%s" $entry.name) "name" .name "key" .key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{/* Certificate private keys are privileged credentials too. Reserve their tuples
     so an external token reference cannot select a mounted TLS identity. */}}
{{- $certificates := list "ca" "gatewayRpc" "gardenAdminClient" "satelliteHubClient" "gardenSsoServer" "gatewaySsoClient" -}}
{{- if not .Values.fleet.enabled -}}{{- $certificates = concat $certificates (list "agentRpcClient" "agentAdmin") -}}{{- end -}}
{{- range $certificate := $certificates -}}
{{- $helper := printf "psfn.%sCertSecretName" $certificate -}}
{{- if eq $certificate "ca" -}}{{- $helper = "psfn.caSecretName" -}}{{- end -}}
{{- $name := include $helper $root -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "certificates" "role" (printf "tls.%s" $certificate) "name" $name "key" "tls.key") -}}
{{- end -}}
{{- if .Values.fleet.enabled -}}
{{- range $companion := .Values.fleet.companions -}}
{{- $target := dict "root" $root "companionId" $companion.companionId -}}
{{- range $kind := list "RpcClient" "Admin" -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "fleet certificates" "role" (printf "tls.fleet.%s.%s" $companion.companionId $kind) "name" (include (printf "psfn.fleetAgent%sCertSecretName" $kind) $target) "key" "tls.key") -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- range $component := list "gateway" "garden" "satelliteHub" -}}
{{- $ingress := get $root.Values.ingress $component -}}
{{- if and $root.Values.ingress.enabled $ingress.enabled $ingress.tls.enabled $ingress.tls.secretName -}}
{{- include "psfn.registerSecretCredential" (dict "seen" $seen "label" "ingress TLS Secret" "role" "tls.ingress" "name" $ingress.tls.secretName "key" "tls.key") -}}
{{- end -}}
{{- end -}}
{{- $voxta := .Values.satelliteHub.voxta -}}
{{- if and .Values.satelliteHub.enabled $voxta.enabled (not .Values.secrets.existingSecret) (eq $voxta.authTokenSecretRef.name $appName) -}}
{{- if or (ne $voxta.authTokenSecretRef.key .Values.secrets.keys.voxtaAuthToken) (not .Values.secrets.values.voxtaAuthToken) -}}
{{- fail "satelliteHub.voxta.authTokenSecretRef must select secrets.keys.voxtaAuthToken with secrets.values.voxtaAuthToken in the chart-owned app Secret" -}}
{{- end -}}
{{- end -}}
{{- toJson $seen -}}
{{- end -}}

{{- define "psfn.validateSecretCredentialReferences" -}}
{{- $_ := include "psfn.secretCredentialInventory" . -}}
{{- end -}}
