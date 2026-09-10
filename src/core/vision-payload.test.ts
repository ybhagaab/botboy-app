import { describe, expect, it } from 'vitest';
import {
  appendToolImageEvidence,
  imageDataUrlChars,
  prepareImageFreePayloadRecovery,
  type ToolImageEvidence,
  type VisionMessage,
} from './vision-payload.js';

function evidence(key: string, payloadChars: number): ToolImageEvidence {
  return {
    dataUrl: `data:image/jpeg;base64,${'A'.repeat(payloadChars)}`,
    evidenceKey: key,
    source: 'browser_screenshot',
    mimeType: 'image/jpeg',
    bytes: Math.ceil(payloadChars * 0.75),
    width: 100,
    height: 100,
  };
}

describe('bounded current-turn vision evidence', () => {
  it('keeps the latest screenshot through follow-up work and supersedes only when a newer same-tab capture arrives', () => {
    const messages: VisionMessage[] = [{ role: 'user', content: 'task' }];
    const first = evidence('browser:tab1', 1_000);
    appendToolImageEvidence(messages, [first], 10_000);
    expect(messages.flatMap(message => message.images ?? [])).toEqual([first.dataUrl]);

    // Non-image follow-up/close does not call the helper, so the screenshot survives.
    messages.push({ role: 'tool', content: '{"closed":true}' });
    expect(messages.flatMap(message => message.images ?? [])).toEqual([first.dataUrl]);

    const second = evidence('browser:tab1', 1_200);
    const receipt = appendToolImageEvidence(messages, [second], 10_000);
    expect(receipt.supersededKeys).toEqual(['browser:tab1']);
    expect(messages.flatMap(message => message.images ?? [])).toEqual([second.dataUrl]);
    expect(messages.some(message => String(message.content).includes('superseded by a newer capture'))).toBe(true);
  });

  it('retains different tabs when affordable and evicts oldest tool evidence before owner attachments', () => {
    const ownerAttachment = `data:image/png;base64,${'O'.repeat(900)}`;
    const messages: VisionMessage[] = [{ role: 'user', content: 'compare', images: [ownerAttachment] }];
    const first = evidence('browser:tab1', 1_000);
    appendToolImageEvidence(messages, [first], 3_500);
    const second = evidence('browser:tab2', 1_000);
    appendToolImageEvidence(messages, [second], 3_500);
    expect(messages.flatMap(message => message.images ?? [])).toEqual([ownerAttachment, first.dataUrl, second.dataUrl]);

    const third = evidence('browser:tab3', 1_000);
    const receipt = appendToolImageEvidence(messages, [third], 3_500);
    expect(receipt.evictedKeys).toEqual(['browser:tab1']);
    expect(messages.flatMap(message => message.images ?? [])).toEqual([ownerAttachment, second.dataUrl, third.dataUrl]);
    expect(imageDataUrlChars(messages)).toBeLessThanOrEqual(3_500);
  });
});

describe('same-turn image-free payload recovery', () => {
  const rejection = {
    code: 'LLM_PAYLOAD_TOO_LARGE',
    source: 'remote' as const,
    maximumBytes: 6_000_000,
    size: { bodyBytes: 9_293_448, imageCount: 2, imageChars: 2_100 },
  };

  it('preserves the original task and tool protocol while removing only pixels and adding actionable recovery context', () => {
    const ownerImage = `data:image/png;base64,${'O'.repeat(900)}`;
    const browserImage = `data:image/jpeg;base64,${'B'.repeat(1_200)}`;
    const toolReceipt = { role: 'tool', content: '{"filePath":"/tmp/full-owner.png","tabId":"tab_1"}', toolCallId: 'shot_1' };
    const messages: VisionMessage[] = [
      { role: 'system', content: 'system contract' },
      { role: 'user', content: 'Compare this attachment with the browser result.', images: [ownerImage] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'shot_1', function: { name: 'browser_screenshot', arguments: '{"tabId":"tab_1"}' } }] },
      toolReceipt,
      {
        role: 'user',
        content: 'Browser screenshot evidence from the preceding tool result. Inspect these pixels now.',
        images: [browserImage],
        visionEvidenceKey: 'browser:tab_1',
        visionEvidenceSource: 'browser_screenshot',
      },
    ];

    const receipt = prepareImageFreePayloadRecovery(messages, rejection);
    expect(receipt).not.toBeNull();
    expect(receipt?.removedImageCount).toBe(2);
    expect(receipt?.removedOwnerImageCount).toBe(1);
    expect(receipt?.removedEvidenceKeys).toEqual(['browser:tab_1']);
    expect(messages.flatMap(message => message.images ?? [])).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain('data:image/');
    expect(messages[1].content).toBe('Compare this attachment with the browser result.');
    expect(messages[3]).toBe(toolReceipt);
    expect(messages[3].content).toContain('/tmp/full-owner.png');
    expect(messages[4].content).toContain('were not inspected by the recovery call');

    const recovery = messages[messages.length - 1];
    expect(recovery.content).toContain('continue the same owner task');
    expect(recovery.content).toContain('NO image pixels');
    expect(recovery.content).toContain('Never claim visual verification');
    expect(recovery.content).toContain('recapture only a smaller, focused viewport');
    expect(recovery.content).toContain('fewer, smaller, or more focused attachments');
    expect(prepareImageFreePayloadRecovery(messages, rejection)).toBeNull();
  });

  it('does not mutate unrelated errors or contexts that cannot be proven image-free', () => {
    const unrelated: VisionMessage[] = [{ role: 'user', content: 'task', images: ['data:image/png;base64,AAAA'] }];
    const unrelatedBefore = structuredClone(unrelated);
    expect(prepareImageFreePayloadRecovery(unrelated, new Error('HTTP 400: invalid tool schema'))).toBeNull();
    expect(unrelated).toEqual(unrelatedBefore);

    const hiddenData: VisionMessage[] = [{
      role: 'user',
      content: 'literal data:image/png;base64,HIDDEN',
      images: ['data:image/png;base64,AAAA'],
    }];
    const hiddenBefore = structuredClone(hiddenData);
    expect(prepareImageFreePayloadRecovery(hiddenData, rejection)).toBeNull();
    expect(hiddenData).toEqual(hiddenBefore);
  });
});