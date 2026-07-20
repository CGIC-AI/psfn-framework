<script lang="ts">
  import { setContext } from 'svelte';
  import SettingFieldLabel from '$lib/components/settings/SettingFieldLabel.svelte';
  import SettingsCollapsibleSection from '$lib/components/settings/SettingsCollapsibleSection.svelte';
  import DurationInput from '$lib/components/settings/DurationInput.svelte';
  import { settingsSimpleSectionAnchorId } from '$lib/components/settings/navigation';
  import {
    SETTINGS_FIELD_ERRORS_CONTEXT,
    normalizeDiscordListenWindowSeconds,
    settingControlId,
    settingLabelId,
    type SettingsFieldErrorsAccessor,
  } from './settings-page-helpers';

  let {
    openSections,
    inputClass,
    labelClass,
    toggleClass,
    fieldErrors,
    toggleSection,
    ttsProvider = $bindable('disabled'),
    sttProvider = $bindable('disabled'),
    voiceId = $bindable(''),
    deepgramModel = $bindable(''),
    echoTtsUrl = $bindable(''),
    echoTtsVoice = $bindable(''),
    echoTtsPreset = $bindable(''),
    obsidianVaultName = $bindable(''),
    obsidianCliPath = $bindable('obsidian'),
    obsidianAutoPublish = $bindable(false),
    obsidianTimeoutMs = $bindable(10000),
    discordTriggerWords = $bindable(''),
    discordTriggerReactions = $bindable('👆'),
    discordTriggerListenWindowSeconds = $bindable(120),
    telegramEnabled = $bindable(false),
    telegramAuthorizedUsers = $bindable(''),
  } = $props<{
    openSections: Set<string>;
    inputClass: string;
    labelClass: string;
    toggleClass: string;
    fieldErrors: SettingsFieldErrorsAccessor;
    toggleSection: (id: string) => void;
    ttsProvider: string;
    sttProvider: string;
    voiceId: string;
    deepgramModel: string;
    echoTtsUrl: string;
    echoTtsVoice: string;
    echoTtsPreset: string;
    obsidianVaultName: string;
    obsidianCliPath: string;
    obsidianAutoPublish: boolean;
    obsidianTimeoutMs: number;
    discordTriggerWords: string;
    discordTriggerReactions: string;
    discordTriggerListenWindowSeconds: number;
    telegramEnabled: boolean;
    telegramAuthorizedUsers: string;
  }>();

  // Publish the validation-error accessor to descendant SettingFieldLabels so
  // curated controls render their field's errors inline (ybm3).
  setContext<SettingsFieldErrorsAccessor>(SETTINGS_FIELD_ERRORS_CONTEXT, (key) => fieldErrors(key));
</script>

<section
  id={settingsSimpleSectionAnchorId('integrations-voice')}
  data-settings-section="integrations-voice"
