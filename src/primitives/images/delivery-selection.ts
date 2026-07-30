import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import { extractTextContent } from '../llm/conversion.js';
import type { ImageGenerationResult, ImageResultAsset } from './types.js';

export const GENERATED_IMAGE_ATTACHMENT_LIMIT = 4;

interface GeneratedImageResultForDelivery {
  message: {
    toolName: string;
    toolCallId?: string;
  };
  result: ImageGenerationResult;
}

function latestAssistantReplyText(turnMessages: readonly AgentMessage[]): string {
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const message = turnMessages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== 'assistant') continue;
    const text = extractTextContent(Array.isArray(message.content) ? message.content : undefined);
    if (text) return text;
  }
  return '';
}

function isFileNameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9._-]/u.test(value);
}

function replyReferencesFileName(replyText: string, fileName: string): boolean {
  let offset = replyText.indexOf(fileName);
  while (offset >= 0) {
    const before = offset > 0 ? replyText[offset - 1] : undefined;
    const afterOffset = offset + fileName.length;
    const after = afterOffset < replyText.length ? replyText[afterOffset] : undefined;
    if (!isFileNameCharacter(before) && !isFileNameCharacter(after)) {
      return true;
    }
    offset = replyText.indexOf(fileName, offset + 1);
  }
  return false;
}

function flattenAssets(
  imageResults: readonly GeneratedImageResultForDelivery[],
): ImageResultAsset[] {
  return imageResults.flatMap(entry => entry.result.images);
}

function selectReferencedAssets(
  imageResults: readonly GeneratedImageResultForDelivery[],
  replyText: string,
): ImageResultAsset[] {
  if (!replyText) return [];

  const latestAssetByFileName = new Map<string, ImageResultAsset>();
  for (const asset of flattenAssets(imageResults)) {
    const fileName = asset.fileName?.trim();
    if (fileName) latestAssetByFileName.set(fileName, asset);
  }
  const referenced = new Set(
    [...latestAssetByFileName.keys()]
      .filter(fileName => replyReferencesFileName(replyText, fileName)),
  );
  if (referenced.size === 0) return [];

  return flattenAssets(imageResults).filter((asset) => {
    const fileName = asset.fileName?.trim();
    return Boolean(
      fileName
      && referenced.has(fileName)
      && latestAssetByFileName.get(fileName) === asset,
    );
  });
}

function selectLatestResultPerTool(
  imageResults: readonly GeneratedImageResultForDelivery[],
): ImageResultAsset[] {
  const latestResultByTool = new Map<string, GeneratedImageResultForDelivery>();
  for (const entry of imageResults) {
    latestResultByTool.set(entry.message.toolName, entry);
  }
  return imageResults
    .filter(entry => latestResultByTool.get(entry.message.toolName) === entry)
    .flatMap(entry => entry.result.images);
}

export function selectGeneratedImageAssetsForDelivery(params: {
  imageResults: readonly GeneratedImageResultForDelivery[];
  turnMessages: readonly AgentMessage[];
}): ReadonlySet<ImageResultAsset> {
  const replyText = latestAssistantReplyText(params.turnMessages);
  const referencedAssets = selectReferencedAssets(params.imageResults, replyText);
  const selectedAssets = referencedAssets.length > 0
    ? referencedAssets
    : selectLatestResultPerTool(params.imageResults);
  return new Set(selectedAssets.slice(0, GENERATED_IMAGE_ATTACHMENT_LIMIT));
}
