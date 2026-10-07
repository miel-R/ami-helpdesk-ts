// Stage 4 - stage the uploaded files and analyse any images.
//
// An image is analysed here, before the model is called, because the analysis
// goes into the prompt. A failure to process a file ends the turn rather than
// dropping the upload silently, which is what a user who attached a screenshot
// of the error would otherwise experience.
//
// Vision usage is recorded per file because each image is a separate model call.

import { counters, logEvent } from '../../core/logger';
import { db } from '../../db/storage.service';
import { costOf } from '../../ai';
import * as limits from '../quota.service';
import { processFile } from '../file.service';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';
import { sessionUsage } from './usage.service';

export const stageUploads: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const { files } = ctx;
  const sessionId = ctx.sessionId as string;
  const quotaUser = ctx.quotaUser as string;
  const session = ctx.session!;

  const processedFiles: Array<Record<string, unknown>> = [];
  const uploadsBag = session as unknown as { uploads?: unknown[] };

  if (files.length > 0) {
    const maxBytes = await limits.uploadLimitFor(quotaUser);
    for (const file of files) {
      const result = await processFile(file, sessionId, false, maxBytes);

      if (result.error) {
        return {
          status: 200,
          body: {
            reply: `Sorry, I could not process ${file.originalname}: ${result.error}`,
            provider: 'system',
            file_error: result.error
          }
        };
      }

      counters.uploads++;
      counters.uploadBytes += Number(result.size) || 0;
      logEvent('info', 'upload', {
        file: result.name, type: result.type, bytes: result.size,
        ticket_attachment: false, analyzed: !!result.analysis
      });

      if (result.analysisUsage) {
        const visionCost = costOf(result.analysisUsage);
        const vu = result.analysisUsage;
        try {
          await db().recordMessage({
            sessionId,
            username: quotaUser,
            kind: 'image',
            provider: vu.provider,
            model: vu.model,
            inputTokens: vu.inputTokens,
            outputTokens: vu.outputTokens,
            totalTokens: vu.totalTokens,
            costUsd: visionCost,
            durationMs: 0
          });
          const su = sessionUsage(session);
          su.prompt_tokens += vu.inputTokens || 0;
          su.completion_tokens += vu.outputTokens || 0;
          su.total_tokens += vu.totalTokens || 0;
          su.calls += 1;
          const bag = session as unknown as { estimated_cost?: number };
          bag.estimated_cost = Number(((bag.estimated_cost ?? 0) + visionCost).toFixed(8));
        } catch (e) {
          console.warn(`[usage] could not record image usage: ${(e as Error).message}`);
        }
      }

      ctx.lastFileName = result.name;
      if (result.analysis) ctx.fileAnalysis = result.analysis;

      processedFiles.push({
        name: result.name,
        stored_name: result.stored_name,
        stored_path: result.stored_path,
        type: result.type,
        size: result.size,
        uploaded_at: new Date().toISOString()
      });
    }

    // Bounded: a long-lived widget session should not accumulate screenshots
    // forever, and the newest twenty are the ones that still matter.
    if (!Array.isArray(uploadsBag.uploads)) uploadsBag.uploads = [];
    uploadsBag.uploads.push(...processedFiles);
    if (uploadsBag.uploads.length > 20) uploadsBag.uploads = uploadsBag.uploads.slice(-20);
  }

  return null;
};