>
  <SettingsCollapsibleSection
    title="Voice & TTS"
    open={openSections.has('voice')}
    onToggle={() => toggleSection('voice')}
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">TTS: {ttsProvider}, STT: {sttProvider}</span>
    {/snippet}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div>
        <SettingFieldLabel label="TTS Provider" keys="ttsProvider" forId={settingControlId('ttsProvider')} class={labelClass} />
        <input id={settingControlId('ttsProvider')} type="text" bind:value={ttsProvider} list="tts-provider-list" class={inputClass} placeholder="disabled or provider id" />
        <p class="text-sm text-shadow-500 mt-1">Registered provider ids from the backend registry are suggested, and any current provider id is preserved and sent back unchanged.</p>
      </div>
      <div>
        <SettingFieldLabel label="STT Provider" keys="sttProvider" forId={settingControlId('sttProvider')} class={labelClass} />
        <input id={settingControlId('sttProvider')} type="text" bind:value={sttProvider} list="stt-provider-list" class={inputClass} placeholder="disabled or provider id" />
        <p class="text-sm text-shadow-500 mt-1">Registered provider ids from the backend registry are suggested, and plugin ids are preserved instead of being coerced to disabled.</p>
      </div>
      <div>
        <SettingFieldLabel label="ElevenLabs Voice ID" keys="voiceId" forId={settingControlId('voiceId')} class={labelClass} />
        <input id={settingControlId('voiceId')} type="text" bind:value={voiceId} class={inputClass} placeholder="your-voice-id" />
        <p class="text-sm text-shadow-500 mt-1">Leave blank to clear persisted voice override.</p>
      </div>
      <div>
        <SettingFieldLabel label="Deepgram Model" keys="deepgramModel" forId={settingControlId('deepgramModel')} class={labelClass} />
        <input id={settingControlId('deepgramModel')} type="text" bind:value={deepgramModel} class={inputClass} placeholder="Deepgram model id" />
        <p class="text-sm text-shadow-500 mt-1">Leave blank to clear persisted model override.</p>
      </div>
      <div>
        <SettingFieldLabel label="Echo TTS URL" keys="echoTtsUrl" forId={settingControlId('echoTtsUrl')} class={labelClass} />
        <input id={settingControlId('echoTtsUrl')} type="text" bind:value={echoTtsUrl} class={inputClass} placeholder="http://127.0.0.1:8001/v1/audio/speech" />
      </div>
      <div>
        <SettingFieldLabel label="Echo TTS Voice" keys="echoTtsVoice" forId={settingControlId('echoTtsVoice')} class={labelClass} />
        <input id={settingControlId('echoTtsVoice')} type="text" bind:value={echoTtsVoice} class={inputClass} placeholder="11labs-Allison" />
      </div>
      <div class="md:col-span-2">
        <SettingFieldLabel label="Echo TTS Preset" keys="echoTtsPreset" forId={settingControlId('echoTtsPreset')} class={labelClass} />
        <input id={settingControlId('echoTtsPreset')} type="text" bind:value={echoTtsPreset} class={inputClass} placeholder="Independent-High-Speaker-CFG" />
      </div>
    </div>
    <div class="mt-4 bg-bark-100 rounded-lg p-4 border border-bark-200">
      <p class="text-sm text-shadow-700">
        Secrets and API credentials stay server-side in environment variables. Provider changes are applied at runtime wiring points and may require restart for active voice sessions.
      </p>
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="text-sm">
          <span class="font-medium text-shadow-800">ElevenLabs credentials:</span>
          <span class="text-shadow-600 ml-1 font-mono">ELEVENLABS_API_KEY</span>
        </div>
        <div class="text-sm">
          <span class="font-medium text-shadow-800">Deepgram credentials:</span>
          <span class="text-shadow-600 ml-1 font-mono">DEEPGRAM_API_KEY</span>
        </div>
      </div>
    </div>
  </SettingsCollapsibleSection>
</section>

<section
  id={settingsSimpleSectionAnchorId('integrations-obsidian')}
  data-settings-section="integrations-obsidian"
