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

{{- define "psfn.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "psfn.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
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

{{- define "psfn.postgresImage" -}}
{{- $image := .Values.postgres.image -}}
{{- printf "%s:%s@%s" $image.repository $image.tag $image.digest -}}
{{- end -}}

{{- define "psfn.redisImage" -}}
{{- $image := .Values.redis.image -}}
{{- printf "%s:%s@%s" $image.repository $image.tag $image.digest -}}
{{- end -}}

{{- define "psfn.liteLlmImage" -}}
{{- $image := .Values.liteLlm.image -}}
{{- $repository := required "liteLlm.image.repository is required when liteLlm.enabled=true and liteLlm.mode=internal" $image.repository -}}
{{- $tag := default "" $image.tag -}}
{{- $digest := default "" $image.digest -}}
{{- if and (not $tag) (not $digest) -}}
{{- fail "liteLlm.image.tag or liteLlm.image.digest is required when liteLlm.enabled=true and liteLlm.mode=internal" -}}
{{- end -}}
{{- if and $tag (or (eq $tag "latest") (eq $tag "main") (eq $tag "main-latest")) -}}
{{- fail "liteLlm.image.tag must be pinned and must not be latest/main/main-latest" -}}
{{- end -}}
{{- if and $digest (not (hasPrefix "sha256:" $digest)) -}}
{{- fail "liteLlm.image.digest must start with sha256:" -}}
{{- end -}}
{{- if and $tag $digest -}}
{{- printf "%s:%s@%s" $repository $tag $digest -}}
{{- else if $digest -}}
{{- printf "%s@%s" $repository $digest -}}
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
{{- printf "%s-agent-admin" (include "psfn.fullname" .) -}}
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

{{- define "psfn.liteLlmServiceName" -}}
{{- printf "%s-litellm" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.liteLlmConfigMapName" -}}
{{- if .Values.liteLlm.config.existingConfigMap -}}
{{- .Values.liteLlm.config.existingConfigMap -}}
{{- else -}}
{{- printf "%s-litellm-config" (include "psfn.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "psfn.satelliteHubServiceName" -}}
{{- printf "%s-satellite-hub" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.liteLlmBaseUrl" -}}
{{- if and .Values.liteLlm.enabled (eq .Values.liteLlm.mode "internal") -}}
{{- printf "http://%s.%s.svc:%v/v1" (include "psfn.liteLlmServiceName" .) .Release.Namespace .Values.ports.liteLlm -}}
{{- else if and .Values.liteLlm.enabled (eq .Values.liteLlm.mode "external") -}}
{{- required "liteLlm.external.baseUrl is required when liteLlm.mode=external" .Values.liteLlm.external.baseUrl -}}
{{- end -}}
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
{{- printf "spiffe://%s/psfn/gateway/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
{{- end -}}

{{- define "psfn.spiffeAgent" -}}
{{- printf "spiffe://%s/psfn/agent/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
{{- end -}}

{{- define "psfn.spiffeGarden" -}}
{{- printf "spiffe://%s/psfn/garden/%s" .Values.certificates.trustDomain .Values.runtime.companionId -}}
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

{{- define "psfn.gardenAdminClientCertSecretName" -}}
{{- printf "%s-garden-admin-client-tls" (include "psfn.fullname" .) -}}
{{- end -}}

{{- define "psfn.databaseUrlSecretName" -}}
{{- if .Values.postgres.external.enabled -}}
{{- required "postgres.external.databaseUrlSecret.name is required when postgres.external.enabled=true" .Values.postgres.external.databaseUrlSecret.name -}}
{{- else -}}
{{- include "psfn.postgresSecretName" . -}}
{{- end -}}
{{- end -}}

{{- define "psfn.databaseUrlSecretKey" -}}
{{- if .Values.postgres.external.enabled -}}
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
- name: NODE_ENV
  value: {{ .Values.runtime.nodeEnv | quote }}
- name: PSFN_RUNTIME_MODE
  value: {{ .Values.runtime.mode | quote }}
- name: PSFN_RUNTIME_LAYOUT_MODE
  value: {{ .Values.runtime.layoutMode | quote }}
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
- name: POSTGRES_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.databaseUrlSecretName" . }}
      key: {{ include "psfn.databaseUrlSecretKey" . }}
{{- if .Values.repositoryCheckout.enabled }}
- name: GIT_REPO_ROOT
  value: {{ .Values.repositoryCheckout.mountPath | quote }}
{{- end }}
{{- if ne .Values.beads.toolsEnabled nil }}
- name: BEADS_TOOLS_ENABLED
  value: {{ .Values.beads.toolsEnabled | quote }}
{{- end }}
{{- if .Values.beads.allowActions }}
- name: BEADS_ALLOW_ACTIONS
  value: {{ join "," .Values.beads.allowActions | quote }}
{{- end }}
{{- /* Deployment provenance for companion self-diagnosis (self_status diagnose). */}}
- name: PSFN_IMAGE_TAG
  value: {{ .Values.psfnAppImage.tag | quote }}
- name: PSFN_HELM_REVISION
  value: {{ .Release.Revision | quote }}
- name: PSFN_GIT_COMMIT
  value: {{ .Values.psfnAppImage.gitCommit | default "" | quote }}
- name: PSFN_PREVIOUS_GIT_COMMIT
  value: {{ .Values.psfnAppImage.previousGitCommit | default "" | quote }}
- name: PSFN_REPOSITORY_DIR
  value: {{ ternary .Values.repositoryCheckout.mountPath (.Values.runtime.repositoryDir | default "") .Values.repositoryCheckout.enabled | quote }}
{{- end -}}

{{- define "psfn.providerSecretEnv" -}}
- name: API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.apiKey }}
      optional: true
- name: ADMIN_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.adminToken }}
      optional: true
- name: OPENROUTER_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.openRouterApiKey }}
      optional: true
- name: OPENAI_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.openAiApiKey }}
      optional: true
- name: LITELLM_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "psfn.appSecretName" . }}
      key: {{ .Values.secrets.keys.liteLlmApiKey }}
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
        {{ .Values.runtime.workspacePath }} \
        {{ .Values.runtime.logsDir }} \
        {{ .Values.runtime.tempDir }} \
        {{ .Values.runtime.backupsDir }} \
        {{ .Values.runtime.modelCacheDir }}
      {{- if .Values.bootstrap.seedOwnerFiles }}
      # bootstrap.seedOwnerFiles opt-in: seed missing owner files on a
      # first-ever install ONLY. Runtime config must not seed itself
      # (src/system/config/load-or-seed.ts); with this disabled, absent owner
      # files fail closed at startup via loadRequiredJson.
      for src in {{ .Values.runtime.configDir }}/*.seed.json; do
        [ -e "$src" ] || continue
        base="$(basename "$src")"
        target="{{ .Values.runtime.systemDataDir }}/${base%.seed.json}.json"
        if [ ! -e "$target" ]; then
          cp "$src" "$target"
        fi
      done
      {{- end }}
      if [ ! -e {{ .Values.runtime.characterCardPath }} ] && [ -e /seed/companion.json ]; then
        cp /seed/companion.json {{ .Values.runtime.characterCardPath }}
      fi
  securityContext:
    {{- toYaml .Values.securityContext | nindent 4 }}
  volumeMounts:
    - name: system-data
      mountPath: {{ .Values.runtime.systemDataDir }}
    - name: companion-data
      mountPath: {{ .Values.runtime.companionDataDir }}
    - name: workspace
      mountPath: {{ .Values.runtime.workspacePath }}
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
        if pg_isready -d "$POSTGRES_DATABASE_URL"; then
          exit 0
        fi
        sleep 2
      done
      pg_isready -d "$POSTGRES_DATABASE_URL"
  env:
    - name: POSTGRES_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: {{ include "psfn.databaseUrlSecretName" $root }}
          key: {{ include "psfn.databaseUrlSecretKey" $root }}
  securityContext:
    {{- toYaml $root.Values.securityContext | nindent 4 }}
{{- end -}}

{{- define "psfn.commonVolumes" -}}
- name: system-data
  persistentVolumeClaim:
    claimName: {{ include "psfn.fullname" . }}-system-data
- name: companion-data
  persistentVolumeClaim:
    claimName: {{ include "psfn.fullname" . }}-companion-data
- name: workspace
  persistentVolumeClaim:
    claimName: {{ include "psfn.fullname" . }}-workspace
- name: runtime
  persistentVolumeClaim:
    claimName: {{ include "psfn.fullname" . }}-runtime
{{- if .Values.persistence.modelCache.enabled }}
- name: model-cache
  persistentVolumeClaim:
    claimName: {{ include "psfn.fullname" . }}-model-cache
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
