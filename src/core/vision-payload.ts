export const BROWSER_SCREENSHOT_EVIDENCE_MESSAGE = 'Browser screenshot evidence from the preceding tool result. Inspect these pixels now and keep using the latest image for each browser tab through the rest of this tool turn; the full-resolution saved owner path is in that tool result.';

const DEFAULT_ACTIVE_IMAGE_CHARS = 4_000_000;

export interface ToolImageEvidence {
  dataUrl: string;
  evidenceKey: string;
  source: 'browser_screenshot';
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
}

export interface VisionMessage {
  role: string;
  content?: string | null;
  images?: string[];
  visionEvidenceKey?: string;
  visionEvidenceSource?: ToolImageEvidence['source'];
  [key: string]: unknown;
}

export interface VisionContextReceipt {
  activeImageCount: number;
  activeImageChars: number;
  supersededKeys: string[];
  evictedKeys: string[];
}

export function imageDataUrlChars(messages: VisionMessage[]): number {
  return messages.reduce((sum, message) =>
    sum + (message.images ?? []).reduce((imageSum, image) => imageSum + String(image).length, 0), 0);
}

/**
 * Add tool-produced visual evidence while keeping the live turn bounded.
 *
 * - A newer screenshot supersedes an older screenshot from the same tab.
 * - Different tabs may coexist for cross-source/comparison work.
 * - Owner attachment messages are counted against the budget but never removed.
 * - When over budget, the oldest tool screenshot is evicted first; the newest
 *   screenshot always survives close/follow-up actions until a newer capture.
 */
export function appendToolImageEvidence(
  messages: VisionMessage[],
  evidence: ToolImageEvidence[],
  maximumImageChars = Number(process.env.BOTBOY_ACTIVE_VISION_CHARS || DEFAULT_ACTIVE_IMAGE_CHARS),
): VisionContextReceipt {
  const supersededKeys: string[] = [];
  const evictedKeys: string[] = [];
  const addedMessages: VisionMessage[] = [];

  for (const item of evidence) {
    for (const message of messages) {
      if (message.visionEvidenceKey !== item.evidenceKey || !message.images?.length) continue;
      delete message.images;
      message.content = `Browser screenshot ${item.evidenceKey} was superseded by a newer capture. The full-resolution saved path remains in its preceding tool receipt.`;
      supersededKeys.push(item.evidenceKey);
    }
    const message: VisionMessage = {
      role: 'user',
      content: BROWSER_SCREENSHOT_EVIDENCE_MESSAGE,
      images: [item.dataUrl],
      visionEvidenceKey: item.evidenceKey,
      visionEvidenceSource: item.source,
    };
    messages.push(message);
    addedMessages.push(message);
  }

  const boundedMaximum = Number.isFinite(maximumImageChars) && maximumImageChars > 0
    ? Math.floor(maximumImageChars)
    : DEFAULT_ACTIVE_IMAGE_CHARS;
  const removable = () => messages.filter(message =>
    message.visionEvidenceSource === 'browser_screenshot' &&
    message.images?.length &&
    !addedMessages.includes(message));

  while (imageDataUrlChars(messages) > boundedMaximum) {
    const oldest = removable()[0];
    if (!oldest) break;
    delete oldest.images;
    oldest.content = `Browser screenshot ${oldest.visionEvidenceKey ?? 'evidence'} was evicted from model context to stay within the visual payload budget. Its saved file path remains in the preceding tool receipt.`;
    if (oldest.visionEvidenceKey) evictedKeys.push(oldest.visionEvidenceKey);
  }

  return {
    activeImageCount: messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0),
    activeImageChars: imageDataUrlChars(messages),
    supersededKeys,
    evictedKeys,
  };
}

export interface PayloadRecoveryReceipt {
  rejectedBodyBytes: number;
  reportedMaximumBytes: number;
  removedImageCount: number;
  removedImageChars: number;
  removedOwnerImageCount: number;
  removedEvidenceKeys: string[];
  recoveryMessage: string;
}

interface PayloadRejectionLike {
  code?: string;
  source?: 'local' | 'remote';
  maximumBytes?: number;
  size?: {
    bodyBytes?: number;
    imageCount?: number;
    imageChars?: number;
  };
}

