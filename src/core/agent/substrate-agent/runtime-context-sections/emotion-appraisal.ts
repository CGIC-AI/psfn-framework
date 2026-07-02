// ── Emotion-appraisal section producer (E2.6) ──
// The runtime_emotion_appraisal_* variable group: the latest appraisal entry
// plus the recent-appraisal lines rendered from the declared appraisal chain.

import type { EmotionAppraisalEntry } from '../../../emotion/appraisal.js';
import { formatActiveDateTimeLabel } from '../../../../shared/time/active-timezone.js';
import { compactPromptText } from './section-format.js';

function formatEmotionAppraisalLines(
  emotionAppraisalChain: readonly EmotionAppraisalEntry[],
): string[] {
  return emotionAppraisalChain
    .slice(-2)
    .map(entry => (
      `- ${formatActiveDateTimeLabel(new Date(entry.timestamp))} (${entry.trigger}): ${compactPromptText(entry.summary, 220)}`
    ));
}

export function buildEmotionAppraisalPromptVariables(
  emotionAppraisalChain: readonly EmotionAppraisalEntry[],
): Record<string, string> {
  const latestEntry = emotionAppraisalChain.at(-1);
  const recentLines = formatEmotionAppraisalLines(emotionAppraisalChain);
  const latestTimestamp = latestEntry ? new Date(latestEntry.timestamp) : null;
  const latestTimestampIso = latestTimestamp && Number.isFinite(latestTimestamp.getTime())
    ? latestTimestamp.toISOString()
    : '';

  return {
    runtime_emotion_appraisal_length: String(emotionAppraisalChain.length),
    runtime_emotion_appraisal_latest_trigger: latestEntry?.trigger ?? '',
    runtime_emotion_appraisal_latest_summary: latestEntry ? compactPromptText(latestEntry.summary, 220) : '',
    runtime_emotion_appraisal_latest_timestamp_iso: latestTimestampIso,
    runtime_emotion_appraisal_recent_lines: recentLines.join('\n'),
  };
}
