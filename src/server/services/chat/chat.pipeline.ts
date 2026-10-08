// The chat turn, expressed as an ordered list of stages.
//
// It used to be one 526-line handler in which nine decisions ran top to bottom:
// who is calling, may they, is the session still alive, what did they upload,
// what do we tell the model, what does it say, and do we hand over to the form.
//
// That is a sequence, but it was written as one function, so every stage sat in
// the same scope as every other one and a change to any of them meant reading
// the lot. Worse, several stages could answer the user directly by calling
// res.json() and returning, which is what made the control flow impossible to
// follow: nine exit points hidden in a straight line.
//
// Each stage now takes a context, mutates what it knows, and either returns null
// to continue or a result to answer with. The order below is the only place the
// sequence is described, so adding a step is one entry here rather than a new
// block of code wedged between two others.

import type { Request } from 'express';
import type { Conversation, SessionUser } from '../../models/types.model';
import type { AIMessage } from '../../ai';

/** What a stage hands back when it is the one that answers the user. */
export interface ChatResult {
  status: number;
  body: Record<string, unknown>;
}

/** State threaded through the stages, and by nothing else. */
export interface ChatContext {
  // In, from the request.
  body: Record<string, unknown>;
  files: Express.Multer.File[];
  message: string;

  // Worked out along the way. Optional because a stage may finish before the
  // stage that fills them in, which is exactly how the early exits work.
  sessionId?: string;
  quotaUser?: string;
  user?: SessionUser;
  session?: Conversation;
  isAdminUser?: boolean;
  /** The registered user record, so the role can fall back to what we stored. */
  storedUser?: { role?: string } | null;
  userName?: string;

  // Uploads.
  fileAnalysis: string | null;
  lastFileName: string;
  /**
   * Files that were staged for THIS turn, as `{name, stored_name}` pairs.
   *
   * This is what makes "files the assistant read" answerable. The uploads array on
   * the conversation only says a file exists; it cannot say whether the model was
   * ever handed it, because a file staged in an earlier turn stays in that array
   * for the life of the conversation. stageUploads fills this, stage.reply attaches
   * the names to the assistant message's meta, and the session analytics counts
   * what it finds there. A file nobody read is therefore not billed as read.
   */
  processedFiles?: Array<{ name: string; stored_name: string;
    type: string; size: number }>;

  /**
   * True once this turn's own user message has been pushed onto
   * `session.messages` (startSession does it, before the model is called).
   *
   * buildContext needs it because it replays `session.messages` AND appends the
   * current message as a separate final turn. With the message already on the
   * array, that would send it to the model twice - the user asking the same thing
   * twice in a row. This flag is how the replay window drops the duplicate.
   */
  userTurnPushed?: boolean;

  // Model.
  messages?: AIMessage[];
  systemPrompt?: string;
  aiReply?: string;
}

export type ChatStage = (ctx: ChatContext) => Promise<ChatResult | null>;

/** Build the context from the request. Kept here so the runner stays trivial. */
export function contextFromRequest(req: Request): ChatContext {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    body,
    files: ((req.files ?? []) as Express.Multer.File[]),
    message: String(body.message ?? ''),
    fileAnalysis: null,
    lastFileName: ''
  };
}

/**
 * Run the stages in order and answer with the first one that returns a result.
 *
 * A stage returning null means "carry on". A non-null result ends the turn: that
 * stage has already decided what the user gets, and no later stage runs.
 */
export async function runChatPipeline(
  ctx: ChatContext,
  stages: readonly ChatStage[]
): Promise<ChatResult | null> {
  for (const stage of stages) {
    const result = await stage(ctx);
    if (result) return result;
  }
  return null;
}
