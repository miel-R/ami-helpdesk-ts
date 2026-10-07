// The order of a chat turn.
//
// This array is the whole sequence. Every stage below is independently readable
// and independently testable; the only thing they share is the context object
// and the fact that a stage returning a result ends the turn.
//
// Order matters and the reasons are recorded against the stages that depend on
// it:
//   - identify before authorise, because a role cannot be resolved without
//     knowing who is asking;
//   - authorise before startSession, so a blocked user does not get a session
//     written for them;
//   - startSession before stageUploads, so an expired conversation is closed
//     before we spend anything on its files;
//   - buildContext before callModel, obviously;
//   - callModel before decideAndStore, because the escalation decision reads
//     the model's answer.

import type { ChatStage } from './chat.pipeline';
import { identify } from './stage.identify';
import { authorise } from './stage.authorise';
import { startSession } from './stage.session';
import { stageUploads } from './stage.uploads';
import { buildContext, callModel } from './stage.reply';
import { decideAndStore } from './stage.escalate';

export const CHAT_STAGES: readonly ChatStage[] = [
  identify,
  authorise,
  startSession,
  stageUploads,
  buildContext,
  callModel,
  decideAndStore
];

export { runChatPipeline, contextFromRequest } from './chat.pipeline';
export type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';

export { NO_IDENTITY_MESSAGE } from './stage.identify';