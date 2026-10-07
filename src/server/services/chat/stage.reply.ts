// Stages 5 and 6 - build the prompt, then call the model.
//
// Split in two because the two halves fail differently. Building the prompt
// cannot fail in a way the user should see; calling the model absolutely can, and
// that failure ends the turn with an apology rather than a broken reply.
//
// The last twenty messages are replayed as context. That number is the whole
// memory of the conversation from the model's point of view, and it is why Ami
// forgets things said earlier than twenty turns ago.

import { counters, logEvent } from '../../core/logger';
import { db } from '../../db/storage.service';
import { callAI, costOf } from '../../ai';
import * as rag from '../rag.service';
import { SYSTEM_PROMPT } from '../../features/agent/system-prompt';
import { identityContext } from '../../features/agent/prompt';
import { callAIWithRetry } from '../ai-retry.service';
import { lastIndexOfMarker } from '../session-lifecycle.service';
import type { AIMessage } from '../../ai';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';
import { sessionUsage } from './usage.service';

export const buildContext: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const { message, fileAnalysis, lastFileName } = ctx;
  const session = ctx.session!;
  const user = ctx.user!;

  let systemPrompt = SYSTEM_PROMPT;
  if (fileAnalysis) systemPrompt += `\n\nFILE ANALYSIS (already provided by user):\n${fileAnalysis}\n`;
  if (lastFileName) systemPrompt += `\nLast uploaded file: ${lastFileName}\n`;
  systemPrompt += identityContext(user, ctx.userName as string, ctx.isAdminUser as boolean, ctx.quotaUser as string);

  const fewShot = rag.fewShotBlock(`${message} ${lastFileName}`, null, 2);
  if (fewShot) systemPrompt += `\n\n${fewShot}\n`;

  // Replayed context: the current conversation only, oldest first.
  //
  // The session-end marker is a REAL boundary, not a drawing. The widget renders
  // it as `——— session ended —————`, which claims the previous conversation is
  // over - and it was, for everything that matters: expiry drops the ticket draft,
  // the intake stage and the collected fields. But the replay window was still
  // reaching straight past it, so of the twenty turns Ami would see on a real
  // session, EIGHTEEN were from before the end. The divider said "ended" while the
  // model quietly carried on as if nothing happened.
  //
  // The window is anchored to the last marker, so a new conversation starts with
  // a clean slate and matches what the divider tells the user.
  //
  // `role: 'system'` rows are excluded for the same reason the marker is: they are
  // widget directives rather than conversation, and replaying one would hand the
  // model a line the user never typed.
  const markerAt = lastIndexOfMarker(session.messages);
  const currentConversation = session.messages.slice(markerAt + 1);

  // Drop this turn's own message if it is already on the array.
  //
  // startSession pushes and saves the user turn BEFORE the model is called, so a
  // provider failure cannot swallow it. That leaves the final entry here being
  // the message we are about to append explicitly below, so the replay has to let
  // it go - otherwise the model sees the user asking the same thing twice in a
  // row. Compared by position, not content: two identical messages in one
  // conversation are legitimate and only the last one is ours.
  const withoutOwnTurn = ctx.userTurnPushed
    ? currentConversation.slice(0, -1)
    : currentConversation;

  const replay = withoutOwnTurn
    .filter(m => m.role !== 'system')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));

  const messages: AIMessage[] = [
    { role: 'system', content: systemPrompt },
    ...replay,
    { role: 'user', content: message }
  ];

  if (fileAnalysis) messages[messages.length - 1].content = `${message}\n\n[File Analysis: ${fileAnalysis}]`;

  ctx.messages = messages;
  ctx.systemPrompt = systemPrompt;
  return null;
};

export const callModel: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const session = ctx.session!;
  const messages = ctx.messages!;
  const systemPrompt = ctx.systemPrompt as string;
  const sessionId = ctx.sessionId as string;
  const quotaUser = ctx.quotaUser as string;

  const startedAt = Date.now();
  let aiReply: string;
  try {
    // The timeout is handed in from the retry budget rather than hardcoded, so
    // one place decides how long the user will wait. It used to be 30s inside
    // every axios call, and a provider stall then cost three of those before the
    // user was told anything.
    const aiResult = await callAIWithRetry(async (attemptTimeoutMs) => {
      const r = await callAI(messages, systemPrompt, attemptTimeoutMs);
      // An empty completion is a failure, not an empty reply. Returning it as a
      // blank answer would store a blank turn and show the user nothing.
      if (!String(r.text ?? '').trim()) throw new Error('empty completion');
      return r;
    });
    aiReply = aiResult.text;
    const usage = aiResult.usage;
    counters.aiCalls++;
    counters.aiMsTotal += Date.now() - startedAt;

    const callCost = costOf(usage);
    const u = sessionUsage(session);
    u.prompt_tokens += usage.inputTokens || 0;
    u.completion_tokens += usage.outputTokens || 0;
    u.total_tokens += usage.totalTokens || 0;
    u.calls += 1;
    const costBag = session as unknown as { estimated_cost?: number };
    costBag.estimated_cost = Number(((costBag.estimated_cost ?? 0) + callCost).toFixed(8));

    try {
      await db().recordMessage({
        sessionId,
        username: quotaUser,
        kind: 'chat',
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costUsd: callCost,
        durationMs: Date.now() - startedAt
      });
    } catch (e) {
      console.warn(`[usage] could not record chat usage: ${(e as Error).message}`);
    }

    logEvent('info', 'ai_call', {
      provider: usage.provider, model: usage.model,
      ms: Date.now() - startedAt, with_file: !!ctx.fileAnalysis,
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      cost_usd: callCost
    });
  } catch (err) {
    counters.aiErrors++;
    const ms = Date.now() - startedAt;
    const message = (err as Error).message;
    // Logged with the elapsed time because the useful question is always "did the
    // provider stall, or did we". Without the duration the log only says
    // "trouble reaching the AI", which is indistinguishable from a bad key.
    logEvent('error', 'ai_call_failed', {
      error: message,
      ms,
      stalled: /timeout/i.test(message)
    });
    // One line that says what happened and what to do. The old wording was a dead
    // end: the user could not tell whether to wait, retry, or contact MIS.
    return {
      status: 200,
      body: {
        reply: /timeout/i.test(message)
          ? 'That took longer than expected and I gave up waiting. Please send that again - it usually goes through on the second try.'
          : 'Sorry, I had trouble reaching the AI service. Please try again.',
        provider: 'system',
        // The widget offers a retry rather than leaving a dead end.
        retryable: true
      }
    };
  }

  ctx.aiReply = aiReply;
  return null;
};
