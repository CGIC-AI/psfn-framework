import { onCompanionScopeChange } from '$lib/fleet/companion-scope';
import type {
  JournalPrivacyDisclosure,
  JournalPrivacyStream,
} from '$lib/api/endpoints/values';

const disclosures = new Map<JournalPrivacyStream, JournalPrivacyDisclosure>();

onCompanionScopeChange(() => {
  disclosures.clear();
});

export function rememberJournalDisclosure(disclosure: JournalPrivacyDisclosure): void {
  disclosures.set(disclosure.stream, disclosure);
}

export function getJournalDisclosure(
  stream: 'values-journal',
): Extract<JournalPrivacyDisclosure, { stream: 'values-journal' }> | undefined;
export function getJournalDisclosure(
  stream: 'reflection-metacognition',
): Extract<JournalPrivacyDisclosure, { stream: 'reflection-metacognition' }> | undefined;
export function getJournalDisclosure(
  stream: 'reflection-daily',
): Extract<JournalPrivacyDisclosure, { stream: 'reflection-daily' }> | undefined;
export function getJournalDisclosure(
  stream: 'reflection-journal',
): Extract<JournalPrivacyDisclosure, { stream: 'reflection-journal' }> | undefined;
export function getJournalDisclosure(
  stream: JournalPrivacyStream,
): JournalPrivacyDisclosure | undefined;
export function getJournalDisclosure(stream: JournalPrivacyStream): JournalPrivacyDisclosure | undefined {
  return disclosures.get(stream);
}

export function clearJournalDisclosures(): void {
  disclosures.clear();
}
