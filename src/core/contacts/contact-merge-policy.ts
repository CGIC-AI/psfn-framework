export const MIXED_INTELLIGENCE_CONTACT_MERGE_ERROR =
  'Cannot merge human and machine-intelligence contacts';

export function haveCompatibleContactIntelligenceKinds(
  sourceIsMachineIntelligence: boolean | null | undefined,
  targetIsMachineIntelligence: boolean | null | undefined,
): boolean {
  return Boolean(sourceIsMachineIntelligence) === Boolean(targetIsMachineIntelligence);
}
