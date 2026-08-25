{{- define "psfn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "psfn.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "psfn.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "psfn.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "psfn.labels" -}}
helm.sh/chart: {{ include "psfn.chart" . }}
app.kubernetes.io/name: {{ include "psfn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "psfn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "psfn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "psfn.componentLabels" -}}
{{ include "psfn.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "psfn.fleetAgentLabels" -}}
{{ include "psfn.componentLabels" (dict "root" .root "component" "agent") }}
psfn.io/companion-id: {{ .companionId }}
psfn.io/fleet-target: registered
{{- end -}}

{{- define "psfn.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "psfn.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "psfn.kubeSelfManagementServiceAccountName" -}}
{{- default (printf "%s-kube-self-management" (include "psfn.fullname" .)) .Values.kubeSelfManagement.serviceAccountName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "psfn.gatewayServiceAccountName" -}}
{{- if .Values.kubeSelfManagement.enabled -}}
{{- include "psfn.kubeSelfManagementServiceAccountName" . -}}
{{- else -}}
{{- include "psfn.serviceAccountName" . -}}
{{- end -}}
{{- end -}}

{{- define "psfn.image" -}}
{{- $root := .root -}}
{{- $image := .image -}}
{{- $base := $root.Values.psfnAppImage -}}
{{- $repository := default $base.repository $image.repository -}}
{{- $tag := default $base.tag $image.tag -}}
{{- $digest := default $base.digest $image.digest -}}
{{- if $digest -}}
{{- printf "%s:%s@%s" $repository $tag $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "psfn.systemDataClaimName" -}}
{{- default (printf "%s-system-data" (include "psfn.fullname" .)) .Values.persistence.systemData.existingClaim -}}
{{- end -}}

{{- define "psfn.companionDataClaimName" -}}
{{- default (printf "%s-companion-data" (include "psfn.fullname" .)) .Values.persistence.companionData.existingClaim -}}
{{- end -}}

{{/*
Canonical writable mount for observer-eval persistence metadata. The backing
directory is a dedicated subPath on the companion-data PVC, while the mount
path stays outside every runtime root that the observer isolation guard rejects.
*/}}
{{- define "psfn.observerEvalSidecarPersistenceRootDir" -}}
{{- printf "%s/observer-eval-sidecar" (trimSuffix "/" .Values.fleet.runtimeRoot) -}}
{{- end -}}

{{- define "psfn.workspaceClaimName" -}}
{{- default (printf "%s-workspace" (include "psfn.fullname" .)) .Values.persistence.workspace.existingClaim -}}
{{- end -}}

{{- define "psfn.runtimeClaimName" -}}
{{- default (printf "%s-runtime" (include "psfn.fullname" .)) .Values.persistence.runtime.existingClaim -}}
{{- end -}}

{{- define "psfn.modelCacheClaimName" -}}
{{- default (printf "%s-model-cache" (include "psfn.fullname" .)) .Values.persistence.modelCache.existingClaim -}}
{{- end -}}

{{- define "psfn.fleetAuthAuthorityFloorClaimName" -}}
{{- $authorityFloor := .Values.fleetAuth.authorityFloor | default dict -}}
{{- default (printf "%s-fleet-auth-floor" (include "psfn.fullname" .)) (get $authorityFloor "existingClaim") -}}
{{- end -}}

{{- define "psfn.fleetAuthAuthorityFloorMountPath" -}}
{{- $authorityFloor := .Values.fleetAuth.authorityFloor | default dict -}}
{{- get $authorityFloor "mountPath" | default "" -}}
{{- end -}}

{{- define "psfn.ownerMigrationImage" -}}
{{- $root := .root -}}
{{- $image := .image -}}
{{- $repository := default $root.Values.psfnAppImage.repository $image.repository -}}
{{- $digest := default $root.Values.psfnAppImage.digest $image.digest -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end -}}

{{- define "psfn.postgresImage" -}}
{{- $image := .Values.postgres.image -}}
{{- printf "%s:%s@%s" $image.repository $image.tag $image.digest -}}
{{- end -}}

{{- define "psfn.redisImage" -}}
{{- $image := .Values.redis.image -}}
{{- printf "%s:%s@%s" $image.repository $image.tag $image.digest -}}
{{- end -}}

{{- define "psfn.emosimImage" -}}
{{- $image := .Values.emosim.image -}}
{{- $repository := required "emosim.image.repository is required when emosim.enabled=true" $image.repository -}}
{{- $tag := default "" $image.tag -}}
{{- $digest := default "" $image.digest -}}
{{- if and (not $tag) (not $digest) -}}
{{- fail "emosim.image.tag or emosim.image.digest is required when emosim.enabled=true" -}}
{{- end -}}
{{- if $digest -}}
{{- printf "%s:%s@%s" $repository $tag $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "psfn.satelliteHubImage" -}}
{{- $image := .Values.satelliteHub.image -}}
{{- $repository := required "satelliteHub.image.repository is required when satelliteHub.enabled=true" $image.repository -}}
{{- $tag := default "" $image.tag -}}
{{- $digest := default "" $image.digest -}}
{{- if and (not $tag) (not $digest) -}}
{{- fail "satelliteHub.image.tag or satelliteHub.image.digest is required when satelliteHub.enabled=true" -}}
{{- end -}}
{{- if and $tag (or (eq $tag "latest") (eq $tag "main") (eq $tag "main-latest")) -}}
{{- fail "satelliteHub.image.tag must be pinned and must not be latest/main/main-latest" -}}
{{- end -}}
{{- if and $digest (not (hasPrefix "sha256:" $digest)) -}}
{{- fail "satelliteHub.image.digest must start with sha256:" -}}
{{- end -}}
{{- if and $tag $digest -}}
{{- printf "%s:%s@%s" $repository $tag $digest -}}
{{- else if $digest -}}
{{- printf "%s@%s" $repository $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "psfn.companionUiTestImage" -}}
{{- $image := .Values.companionUiTest.image -}}
{{- $repository := required "companionUiTest.image.repository is required when companionUiTest.enabled=true" $image.repository -}}
{{- $tag := default "" $image.tag -}}
{{- $digest := default "" $image.digest -}}
{{- if and (not $tag) (not $digest) -}}
{{- fail "companionUiTest.image.tag or companionUiTest.image.digest is required when companionUiTest.enabled=true" -}}
{{- end -}}
{{- if and $tag (or (eq $tag "latest") (eq $tag "main") (eq $tag "main-latest")) -}}
{{- fail "companionUiTest.image.tag must be pinned and must not be latest/main/main-latest" -}}
{{- end -}}
{{- if and $digest (not (hasPrefix "sha256:" $digest)) -}}
{{- fail "companionUiTest.image.digest must start with sha256:" -}}
{{- end -}}
{{- if and $tag $digest -}}
{{- printf "%s:%s@%s" $repository $tag $digest -}}
{{- else if $digest -}}
{{- printf "%s@%s" $repository $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "psfn.appSecretName" -}}
{{- default (printf "%s-app" (include "psfn.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "psfn.postgresSecretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-postgres" (include "psfn.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "psfn.redisSecretName" -}}
{{- if .Values.redis.auth.existingSecret -}}
{{- .Values.redis.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-redis" (include "psfn.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "psfn.gatewayApiServiceName" -}}
{{- printf "%s-gateway" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gatewayRpcServiceName" -}}
{{- printf "%s-gateway-rpc" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.agentAdminServiceName" -}}
{{- if .Values.fleet.enabled -}}
{{- printf "%s-agent-admin" (include "psfn.fullname" .) | trunc 26 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-agent-admin" (include "psfn.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "psfn.fleetAgentDeploymentName" -}}
{{- printf "%s-agent" (include "psfn.fullname" .root) | trunc 26 | trimSuffix "-" -}}-{{ .companionId }}
{{- end -}}

{{- define "psfn.fleetAgentAdminServiceName" -}}
{{- include "psfn.agentAdminServiceName" .root -}}-{{ .companionId }}
{{- end -}}

{{- define "psfn.fleetCompanionPostgresSchema" -}}
{{- $companionId := .Values.runtime.companionId -}}
{{- $schema := "" -}}
{{- range .Values.fleet.companions -}}
{{- if eq .companionId $companionId -}}
{{- $schema = .postgresSchema -}}
{{- end -}}
{{- end -}}
{{- $schema -}}
{{- end -}}

{{- define "psfn.fleetCompanionDatabaseUrlSecretKey" -}}
{{- $companionId := .Values.runtime.companionId -}}
{{- $secretKey := "" -}}
{{- range .Values.fleet.companions -}}
{{- if eq .companionId $companionId -}}
{{- $secretKey = default "" .databaseUrlSecretKey -}}
{{- end -}}
{{- end -}}
{{- $secretKey -}}
{{- end -}}

{{- define "psfn.fleetCompanionIds" -}}
{{- $ids := list -}}
{{- range .Values.fleet.companions -}}
{{- $ids = append $ids .companionId -}}
{{- end -}}
{{- join "," $ids -}}
{{- end -}}

{{- define "psfn.gardenServiceName" -}}
{{- printf "%s-garden" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.postgresServiceName" -}}
{{- printf "%s-postgres" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.redisServiceName" -}}
{{- printf "%s-redis" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.emosimServiceName" -}}
{{- printf "%s-emosim" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.satelliteHubServiceName" -}}
{{- printf "%s-satellite-hub" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.companionUiTestServiceName" -}}
{{- printf "%s-companion-ui-test" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gatewayRpcUrlForServer" -}}
{{- printf "wss://0.0.0.0:%v/rpc" .Values.ports.gatewayRpc -}}
{{- end -}}

{{- define "psfn.gatewayRpcUrlForClient" -}}
{{- printf "wss://%s.%s.svc:%v/rpc" (include "psfn.gatewayRpcServiceName" .) .Release.Namespace .Values.ports.gatewayRpc -}}
{{- end -}}

{{- define "psfn.gatewayRpcServerName" -}}
{{- printf "%s.%s.svc" (include "psfn.gatewayRpcServiceName" .) .Release.Namespace -}}
{{- end -}}

{{- define "psfn.agentAdminUrl" -}}
{{- printf "https://%s.%s.svc:%v" (include "psfn.agentAdminServiceName" .) .Release.Namespace .Values.ports.agentAdmin -}}
{{- end -}}

{{- define "psfn.agentAdminServerName" -}}
{{- printf "%s.%s.svc" (include "psfn.agentAdminServiceName" .) .Release.Namespace -}}
{{- end -}}

{{- define "psfn.spiffeGateway" -}}
{{- if .Values.fleet.enabled -}}
{{- printf "spiffe://%s/psfn/gateway/fleet" .Values.certificates.trustDomain -}}
{{- else -}}
{{- printf "spiffe://%s/psfn/gateway/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
{{- end -}}
{{- end -}}

{{- define "psfn.spiffeAgent" -}}
{{- if .Values.fleet.enabled -}}
{{- printf "spiffe://%s/psfn/agent/fleet" .Values.certificates.trustDomain -}}
{{- else -}}
{{- printf "spiffe://%s/psfn/agent/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
{{- end -}}
{{- end -}}

{{- define "psfn.spiffeFleetAgent" -}}
{{- printf "spiffe://%s/psfn/agent/%s" .root.Values.certificates.trustDomain .companionId -}}
{{- end -}}

{{- define "psfn.spiffeGarden" -}}
{{- if .Values.fleet.enabled -}}
{{- printf "spiffe://%s/psfn/garden/fleet" .Values.certificates.trustDomain -}}
{{- else -}}
{{- printf "spiffe://%s/psfn/garden/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
{{- end -}}
{{- end -}}

{{- define "psfn.spiffeSatelliteHub" -}}
{{- printf "spiffe://%s/psfn/satellite-hub/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
{{- end -}}

{{- define "psfn.sharedWorkspaceVolumeMount" -}}
- name: runtime
  mountPath: {{ printf "%s/workspaces/shared" .Values.fleet.runtimeRoot }}
  subPath: workspaces-shared
{{- end -}}

{{- define "psfn.sharedWorkspaceBootstrapInitContainer" -}}
- name: bootstrap-shared-workspace
  image: {{ include "psfn.image" (dict "root" . "image" .Values.workloads.agent.image) | quote }}
  imagePullPolicy: {{ .Values.psfnAppImage.pullPolicy }}
  command:
    - sh
    - -c
    - |
      set -eu
      mkdir -p /bootstrap/runtime/workspaces-shared
  securityContext:
    {{- include "psfn.appReadOnlySecurityContext" . | nindent 4 }}
  volumeMounts:
    - name: runtime
      mountPath: /bootstrap/runtime
      readOnly: false
{{- end -}}

{{- define "psfn.helmBackupImageEnv" -}}
- name: PSFN_HELM_BACKUP_AGENT_IMAGE_REPOSITORY
  value: {{ default .Values.psfnAppImage.repository .Values.workloads.agent.image.repository | quote }}
- name: PSFN_HELM_BACKUP_AGENT_IMAGE_TAG
  value: {{ default .Values.psfnAppImage.tag .Values.workloads.agent.image.tag | quote }}
- name: PSFN_HELM_BACKUP_AGENT_IMAGE_DIGEST
  value: {{ default .Values.psfnAppImage.digest .Values.workloads.agent.image.digest | quote }}
- name: PSFN_HELM_BACKUP_GATEWAY_IMAGE_REPOSITORY
  value: {{ default .Values.psfnAppImage.repository .Values.workloads.gateway.image.repository | quote }}
- name: PSFN_HELM_BACKUP_GATEWAY_IMAGE_TAG
  value: {{ default .Values.psfnAppImage.tag .Values.workloads.gateway.image.tag | quote }}
- name: PSFN_HELM_BACKUP_GATEWAY_IMAGE_DIGEST
  value: {{ default .Values.psfnAppImage.digest .Values.workloads.gateway.image.digest | quote }}
- name: PSFN_HELM_BACKUP_GARDEN_IMAGE_REPOSITORY
  value: {{ default .Values.psfnAppImage.repository .Values.workloads.garden.image.repository | quote }}
- name: PSFN_HELM_BACKUP_GARDEN_IMAGE_TAG
  value: {{ default .Values.psfnAppImage.tag .Values.workloads.garden.image.tag | quote }}
- name: PSFN_HELM_BACKUP_GARDEN_IMAGE_DIGEST
  value: {{ default .Values.psfnAppImage.digest .Values.workloads.garden.image.digest | quote }}
{{- end -}}

{{- define "psfn.certIssuerName" -}}
{{- if .Values.certificates.issuer.existingIssuerRef.name -}}
{{- .Values.certificates.issuer.existingIssuerRef.name -}}
{{- else if .Values.certificates.issuer.name -}}
{{- .Values.certificates.issuer.name -}}
{{- else -}}
{{- printf "%s-ca" (include "psfn.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "psfn.certIssuerRef" -}}
name: {{ include "psfn.certIssuerName" . }}
{{- if .Values.certificates.issuer.existingIssuerRef.name }}
kind: {{ .Values.certificates.issuer.existingIssuerRef.kind }}
group: {{ .Values.certificates.issuer.existingIssuerRef.group }}
{{- else }}
kind: {{ .Values.certificates.issuer.kind }}
group: cert-manager.io
{{- end }}
{{- end -}}

{{- define "psfn.caSecretName" -}}
{{- printf "%s-ca-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gatewayRpcCertSecretName" -}}
{{- printf "%s-gateway-rpc-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.agentRpcClientCertSecretName" -}}
{{- printf "%s-agent-rpc-client-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.agentAdminCertSecretName" -}}
{{- printf "%s-agent-admin-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.fleetAgentRpcClientCertSecretName" -}}
{{- printf "%s-agent-rpc-client-%s-tls" (include "psfn.fullname" .root) .companionId -}}
{{- end -}}

{{- define "psfn.fleetAgentAdminCertSecretName" -}}
{{- printf "%s-agent-admin-%s-tls" (include "psfn.fullname" .root) .companionId -}}
{{- end -}}

{{- define "psfn.gardenAdminClientCertSecretName" -}}
{{- printf "%s-garden-admin-client-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gardenSsoServerCertSecretName" -}}
{{- printf "%s-garden-sso-server-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gatewaySsoClientCertSecretName" -}}
{{- printf "%s-gateway-sso-client-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gardenSsoServerName" -}}
{{- printf "%s.%s.svc" (include "psfn.gardenServiceName" .) .Release.Namespace -}}
{{- end -}}

{{- define "psfn.satelliteHubClientCertSecretName" -}}
{{- printf "%s-satellite-hub-client-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.gatewayApiBaseUrl" -}}
{{- printf "http://%s:%v/v1" (include "psfn.gatewayApiServiceName" .) .Values.ports.gatewayApi -}}
{{- end -}}

{{- /* Comma-separated API_SATELLITE_KEYS list: the dedicated hub key plus any
       extra per-satellite keys. Blank segments from stray commas are dropped;
       weak/duplicate keys still fail closed at gateway startup
       (validateSatelliteApiKeys). */ -}}
{{- define "psfn.satelliteApiKeysValue" -}}
{{- $keys := list -}}
{{- with .Values.secrets.values.satelliteHubApiKey -}}
{{- $keys = append $keys (trim .) -}}
{{- end -}}
{{- range splitList "," (.Values.secrets.values.extraSatelliteApiKeys | default "") -}}
{{- $entry := trim . -}}
{{- if $entry -}}
{{- $keys = append $keys $entry -}}
{{- end -}}
{{- end -}}
{{- join "," $keys -}}
{{- end -}}

{{- define "psfn.databaseUrlSecretName" -}}
{{- if .Values.postgres.external.enabled -}}
{{- required "postgres.external.databaseUrlSecret.name is required when postgres.external.enabled=true" .Values.postgres.external.databaseUrlSecret.name -}}
{{- else -}}
{{- include "psfn.postgresSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "psfn.databaseUrlSecretKey" -}}
{{- $fleetKey := "" -}}
{{- if .Values.fleet.enabled -}}
{{- $fleetKey = include "psfn.fleetCompanionDatabaseUrlSecretKey" . -}}
{{- end -}}
{{- if $fleetKey -}}
{{- $fleetKey -}}
{{- else if .Values.postgres.external.enabled -}}
{{- default "postgres-database-url" .Values.postgres.external.databaseUrlSecret.key -}}
{{- else -}}
{{- .Values.postgres.auth.keys.databaseUrl -}}
{{- end -}}
{{- end -}}

{{- define "psfn.redisPasswordSecretName" -}}
{{- if eq .Values.redis.mode "external" -}}
{{- required "redis.external.passwordSecret.name is required when redis.mode=external" .Values.redis.external.passwordSecret.name -}}
{{- else -}}
{{- include "psfn.redisSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "psfn.redisPasswordSecretKey" -}}
{{- if eq .Values.redis.mode "external" -}}
{{- default "redis-password" .Values.redis.external.passwordSecret.key -}}
{{- else -}}
{{- .Values.redis.auth.key -}}
{{- end -}}
{{- end -}}

{{- define "psfn.commonEnv" -}}
- name: TZ
  value: {{ required "runtime.timezone is required (IANA name, e.g. America/New_York)" .Values.runtime.timezone | quote }}
- name: NODE_ENV
  value: {{ .Values.runtime.nodeEnv | quote }}
- name: PSFN_RUNTIME_MODE
  value: {{ .Values.runtime.mode | quote }}
- name: PSFN_RUNTIME_LAYOUT_MODE
  value: {{ .Values.runtime.layoutMode | quote }}
{{- if .Values.fleet.enabled }}
{{- /* Topology is derived from the mandatory companions.json manifest entry
       count (>1 => multi-companion), never an env flag. The retired
       PSFN_MULTI_COMPANION variable is intentionally not set. */}}
- name: PSFN_RUNTIME_ROOT
  value: {{ .Values.fleet.runtimeRoot | quote }}
- name: COMPANION_PG_SCHEMA
  value: {{ include "psfn.fleetCompanionPostgresSchema" . | quote }}
{{- else }}
- name: PSFN_RUNTIME_ROOT
  value: {{ .Values.fleet.runtimeRoot | quote }}
- name: COMPANION_PG_SCHEMA
  value: {{ .Values.runtime.postgresSchema | quote }}
{{- end }}
- name: COMPANION_ID
  value: {{ .Values.runtime.companionId | quote }}
- name: SYSTEM_DATA_DIR
  value: {{ .Values.runtime.systemDataDir | quote }}
- name: COMPANION_DATA_DIR
  value: {{ .Values.runtime.companionDataDir | quote }}
- name: WORKSPACE_PATH
  value: {{ .Values.runtime.workspacePath | quote }}
- name: PSFN_LOGS_DIR
  value: {{ .Values.runtime.logsDir | quote }}
- name: PSFN_TEMP_DIR
  value: {{ .Values.runtime.tempDir | quote }}
- name: BACKUP_ROOT_DIR
  value: {{ .Values.runtime.backupsDir | quote }}
- name: PSFN_BACKUP_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.backupEncryptionKey }}
- name: CONFIG_DIR
  value: {{ .Values.runtime.configDir | quote }}
- name: CHARACTER_CARD_PATH
  value: {{ .Values.runtime.characterCardPath | quote }}
- name: PERSISTENCE_BACKEND
  value: postgres
{{- if .Values.fleetAuth.enabled }}
- name: PSFN_FLEET_AUTH
  value: "true"
{{- end }}
{{- if .Values.fleetAuth.testingHarnessGardenVerifierEnabled }}
- name: PSFN_TESTING_HARNESS_GARDEN_VERIFIER
  value: "true"
{{- end }}
{{- if .Values.repositoryCheckout.enabled }}
- name: GIT_REPO_ROOT
  value: {{ .Values.repositoryCheckout.mountPath | quote }}
{{- end }}
{{- if ne .Values.beads.toolsEnabled nil }}
- name: BEADS_TOOLS_ENABLED
  value: {{ .Values.beads.toolsEnabled | quote }}
{{- end }}
{{- /* bd's embedded dolt needs a writable global config root; $HOME resolves
       under the read-only /app image. Harmless when beads is unused. */}}
- name: DOLT_ROOT_PATH
  value: {{ printf "%s/.dolt" .Values.runtime.workspacePath | quote }}
{{- if .Values.beads.allowActions }}
- name: BEADS_ALLOW_ACTIONS
  value: {{ join "," .Values.beads.allowActions | quote }}
{{- end }}
{{- /* Deployment provenance for companion self-diagnosis (self_status diagnose).
       Every value here must be STABLE across helm operations. `.Release.Revision`
       is not (it increments on every operation by definition), so it is
       deliberately absent: baking it in changed the pod template hash on every
       upgrade and force-restarted the companion even when the upgrade shipped
       only a sidecar image (psfn-framework-6187t). It was also stale by
       construction — a pod that does not restart keeps reporting the revision it
       was created at. The live revision is resolved on demand from Helm's own
       release history instead (src/system/lifecycle/kube-helm-revision.ts). */}}
- name: PSFN_KUBERNETES_BACKUP_ENABLED
  value: "true"
- name: PSFN_HELM_CHART_DIR
  value: "/app/deploy/helm/psfn"
- name: PSFN_HELM_RELEASE_NAME
  value: {{ .Release.Name | quote }}
- name: PSFN_HELM_NAMESPACE
  value: {{ .Release.Namespace | quote }}
- name: PSFN_IMAGE_TAG
  value: {{ .Values.psfnAppImage.tag | quote }}
- name: PSFN_HELM_CHART_NAME
  value: {{ .Chart.Name | quote }}
- name: PSFN_HELM_CHART_VERSION
  value: {{ .Chart.Version | quote }}
- name: PSFN_HELM_APP_VERSION
  value: {{ .Chart.AppVersion | quote }}
- name: PSFN_HELM_CHART_CONTENT_SHA256
  value: {{ required "recovery-chart.sha256 must contain the recovery chart digest" (.Files.Get "recovery-chart.sha256" | trim) | quote }}
- name: PSFN_GIT_COMMIT
  value: {{ .Values.psfnAppImage.gitCommit | default "" | quote }}
- name: PSFN_PREVIOUS_GIT_COMMIT
  value: {{ .Values.psfnAppImage.previousGitCommit | default "" | quote }}
- name: PSFN_REPOSITORY_DIR
  value: {{ ternary .Values.repositoryCheckout.mountPath (.Values.runtime.repositoryDir | default "") .Values.repositoryCheckout.enabled | quote }}
{{- end -}}

{{- define "psfn.fleetGardenEnv" -}}
- name: TZ
  value: {{ required "runtime.timezone is required (IANA name, e.g. America/New_York)" .Values.runtime.timezone | quote }}
- name: NODE_ENV
  value: {{ .Values.runtime.nodeEnv | quote }}
- name: PSFN_RUNTIME_MODE
  value: {{ .Values.runtime.mode | quote }}
- name: PSFN_RUNTIME_LAYOUT_MODE
  value: {{ .Values.runtime.layoutMode | quote }}
{{- /* Fleet topology is derived from the companions.json manifest, not the
       retired PSFN_MULTI_COMPANION flag. */}}
- name: PSFN_FLEET_AUTH
  value: "true"
{{- if .Values.fleetAuth.testingHarnessGardenVerifierEnabled }}
- name: PSFN_TESTING_HARNESS_GARDEN_VERIFIER
  value: "true"
{{- end }}
- name: PSFN_RUNTIME_ROOT
  value: {{ .Values.fleet.runtimeRoot | quote }}
- name: COMPANION_PG_SCHEMA
  value: {{ include "psfn.fleetCompanionPostgresSchema" . | quote }}
- name: COMPANION_ID
  value: {{ .Values.runtime.companionId | quote }}
- name: SYSTEM_DATA_DIR
  value: {{ .Values.runtime.systemDataDir | quote }}
- name: COMPANION_DATA_DIR
  value: {{ .Values.runtime.companionDataDir | quote }}
- name: WORKSPACE_PATH
  value: {{ .Values.runtime.workspacePath | quote }}
- name: PSFN_LOGS_DIR
  value: {{ .Values.runtime.logsDir | quote }}
- name: PSFN_TEMP_DIR
  value: {{ .Values.runtime.tempDir | quote }}
- name: BACKUP_ROOT_DIR
  value: {{ .Values.runtime.backupsDir | quote }}
- name: CONFIG_DIR
  value: {{ .Values.runtime.configDir | quote }}
- name: CHARACTER_CARD_PATH
  value: {{ .Values.runtime.characterCardPath | quote }}
- name: PERSISTENCE_BACKEND
  value: postgres
{{- end -}}

{{/*
Fleet Auth credential env for the gateway process. fleet-auth.json references
every credential as { kind: env, envName: FLEET_AUTH_* }; the runtime fails
closed at startup when a referenced env var is unset, so the chart must be
able to supply each one. Entries are validated in validations.yaml: an
uppercase env name plus exactly one of a Secret reference or a plain value.
*/}}
{{- define "psfn.fleetAuthCredentialEnv" -}}
{{- range .Values.fleetAuth.credentialEnv }}
- name: {{ .name }}
{{- if .secretRef }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretRef.name }}
      key: {{ .secretRef.key }}
{{- else }}
  value: {{ .value | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "psfn.postgresDatabaseUrlEnv" -}}
- name: POSTGRES_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.databaseUrlSecretName" . }}
      key: {{ include "psfn.databaseUrlSecretKey" . }}
{{- end -}}

{{- define "psfn.runtimeDatabaseCredentialEnv" -}}
{{- include "psfn.postgresDatabaseUrlEnv" . }}
- name: COMPANION_MAIN_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.postgresSecretName" . }}
      key: {{ .Values.runtimeBootstrap.keys.companionDatabaseUrl }}
- name: SHARED_SCHEMA_MIGRATION_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.postgresSecretName" . }}
      key: {{ .Values.runtimeBootstrap.keys.sharedMigrationDatabaseUrl }}
{{- end -}}

{{- define "psfn.postgresDatabaseUrlFileEnv" -}}
- name: POSTGRES_DATABASE_URL_FILE
  value: "/var/run/secrets/psfn-postgres/database-url"
{{- end -}}

{{- define "psfn.operatorAlertEnv" -}}
{{- if .Values.operatorAlertSink.enabled }}
- name: NTFY_BASE_URL
  value: {{ printf "http://%s-operator-alert-sink:%v" (include "psfn.fullname" .) .Values.operatorAlertSink.port | quote }}
- name: NTFY_TOPIC
  value: {{ .Values.operatorAlertSink.topic | quote }}
{{- else if and .Values.ntfy.baseUrl .Values.ntfy.topic }}
- name: NTFY_BASE_URL
  value: {{ .Values.ntfy.baseUrl | quote }}
- name: NTFY_TOPIC
  value: {{ .Values.ntfy.topic | quote }}
{{- end }}
{{- end -}}

{{- define "psfn.providerSecretEnv" -}}
- name: API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.apiKey }}
      optional: true
- name: TESTING_HARNESS_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.testingHarnessApiKey }}
      optional: true
{{- if not .Values.fleetAuth.enabled }}
- name: ADMIN_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.adminToken }}
      optional: true
{{- end }}
- name: OPENROUTER_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.openRouterApiKey }}
      optional: true
- name: {{ .Values.provider.envName }}
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.providerApiKey }}
      optional: true
- name: OPENAI_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.openAiApiKey }}
      optional: true
- name: EMBEDDING_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.embeddingApiKey }}
      optional: true
- name: HF_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.hfToken }}
      optional: true
- name: DISCORD_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.discordToken }}
      optional: true
- name: DISCORD_BOT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.discordBotId }}
      optional: true
- name: DEEPGRAM_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.deepgramApiKey }}
      optional: true
- name: ELEVENLABS_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.elevenLabsApiKey }}
      optional: true
- name: FAL_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.falApiKey }}
      optional: true
- name: NTFY_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.ntfyToken }}
      optional: true
{{- end -}}

{{/*
BEGIN GENERATED PER-COMPANION OWNER FILES
Source of truth: src/system/config/settings-contract.ts PER_COMPANION_OWNER_FILES.
Checked by scripts/verify-helm-owner-file-registry.ts; do not edit independently.
*/}}
{{- define "psfn.perCompanionOwnerFilePattern" -}}
capability-tier.json|scheduler.json|charge-policy.json|skills.json|partner-affect-shadow.json
{{- end -}}
{{/* END GENERATED PER-COMPANION OWNER FILES */}}

{{- define "psfn.seedInitContainer" -}}
- name: seed-runtime-files
  image: {{ include "psfn.image" (dict "root" . "image" .Values.workloads.agent.image) | quote }}
  imagePullPolicy: {{ .Values.psfnAppImage.pullPolicy }}
  command:
    - sh
    - -c
    - |
      set -eu
      mkdir -p \
        {{ .Values.runtime.systemDataDir }} \
        {{ .Values.runtime.companionDataDir }} \
        {{ .Values.runtime.companionDataDir }}/state \
        {{ .Values.runtime.companionDataDir }}/observer-eval-sidecar \
        {{ .Values.runtime.workspacePath }} \
        {{ .Values.runtime.logsDir }} \
        {{ .Values.runtime.tempDir }} \
        {{ .Values.runtime.backupsDir }} \
        {{ .Values.runtime.modelCacheDir }}

      {{- if .Values.ownerFiles.existingConfigMap }}
      # Import only absent owner files. Once a file reaches its PVC, that PVC
      # remains authoritative across upgrades and Garden changes.
      for src in /bootstrap-owner/*; do
        [ -f "$src" ] || continue
        owner_file="$(basename "$src")"
        case "$owner_file" in
          {{ include "psfn.perCompanionOwnerFilePattern" . }}|companion.json)
            target_root={{ .Values.runtime.companionDataDir | quote }}
            ;;
          *)
            target_root={{ .Values.runtime.systemDataDir | quote }}
            ;;
        esac
        target="$target_root/$owner_file"
        if [ ! -e "$target" ]; then
          cp "$src" "$target"
          chmod 0600 "$target"
        fi
      done
      {{- end }}

      # Every PSFN deployment is a fleet of one or more companions enumerated by
      # the mandatory system-owned companions.json manifest. Topology is derived
      # from the manifest entry count (no retired PSFN_MULTI_COMPANION flag), so
      # runtime startup (load-config) fails closed without it.
      companions_manifest="{{ .Values.runtime.systemDataDir }}/companions.json"
      # Fail closed: the chart never synthesizes or overwrites the roster.
      if [ ! -f "$companions_manifest" ] || [ -L "$companions_manifest" ]; then
        echo "Missing required fleet manifest: $companions_manifest. Provision companions.json with one entry per companion (including a fleet of one)." >&2
        exit 1
      fi

      migration_dir="{{ .Values.runtime.companionDataDir }}/.owner-migrations"
      mkdir -p "$migration_dir"

      record_owner_migration() {
        legacy="$1"
        marker="$2"
        legacy_hash="$(sha256sum "$legacy" | cut -d ' ' -f1)"
        marker_tmp="$(mktemp "${marker}.tmp.XXXXXX")"
        printf '%s\n' "$legacy_hash" > "$marker_tmp"
        chmod 0600 "$marker_tmp"
        mv -f "$marker_tmp" "$marker"
      }

      migrate_per_companion_owner() {
        base="$1"
        legacy="{{ .Values.runtime.systemDataDir }}/${base}.json"
        target="{{ .Values.runtime.companionDataDir }}/${base}.json"
        marker="${migration_dir}/${base}.json.from-system.sha256"

        if [ -L "$legacy" ] || { [ -e "$legacy" ] && [ ! -f "$legacy" ]; }; then
          echo "Legacy owner path is not a regular file: $legacy" >&2
          exit 1
        fi
        if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
          echo "Per-companion owner path is not a regular file: $target" >&2
          exit 1
        fi
        if [ -L "$marker" ] || { [ -e "$marker" ] && [ ! -f "$marker" ]; }; then
          echo "Owner migration marker path is not a regular file: $marker" >&2
          exit 1
        fi

        if [ -f "$marker" ]; then
          if [ ! -f "$target" ]; then
            echo "Owner migration marker exists but target is missing: $target" >&2
            exit 1
          fi
          if [ -f "$legacy" ]; then
            recorded_hash="$(tr -d '\r\n' < "$marker")"
            legacy_hash="$(sha256sum "$legacy" | cut -d ' ' -f1)"
            if [ "$recorded_hash" != "$legacy_hash" ]; then
              echo "Legacy owner changed after migration: $legacy" >&2
              exit 1
            fi
          fi
          return
        fi

        if [ -f "$target" ]; then
          if [ -f "$legacy" ]; then
            if ! cmp -s "$legacy" "$target"; then
              echo "Refusing ambiguous per-companion owner migration: $legacy and $target differ" >&2
              exit 1
            fi
            record_owner_migration "$legacy" "$marker"
          fi
          return
        fi

        if [ -f "$legacy" ]; then
          target_tmp="$(mktemp "${target}.tmp.XXXXXX")"
          cp "$legacy" "$target_tmp"
          cmp -s "$legacy" "$target_tmp"
          chmod 0600 "$target_tmp"
          mv -f "$target_tmp" "$target"
          record_owner_migration "$legacy" "$marker"
        fi
      }

      # capability-tier.json and scheduler.json became per-companion owner files.
      # Existing single-companion releases have authoritative legacy copies under
      # system-data; migrate those bytes exactly once before runtime startup.
      for base in scheduler capability-tier; do
        migrate_per_companion_owner "$base"
      done

      {{- if .Values.bootstrap.seedOwnerFiles }}
      # bootstrap.seedOwnerFiles opt-in: seed missing owner files on a
      # first-ever install ONLY. Runtime config must not seed itself
      # (src/system/config/load-or-seed.ts); with this disabled, absent owner
      # files fail closed at startup via loadRequiredJson.
      for src in {{ .Values.runtime.configDir }}/*.seed.json; do
        [ -e "$src" ] || continue
        base="$(basename "$src")"
        owner_file="${base%.seed.json}.json"
        case "$owner_file" in
          {{ include "psfn.perCompanionOwnerFilePattern" . }})
            target_root={{ .Values.runtime.companionDataDir | quote }}
            ;;
          *)
            target_root={{ .Values.runtime.systemDataDir | quote }}
            ;;
        esac
        target="$target_root/$owner_file"
        if [ ! -e "$target" ]; then
          cp "$src" "$target"
        fi
      done
      {{- end }}
      for owner_file in {{ include "psfn.perCompanionOwnerFilePattern" . | replace "|" " " }}; do
        target="{{ .Values.runtime.companionDataDir }}/${owner_file}"
        if [ ! -f "$target" ] || [ -L "$target" ]; then
          echo "Missing required per-companion owner file after bootstrap/migration: $target" >&2
          exit 1
        fi
      done
      # The owner-root cutover and scheduler schema cutover landed separately.
      # Run the canonical validated/atomic migrator after routing the file into
      # companion-data and before any runtime process loads it.
      if ! scheduler_migration_output="$(node /app/dist/migrate-scheduler-owner.js \
        --apply \
        --data-dir {{ .Values.runtime.companionDataDir }} 2>&1)"; then
        printf '%s\n' "$scheduler_migration_output" >&2
        case "$scheduler_migration_output" in
          *"changed identity; refusing pathname-based recovery"*|*"changed while migration was prepared"*)
            echo "Scheduler owner changed during a concurrent workload init; re-validating the published owner once" >&2
            node /app/dist/migrate-scheduler-owner.js \
              --apply \
              --data-dir {{ .Values.runtime.companionDataDir }}
            ;;
          *)
            exit 1
            ;;
        esac
      else
        printf '%s\n' "$scheduler_migration_output"
      fi
      if ! settings_migration_output="$(node /app/dist/migrate-required-settings-blocks.js \
        --apply \
        --data-dir {{ .Values.runtime.systemDataDir }} 2>&1)"; then
        printf '%s\n' "$settings_migration_output" >&2
        case "$settings_migration_output" in
          *"changed identity; refusing pathname-based recovery"*|*"changed while migration was prepared"*)
            echo "Settings owner changed during a concurrent workload init; re-validating the published owner once" >&2
            node /app/dist/migrate-required-settings-blocks.js \
              --apply \
              --data-dir {{ .Values.runtime.systemDataDir }}
            ;;
          *)
            exit 1
            ;;
        esac
      else
        printf '%s\n' "$settings_migration_output"
      fi
      if [ ! -e {{ .Values.runtime.characterCardPath }} ] && [ -e /seed/companion.json ]; then
        cp /seed/companion.json {{ .Values.runtime.characterCardPath }}
      fi
  securityContext:
    {{- include "psfn.appReadOnlySecurityContext" . | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
    {{- if .Values.ownerFiles.existingConfigMap }}
    - name: bootstrap-owner-files
      mountPath: /bootstrap-owner
      readOnly: true
    {{- end }}
    - name: system-data
      mountPath: {{ .Values.runtime.systemDataDir }}
    - name: companion-data
      mountPath: {{ .Values.runtime.companionDataDir }}
    - name: workspace
      mountPath: {{ .Values.runtime.workspacePath }}
    {{- include "psfn.sharedWorkspaceVolumeMount" . | nindent 4 }}
    - name: runtime
      mountPath: {{ .Values.runtime.logsDir }}
      subPath: logs
    - name: runtime
      mountPath: {{ .Values.runtime.tempDir }}
      subPath: tmp
    - name: runtime
      mountPath: {{ .Values.runtime.backupsDir }}
      subPath: backups
    {{- if .Values.persistence.modelCache.enabled }}
    - name: model-cache
      mountPath: {{ .Values.runtime.modelCacheDir }}
    {{- end }}
    {{- if .Values.identity.seedStarterCard }}
    - name: identity-seed
      mountPath: /seed
      readOnly: true
    {{- end }}
{{- end -}}

{{- define "psfn.waitForPostgresInitContainer" -}}
{{- $root := .root -}}
- name: wait-for-postgres
  image: {{ include "psfn.image" (dict "root" $root "image" .image) | quote }}
  imagePullPolicy: {{ default $root.Values.psfnAppImage.pullPolicy .image.pullPolicy }}
  command:
    - sh
    - -c
    - |
      set -eu
      for attempt in $(seq 1 60); do
        if pg_isready -d "$(cat "$POSTGRES_DATABASE_URL_FILE")"; then
          exit 0
        fi
        sleep 2
      done
      pg_isready -d "$(cat "$POSTGRES_DATABASE_URL_FILE")"
  env:
    {{- include "psfn.postgresDatabaseUrlFileEnv" $root | nindent 4 }}
  volumeMounts:
    - name: postgres-database-url
      mountPath: /var/run/secrets/psfn-postgres
      readOnly: true
  securityContext:
    {{- include "psfn.appReadOnlySecurityContext" $root | nindent 4 }}
{{- end -}}

{{- define "psfn.runtimeBootstrapInitContainer" -}}
{{- if .Values.runtimeBootstrap.enabled }}
- name: bootstrap-runtime-tenancy
  image: {{ include "psfn.image" (dict "root" . "image" .Values.workloads.gateway.image) | quote }}
  imagePullPolicy: {{ .Values.psfnAppImage.pullPolicy }}
  command:
    - sh
    - -ceu
    - |
      until pg_isready -d "$POSTGRES_ADMIN_DATABASE_URL"; do sleep 2; done
      node /app/scripts/ops/psfn-compose-bootstrap.mjs
  securityContext:
    {{- toYaml .Values.securityContext | nindent 4 }}
  env:
    - name: NODE_ENV
      value: {{ .Values.runtime.nodeEnv | quote }}
    - name: PSFN_RUNTIME_ROOT
      value: {{ .Values.fleet.runtimeRoot | quote }}
    - name: SYSTEM_DATA_DIR
      value: {{ .Values.runtime.systemDataDir | quote }}
    - name: COMPANION_DATA_DIR
      value: {{ .Values.runtime.companionDataDir | quote }}
    - name: WORKSPACE_PATH
      value: {{ .Values.runtime.workspacePath | quote }}
    - name: COMPANION_ID
      value: {{ .Values.runtime.companionId | quote }}
    - name: PSFN_RUNTIME_UID
      value: {{ .Values.securityContext.runAsUser | quote }}
    - name: PSFN_RUNTIME_GID
      value: {{ .Values.securityContext.runAsGroup | quote }}
    - name: PSFN_COMPANION_DATABASE_CONNECTION_LIMIT
      value: "80"
    - name: PSFN_AGENT_AUTH_DIR
      value: /bootstrap-runtime/agent-auth
    - name: GATEWAY_SOCKET
      value: /bootstrap-runtime/run/gateway.sock
    - name: POSTGRES_ADMIN_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.postgresSecretName" . }}
          key: {{ .Values.runtimeBootstrap.keys.adminDatabaseUrl }}
    - name: COMPANION_MAIN_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.postgresSecretName" . }}
          key: {{ .Values.runtimeBootstrap.keys.companionDatabaseUrl }}
    - name: SHARED_SCHEMA_MIGRATION_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.postgresSecretName" . }}
          key: {{ .Values.runtimeBootstrap.keys.sharedMigrationDatabaseUrl }}
    - name: PSFN_COMPANION_DATABASE_PASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.postgresSecretName" . }}
          key: {{ .Values.runtimeBootstrap.keys.companionRoleKey }}
    - name: PSFN_SHARED_MIGRATION_DATABASE_PASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.postgresSecretName" . }}
          key: {{ .Values.runtimeBootstrap.keys.sharedMigrationRoleKey }}
    - name: GATEWAY_SESSION_HMAC_KEY
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.appSecretName" . }}
          key: {{ .Values.secrets.keys.gatewaySessionHmacKey }}
    - name: PSFN_BACKUP_ENCRYPTION_KEY
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.appSecretName" . }}
          key: {{ .Values.secrets.keys.backupEncryptionKey }}
  volumeMounts:
    - name: system-data
      mountPath: {{ .Values.runtime.systemDataDir }}
    - name: companion-data
      mountPath: {{ .Values.runtime.companionDataDir }}
    - name: workspace
      mountPath: {{ .Values.runtime.workspacePath }}
    - name: runtime
      mountPath: /bootstrap-runtime
{{- end }}
{{- end -}}

{{- define "psfn.fleetAuthAuthorityFloorInitContainer" -}}
{{- if .Values.fleetAuth.enabled }}
- name: prepare-fleet-auth-authority-floor
  image: {{ include "psfn.image" (dict "root" . "image" .Values.workloads.gateway.image) | quote }}
  imagePullPolicy: {{ default .Values.psfnAppImage.pullPolicy .Values.workloads.gateway.image.pullPolicy }}
  command:
    - sh
    - -c
    - |
      set -eu
      floor_root={{ include "psfn.fleetAuthAuthorityFloorMountPath" . | quote }}
      chown 999:999 "$floor_root"
      chmod 0700 "$floor_root"
      case "$(stat -c '%u:%g:%a' "$floor_root")" in 999:999:700|999:999:2700) ;; *) echo "floor perms unexpected: $(stat -c '%u:%g:%a' "$floor_root")" >&2; exit 1 ;; esac
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    runAsNonRoot: false
    runAsUser: 0
    runAsGroup: 0
    capabilities:
      # Drop every ambient capability, then grant only CHOWN to transfer
      # ownership and FOWNER to tighten the mode after that transfer.
      drop:
        - ALL
      add:
        - CHOWN
        - FOWNER
  volumeMounts:
    - name: fleet-auth-authority-floor
      mountPath: {{ include "psfn.fleetAuthAuthorityFloorMountPath" . }}
{{- end }}
{{- end -}}

{{/*
Container securityContext for first-party PSFN app-image containers (agent,
gateway, Garden and their seed/wait init containers) and the pin-verified
emo_sim image. It is the shared
.Values.securityContext with
readOnlyRootFilesystem forced on. The /app image is built read-only by design
(see the "read-only /app image" note in psfn.commonEnv: every writable runtime
path — system-data, companion-data, workspace, logs, temp, backups, the Dolt
config root and an ephemeral /tmp emptyDir — is an explicit mount), so these
containers run with an immutable root filesystem. Third-party/opt-in surfaces
(postgres, redis, satellite-hub, companion-ui-test) intentionally keep the
base context and are hardened separately; they must not silently inherit a
read-only root without per-image validation. deepCopy protects .Values from
Sprig merge mutation.
*/}}
{{- define "psfn.appReadOnlySecurityContext" -}}
{{- toYaml (merge (dict "readOnlyRootFilesystem" true) (deepCopy .Values.securityContext)) -}}
{{- end -}}

{{- define "psfn.commonVolumes" -}}
- name: system-data
  persistentVolumeClaim:
    claimName: {{ include "psfn.systemDataClaimName" . }}
- name: companion-data
  persistentVolumeClaim:
    claimName: {{ include "psfn.companionDataClaimName" . }}
- name: workspace
  persistentVolumeClaim:
    claimName: {{ include "psfn.workspaceClaimName" . }}
- name: postgres-database-url
  secret:
    secretName: {{ include "psfn.databaseUrlSecretName" . }}
    items:
      - key: {{ include "psfn.databaseUrlSecretKey" . }}
        path: database-url
- name: runtime
  persistentVolumeClaim:
    claimName: {{ include "psfn.runtimeClaimName" . }}
{{- /* Ephemeral writable /tmp so the read-only root filesystem never blocks
       os.tmpdir()/mktemp writes. Real runtime temp still lives on the runtime
       PVC via PSFN_TEMP_DIR; this only backs incidental /tmp usage. */}}
- name: tmp
  emptyDir: {}
{{- if .Values.ownerFiles.existingConfigMap }}
- name: bootstrap-owner-files
  configMap:
    name: {{ .Values.ownerFiles.existingConfigMap | quote }}
{{- end }}
{{- if .Values.persistence.modelCache.enabled }}
- name: model-cache
  persistentVolumeClaim:
    claimName: {{ include "psfn.modelCacheClaimName" . }}
{{- end }}
{{- if .Values.identity.seedStarterCard }}
- name: identity-seed
  configMap:
    name: {{ include "psfn.fullname" . }}-identity-seed
{{- end }}
{{- if .Values.repositoryCheckout.enabled }}
- name: repository-checkout
  {{- if .Values.repositoryCheckout.hostPath.path }}
  hostPath:
    path: {{ .Values.repositoryCheckout.hostPath.path | quote }}
    type: {{ default "Directory" .Values.repositoryCheckout.hostPath.type | quote }}
  {{- else }}
  persistentVolumeClaim:
    claimName: {{ .Values.repositoryCheckout.persistentVolumeClaim.claimName | quote }}
  {{- end }}
{{- end }}
{{- end -}}

{{- define "psfn.repositoryCheckoutVolumeMount" -}}
{{- if .Values.repositoryCheckout.enabled }}
- name: repository-checkout
  mountPath: {{ .Values.repositoryCheckout.mountPath | quote }}
  readOnly: {{ .Values.repositoryCheckout.readOnly }}
{{- end }}
{{- end -}}
