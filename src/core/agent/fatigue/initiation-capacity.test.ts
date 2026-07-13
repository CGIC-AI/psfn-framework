import { describe, expect, it, vi } from "vitest";

import { makeTestChargePolicyConfig } from "../../../test-support/charge-policy.js";
import type { IcpInitiationCapacityPolicyInput } from "../../../boundary/gateway/icp-initiation-policy-authority.js";
import { IcpFatigueInitiationCapacityAuthority } from "./initiation-capacity.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function input(): IcpInitiationCapacityPolicyInput {
  return {
    senderCompanionId: A,
    candidate: {
      candidateId: "11111111-1111-4111-8111-111111111111",
      rootInitiationId: "22222222-2222-4222-8222-222222222222",
      localCompanionId: A,
      peerContactId: "contact-b",
      peerCompanionId: B,
      preferredChannel: "dm",
      source: "foreground",
      provenanceRef: "icp-prov:33333333-3333-4333-8333-333333333333",
      createdAtMs: 1_000,
      expiresAtMs: 100_000,
      status: "pending",
      revision: 1,
    },
    channelId: `companion-dm:${A}:${B}`,
    nowMs: 10_000,
    senderRelationship: {
      trustLevel: "primary",
      relationshipType: "ai_companion",
    },
    peerRelationship: {
      trustLevel: "primary",
      relationshipType: "ai_companion",
    },
  };
}

describe("IcpFatigueInitiationCapacityAuthority", () => {
  it("derives soft and hard initiation gates from decaying relationship pressure", async () => {
    const policy = makeTestChargePolicyConfig();
    policy.fatigue.relationshipBudgets.trusted_collaborator_mi = {
      softTarget: 4,
      hardCap: 6,
    };
    const readInitiationPressure = vi
      .fn()
      .mockResolvedValueOnce({ relationshipPressure: 3.01 })
      .mockResolvedValueOnce({ relationshipPressure: 5.01 });
    const authority = new IcpFatigueInitiationCapacityAuthority(
      { readInitiationPressure },
      policy,
    );

    await expect(authority.resolve(input())).resolves.toEqual({
      socialPressureAllows: false,
      chargeAllows: true,
      fatigueAllows: true,
      costAllows: false,
    });
    await expect(authority.resolve(input())).resolves.toEqual({
      socialPressureAllows: false,
      chargeAllows: true,
      fatigueAllows: false,
      costAllows: false,
    });
    expect(readInitiationPressure).toHaveBeenCalledWith(
      expect.objectContaining({
        localCompanionId: A,
        peerCompanionId: B,
        declinedPressureUnits:
          policy.fatigue.socialRegulation.declinedPressureUnits,
        unansweredAfterMs: policy.fatigue.socialRegulation.unansweredInitiationAfterMs,
      }),
    );
  });

  it("fails the social-charge gate closed when its owned lane cannot pay one continuation", async () => {
    const policy = makeTestChargePolicyConfig();
    policy.runChargeQuotaByLane.companion_social = 0;
    const authority = new IcpFatigueInitiationCapacityAuthority(
      {
        readInitiationPressure: async () => ({
          relationshipPressure: 0,
          chargedPressure: 0,
          declinedPressure: 0,
          deferredPressure: 0,
          unansweredPressure: 0,
          contributingReservationCount: 0,
          contributingEpisodeCount: 0,
        }),
      },
      policy,
    );

    await expect(authority.resolve(input())).resolves.toMatchObject({
      socialPressureAllows: true,
      chargeAllows: false,
      fatigueAllows: true,
      costAllows: false,
    });
  });
});