/**
 * Rebuild a rejected live turn as an image-free continuation.
 *
 * This is deliberately mechanical: preserve the owner request, assistant/tool
 * protocol, opaque provider output, and every textual receipt; remove only
 * inline pixels; then tell the model exactly what happened and how to resume.
 * The LLM client separately proves the final wire body has zero images and is
 * strictly smaller than the rejected request before any network effect.
 */
export function prepareImageFreePayloadRecovery(
  messages: VisionMessage[],
  error: unknown,
): PayloadRecoveryReceipt | null {
  const rejection = error as PayloadRejectionLike;
  if (rejection?.code !== 'LLM_PAYLOAD_TOO_LARGE') return null;

  const rejectedBodyBytes = Number(rejection.size?.bodyBytes ?? 0);
  const reportedMaximumBytes = Number(rejection.maximumBytes ?? 0);
  if (!Number.isFinite(rejectedBodyBytes) || rejectedBodyBytes <= 0) return null;

  let removedImageCount = 0;
  let removedImageChars = 0;
  let removedOwnerImageCount = 0;
  const removedEvidenceKeys: string[] = [];

  const candidate = messages.map(message => {
    if (!message.images?.length) return message;
    const clone: VisionMessage = { ...message };
    const images = message.images.map(image => String(image));
    removedImageCount += images.length;
    removedImageChars += images.reduce((sum, image) => sum + image.length, 0);
    delete clone.images;

    if (message.visionEvidenceSource === 'browser_screenshot') {
      if (message.visionEvidenceKey) removedEvidenceKeys.push(message.visionEvidenceKey);
      clone.content = `Browser screenshot ${message.visionEvidenceKey ?? 'evidence'} pixels were removed after the LLM endpoint rejected the request payload. The preceding textual tool receipt and full-resolution owner file remain available, but these pixels were not inspected by the recovery call.`;
    } else {
      removedOwnerImageCount += images.length;
      // Preserve the owner's text exactly. The recovery message below explains
      // that its attachment pixels are absent without rewriting their request.
    }
    return clone;
  });

  if (removedImageCount === 0) return null;

  const uniqueEvidenceKeys = [...new Set(removedEvidenceKeys)];
  const evidenceSummary = uniqueEvidenceKeys.length
    ? ` Removed browser evidence keys: ${uniqueEvidenceKeys.slice(0, 8).join(', ')}${uniqueEvidenceKeys.length > 8 ? ` (+${uniqueEvidenceKeys.length - 8} more)` : ''}.`
    : '';
  const limitSummary = reportedMaximumBytes > 0
    ? ` against a ${(reportedMaximumBytes / 1_000_000).toFixed(2)} MB limit`
    : '';
  const recoveryMessage = [
    'PAYLOAD RECOVERY (internal; continue the same owner task and do not mention this mechanism unless it affects the result):',
    `The preceding LLM request was rejected for payload size (${(rejectedBodyBytes / 1_000_000).toFixed(2)} MB${limitSummary}).`,
    `This continuation contains NO image pixels: ${removedImageCount} image(s), ${(removedImageChars / 1_000_000).toFixed(2)} MB of inline image data, were removed and were NOT inspected in this recovery call.${evidenceSummary}`,
    'Resume the original task from the unchanged owner request and textual assistant/tool receipts. Never claim visual verification from removed pixels.',
    'If browser pixels are still needed, use the existing browser tools to inspect/scroll and recapture only a smaller, focused viewport; do not recreate every prior screenshot.',
    removedOwnerImageCount > 0
      ? `The removed set includes ${removedOwnerImageCount} owner attachment(s). If their pixels are essential and cannot be replaced by available text/tools, ask for fewer, smaller, or more focused attachments; otherwise continue and complete the task with what remains.`
      : 'Continue using tools as needed and complete the original task. This is the only automatic payload recovery; do not repeat the rejected request.',
  ].join(' ');

  candidate.push({ role: 'user', content: recoveryMessage });
  // A data URL hidden in text/provider output would violate the image-free
  // guarantee. Refuse to mutate so the caller fails honestly instead.
  if (JSON.stringify(candidate).includes('data:image/')) return null;

  messages.splice(0, messages.length, ...candidate);
  return {
    rejectedBodyBytes,
    reportedMaximumBytes,
    removedImageCount,
    removedImageChars,
    removedOwnerImageCount,
    removedEvidenceKeys: uniqueEvidenceKeys,
    recoveryMessage,
  };
}