>
  <SettingsCollapsibleSection
    title="External Obsidian Bridge"
    open={openSections.has('obsidian')}
    onToggle={() => toggleSection('obsidian')}
    bodyClass="px-5 py-4 space-y-4 border-t border-bark-200"
  >
    {#snippet summary()}
      <span class="text-xs text-shadow-600">{obsidianVaultName ? `External vault: ${obsidianVaultName}` : 'Disabled'}</span>
    {/snippet}
    <div>
      <SettingFieldLabel
        label="External Vault Name"
        keys="obsidianVaultName"
        forId="obsidianVaultName"
        class="block text-xs font-semibold text-shadow-700 mb-1"
      />
      <input type="text" id="obsidianVaultName" class="input-garden w-full" bind:value={obsidianVaultName} placeholder="e.g. companion" />
      <p class="text-xs text-shadow-500 mt-0.5">Leave empty to disable the external bridge. Canonical durable notes belong in Wiki.</p>
    </div>
    <div>
      <SettingFieldLabel
        label="CLI Path"
        keys="obsidianCliPath"
        forId="obsidianCliPath"
        class="block text-xs font-semibold text-shadow-700 mb-1"
      />
      <input type="text" id="obsidianCliPath" class="input-garden w-full" bind:value={obsidianCliPath} placeholder="obsidian" />
      <p class="text-xs text-shadow-500 mt-0.5">Path to the Obsidian CLI binary for the external bridge. Default: obsidian</p>
    </div>
    <div class="flex items-center gap-3">
      <input type="checkbox" id="obsidianAutoPublish" class="rounded border-bark-400" bind:checked={obsidianAutoPublish} />
      <label class="text-xs font-semibold text-shadow-700" for="obsidianAutoPublish">
        Auto-publish reflections to external vault
        <code class="ml-1.5 rounded-md border border-bark-200 bg-bark-100 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-shadow-600">obsidianAutoPublish</code>
      </label>
    </div>
    <div>
      <SettingFieldLabel
        label="CLI Timeout"
        keys="obsidianTimeoutMs"
        forId="obsidianTimeoutMs"
        class="block text-xs font-semibold text-shadow-700 mb-1"
      />
      <DurationInput id="obsidianTimeoutMs" min={1000} max={30000} bind:value={obsidianTimeoutMs} />
      <p class="text-xs text-shadow-500 mt-0.5">Timeout for CLI commands (1000-30000ms)</p>
    </div>
  </SettingsCollapsibleSection>
</section>

<section
  id={settingsSimpleSectionAnchorId('channels')}
  data-settings-section="channels"
>
  <SettingsCollapsibleSection
    title="Channels"
    open={openSections.has('channels')}
    onToggle={() => toggleSection('channels')}
    bodyClass="px-5 pb-5 border-t border-bark-300 pt-4 space-y-4"
  >
    {#snippet summary()}
      <span class="text-sm text-shadow-500">
        {discordTriggerListenWindowSeconds}s listen window, {telegramEnabled ? 'Telegram on' : 'Telegram off'}
      </span>
    {/snippet}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
      <div class="md:col-span-2">
        <SettingFieldLabel label="Discord Trigger Words" keys="discordTriggerWords" forId={settingControlId('discordTriggerWords')} class={labelClass} />
        <input id={settingControlId('discordTriggerWords')} type="text" bind:value={discordTriggerWords} class={inputClass} placeholder="pixie, hey companion" />
        <p class="text-sm text-shadow-500 mt-1">
          Comma-separated words or phrases that trigger replies in guild channels.
        </p>
      </div>
      <div class="md:col-span-2">
        <SettingFieldLabel label="Discord Trigger Reactions" keys="discordTriggerReactions" forId={settingControlId('discordTriggerReactions')} class={labelClass} />
        <input id={settingControlId('discordTriggerReactions')} type="text" bind:value={discordTriggerReactions} class={inputClass} placeholder="👆, 🔥, 👀" />
        <p class="text-sm text-shadow-500 mt-1">
          Comma-separated emoji reactions that open a Discord follow-up window.
        </p>
      </div>
      <div>
        <SettingFieldLabel label="Discord Listen Window (seconds)" keys="discordTriggerListenWindowMs" forId={settingControlId('discordTriggerListenWindowMs')} class={labelClass} />
        <input
          id={settingControlId('discordTriggerListenWindowMs')}
          type="number"
          min="10"
          max="600"
          step="1"
          value={discordTriggerListenWindowSeconds}
          onchange={(e) => {
            discordTriggerListenWindowSeconds = normalizeDiscordListenWindowSeconds(
              Number((e.target as HTMLInputElement).value),
            );
          }}
          class={inputClass}
        />
        <p class="text-sm text-shadow-500 mt-1">
          After a trigger, accept follow-up Discord messages for this long (10-600s). Saved as milliseconds.
        </p>
      </div>
      <div>
        <SettingFieldLabel label="Telegram Enabled" keys="telegramEnabled" labelId={settingLabelId('telegramEnabled')} class={labelClass} />
        <label class="flex items-center gap-2 mt-2 cursor-pointer">
          <input id={settingControlId('telegramEnabled')} aria-labelledby={settingLabelId('telegramEnabled')} type="checkbox" bind:checked={telegramEnabled} class={toggleClass} />
          <span class="text-sm text-shadow-700">Enable Telegram channel bridge</span>
        </label>
      </div>
      <div class="md:col-span-2">
        <SettingFieldLabel label="Telegram Authorized Accounts" keys="telegramAuthorizedUsers" forId={settingControlId('telegramAuthorizedUsers')} class={labelClass} />
        <input id={settingControlId('telegramAuthorizedUsers')} type="text" bind:value={telegramAuthorizedUsers} class={inputClass} placeholder="12345678, 87654321" />
        <p class="text-sm text-shadow-500 mt-1">Comma-separated Telegram account IDs allowed to interact.</p>
      </div>
    </div>
    <div class="bg-bark-100 rounded-lg p-4 border border-bark-200">
      <p class="text-sm text-shadow-700">
        Channel bindings (ports, tokens, host addresses) are security-sensitive settings configured at the server level.
        Trigger behavior is saved here, while host/token bindings are set at startup and may require restart to change.
      </p>
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="text-sm">
          <span class="font-medium text-shadow-800">Discord:</span>
          <span class="text-shadow-600 ml-1 font-mono">DISCORD_TOKEN, DISCORD_BOT_ID, channels.json:discord.heartbeatChannelId</span>
        </div>
        <div class="text-sm">
          <span class="font-medium text-shadow-800">OpenAI API:</span>
          <span class="text-shadow-600 ml-1 font-mono">API_PORT, API_HOST, API_KEY</span>
        </div>
        <div class="text-sm">
          <span class="font-medium text-shadow-800">Admin GUI:</span>
          <span class="text-shadow-600 ml-1 font-mono">ADMIN_PORT, ADMIN_HOST, ADMIN_TOKEN</span>
        </div>
      </div>
    </div>
  </SettingsCollapsibleSection>
</section>
