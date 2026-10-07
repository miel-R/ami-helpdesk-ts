// What the user is trying to say, judged from the words alone.

/**
 * Every classifier here is a pure function of one string. That is the point: they are
 * the part of the assistant most likely to need changing, and they can be tested
 * without a server, a database or an AI provider.
 */

/**
 * "Stop what you're doing", as whole messages.
 *
 * Anchored on purpose. A substring match for `cancel` looks harmless until
 * someone types "please cancel the monthly subscription in Oracle" - which is a
 * System Request, and would have thrown away a ticket they were part-way
 * through. An abort has to be the entire message to count as one.
 *
 * The trailing politeness words are allowed because "cancel please" and
 * "bahala na lang" are the same instruction, not different ones.
 */
const ABORT_PHRASES = new RegExp(
  '^(?:please\\s+|pls\\s+)?(?:'
  + 'cancel(?:l?ed)?(?:\\s+(?:the|my|this)\\s+ticket)?'
  + '|stop(?:\\s+it|\\s+now)?'
  + '|quit|exit|abort|enough'
  + '|never\\s?mind'
  + '|forget\\s+(?:it|that|this)'
  + '|leave\\s+(?:it|that|this)(?:\\s+alone)?'
  + '|no\\s+more'
  + '|bahala(\\s+na)?|wala\\s+na|ayoko(\\s+na)?|lang\\s+na'
  + ')'
  + '(?:\\s+(?:please|pls|thanks|thank\\s+you|now|na|lang|muna|ako|ko|din))*[.!?]*$',
  'i'
);

/**
 * Is the user abandoning what the chatbot is doing?
 *
 * This is the escape hatch. Intake used to understand it at exactly one place -
 * the final "shall I submit this?" - so changing your mind at the type question,
 * or halfway down a form, was answered with "I didn't catch that" and the same
 * question again. The only ways out were the `$reset` and `$end` commands, which
 * a user who has never seen the command list has no way to know about.
 */
export function isAbortIntent(text: string): boolean {
  const t = String(text ?? '').trim();
  // A long message is a description, not an instruction to stop.
  if (!t || t.length > 60) return false;
  return ABORT_PHRASES.test(t);
}

/** "Just tell me how this works", as whole messages. */
const HELP_PHRASES = /^(?:help|help\s+me|help\s+please|options?|choices?|what\s+can\s+i\s+do|what\s+do\s+i\s+do|what\s+now|how\s+does\s+this\s+work|how\s+do\s+i\s+answer|ano(?:ng)?\s+(?:ang\s+)?(?:pwede|meron)?|listahan)(?:\s+(?:please|pls|na))*[.!?]*$/i;

/**
 * Is the user asking for instructions rather than answering?
 *
 * Only safe to honour where the pending question is genuinely a choice of form.
 * Further into a form "help" is far more often part of an answer - "I need help
 * with the printer in CK1" - and swallowing it as a request for instructions
 * would lose a real answer.
 */
export function isHelpIntent(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t || t.length > 60) return false;
  return HELP_PHRASES.test(t);
}

/** Replies for an intake abandoned part-way through. */
export const ABORT_WITH_DETAILS =
  'No problem, I\'ve stopped there. Nothing has been sent to MIS.\n\n'
  + 'I kept the details you already gave me, so just say "create a ticket" whenever you want to '
  + 'pick it up again, or "start over" to clear it and begin fresh.';

export const ABORT_NOTHING_KEPT =
  'No problem, I\'ve closed the ticket form. Nothing has been sent to MIS.\n\n'
  + 'We can just carry on as a normal chat - tell me what you need.';

/**
 * "Not yet", at the point where a ticket is about to be filed.
 *
 * Shared so the decline path and the retry guard cannot drift into disagreeing
 * about whether a word means "no".
 */
const SUBMIT_DECLINE = /^(?:no|nope|not\s+yet|not\s+now|cancel|wait|hold|stop|never\s?mind|nevermind|bahala\s+na|ayoko\s+na)\b/i;

export function isSubmitDecline(text: string): boolean {
  return SUBMIT_DECLINE.test(String(text ?? '').trim());
}

/**
 * Is this message clearly asking for the submission to happen again?
 *
 * Broader than a plain yes on purpose. After a failure the user is staring at
 * the same two buttons, and "try again" or "one more time" is what they say -
 * neither of which `ami_isAffirmative` recognises, so a retry guard built only
 * on it would treat the most natural retry as "neither yes nor no" and throw
 * away a ticket the user was trying to save.
 */
export function isSubmitRetry(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (isSubmitDecline(t)) return false;
  if (ami_isAffirmative(t)) return true;
  return /^(?:try|retry|again|one\s+more(?:\s+time)?|go\s+again|resend|send\s+it|submit|do\s+it|lets?\s+try|still\s+(?:failing|broken|failing))\b/i.test(t);
}


/**
 * Is this reply a yes?
 */
export function ami_isAffirmative(text: string): boolean {
  const words = String(text || '').toLowerCase().trim().split(/\s+/);
  if (!words.length) return false;

  const phrases = ['go ahead', 'create it', 'submit it', 'please do', 'yes please', 'affirmative'];
  const joined = ` ${words.join(' ')} `;
  for (const phrase of phrases) {
    if (joined.includes(` ${phrase} `)) return true;
  }

  const tokens = [
    'yes', 'yeah', 'yep', 'yup', 'y', 'ok', 'okay', 'sure', 'correct',
    'confirm', 'confirmed', 'proceed', 'submit', 'sige', 'oo', 'opo', 'go',
    'please', 'can you', 'go ahead'
  ];
  return tokens.includes(words[0] ?? '');
}