import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import { isRecord } from '../../shared/utils/types.js';
import { FleetAuthBrokerError } from './fleet-auth-errors.js';

const DISCORD_GUILDS_URL = 'https://discord.com/api/v10/users/@me/guilds?limit=200';
const DISCORD_SNOWFLAKE = /^[1-9][0-9]{16,19}$/u;

/** Collects bounded current-user guild and role evidence from the OAuth provider. */
export class DiscordOAuthMembershipEvidenceCollector {
  private readonly mappedGuildIds: string[];

  constructor(
    config: FleetAuthConfig,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => Date,
  ) {
    this.mappedGuildIds = [...new Set(
      config.discordEvidenceMappings.map(mapping => mapping.guildId),
    )].sort();
  }

  async collect(accessToken: string, providerSubjectId: string): Promise<unknown> {
    const observedAt = this.now().toISOString();
    if (this.mappedGuildIds.length === 0) {
      return {
        status: 'observed',
        providerSubjectId,
        observedAt,
        guilds: [],
      };
    }
    let guildsResponse: Response;
    try {
      guildsResponse = await this.fetchImpl(DISCORD_GUILDS_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: 'error',
      });
    } catch {
      return { status: 'provider_unavailable' };
    }
    if (!guildsResponse.ok) return { status: 'provider_unavailable' };
    let decodedGuilds: unknown;
    try {
      decodedGuilds = await guildsResponse.json();
    } catch {
      return { status: 'provider_unavailable' };
    }
    if (!Array.isArray(decodedGuilds) || decodedGuilds.length > 200) {
      return { status: 'provider_unavailable' };
    }
    const consentedGuildIds = new Set<string>();
    for (const guild of decodedGuilds) {
      if (!isRecord(guild) || typeof guild.id !== 'string' || !DISCORD_SNOWFLAKE.test(guild.id)) {
        return { status: 'provider_unavailable' };
      }
      consentedGuildIds.add(guild.id);
    }
    const guilds: Array<{ guildId: string; roleIds: string[] }> = [];
    for (const guildId of this.mappedGuildIds) {
      if (!consentedGuildIds.has(guildId)) continue;
      let memberResponse: Response;
      try {
        memberResponse = await this.fetchImpl(
          `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            redirect: 'error',
          },
        );
      } catch {
        return { status: 'provider_unavailable' };
      }
      if (memberResponse.status === 404) continue;
      if (!memberResponse.ok) return { status: 'provider_unavailable' };
      let decodedMember: unknown;
      try {
        decodedMember = await memberResponse.json();
      } catch {
        return { status: 'provider_unavailable' };
      }
      if (!isRecord(decodedMember) || !Array.isArray(decodedMember.roles)
        || decodedMember.roles.length > 250
        || !isRecord(decodedMember.user)
        || decodedMember.user.id !== providerSubjectId) {
        return { status: 'provider_unavailable' };
      }
      const roleIds = decodedMember.roles.map((roleId) => {
        if (typeof roleId !== 'string' || !DISCORD_SNOWFLAKE.test(roleId)) {
          throw new FleetAuthBrokerError(
            'malformed_provider_response',
            502,
            'Discord guild membership response was malformed',
          );
        }
        return roleId;
      }).sort();
      if (new Set(roleIds).size !== roleIds.length) return { status: 'provider_unavailable' };
      guilds.push({ guildId, roleIds });
    }
    return {
      status: 'observed',
      providerSubjectId,
      observedAt,
      guilds,
    };
  }
}
