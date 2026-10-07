// Working out which kind of ticket someone is asking for, and steering them to it.

import type { Message, TicketType } from '../../models/types.model';

/** How many times a failed submission is retried before it is given up on. */
export const SUBMIT_ATTEMPT_LIMIT = 3;

/** What to do about a submission MIS did not confirm. */
export interface SubmitFailurePlan {
  attempts: number;
  /** False once the retry budget is spent - the reply must not offer another. */
  canRetry: boolean;
  /** True on the final permitted attempt, so the reply can warn first. */
  lastChance: boolean;
  reply: string;
  options: string[] | null;
  mode: 'confirm' | 'chat';
  /** True when the collected answers should be kept as a draft. */
  parkDraft: boolean;
}

/**
 * The reply for a submission MIS did not confirm, and whether to offer a retry.
 *
 * The retry was previously unbounded, and the giveaway was right there in the
 * code: `submit_attempts` was incremented on every failure and then read by
 * nothing at all. So tapping "Yes, submit it" re-posted the same payload and
 * produced a byte-identical failure for as long as the user kept tapping, at the
 * cost of an AI call per tap. Two failures were also handled by two copies of the
 * same block, one of which never incremented the failure counter - so a MIS
 * outage was invisible in the stats.
 *
 * This function is that gate, in one place, so both failure paths share it and
 * neither can loop.
 */
export function planSubmitFailure(
  attempts: number,
  reason: string,
  summary: string,
  retryOptions: readonly string[]
): SubmitFailurePlan {
  const n = Number(attempts) || 0;
  const why = String(reason ?? '').trim();

  if (n >= SUBMIT_ATTEMPT_LIMIT) {
    return {
      attempts: n,
      canRetry: false,
      lastChance: false,
      mode: 'chat',
      parkDraft: true,
      options: null,
      reply: 'I\'ve stopped trying so we don\'t go round in circles. '
        + '**No ticket has been confirmed as filed**'
        + (why ? ` (${why})` : '')
        + ', and I am not going to keep resending it.\n\n'
        + 'Your details are saved, so nothing is lost. You can say "create a ticket" to try again '
        + 'later, or contact MIS directly and pass them these details:\n\n'
        + summary
    };
  }

  const lastChance = n === SUBMIT_ATTEMPT_LIMIT - 1;
  const warning = lastChance
    ? '**This is the last try** - if MIS does not confirm it again I will stop and save your details rather than keep resending.'
    : '';

  return {
    attempts: n,
    canRetry: true,
    lastChance,
    mode: 'confirm',
    parkDraft: false,
    options: [...retryOptions],
    reply: 'MIS didn\'t confirm the ticket, so nothing has been filed yet'
      + (why ? ` (${why})` : '')
      + '.\n\n'
      + 'Your details are still saved'
      + (warning ? `. ${warning}` : ' - tap **Yes, submit it** to try again.')
  };
}

export function ami_userAskedForTicket(message: string): boolean {
  const text = normaliseTicketSpelling(String(message || '')).toLowerCase();
  return TICKET_TRIGGERS.some(t => text.includes(t));
}

/** Escape a phrase for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The part of a message that actually describes the problem, with the
 * "create a ticket" phrasing taken out.
 *
 * "my laptop will not turn on, please create a ticket" describes a problem.
 * "create a system request" describes nothing at all.
 *
 * This matters because the ticket's Request Description used to be seeded from
 * the whole opening message: anyone who simply typed "create a ticket" got that
 * exact phrase filed as their description and was then never asked for the real
 * one, because the field already looked filled in. A message that does describe
 * a genuine problem still carries through, so the common case of describing the
 * issue and asking for a ticket in one go still saves the typing.
 */
export function requestDescriptionFromMessage(message: string): string {
  let text = normaliseTicketSpelling(String(message || ''));
  for (const trigger of TICKET_TRIGGERS) {
    text = text.replace(new RegExp(escapeRe(trigger), 'ig'), ' ');
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!]+/, '')
    .replace(TRAILING_FILLER, '')
    .replace(/[\s,.;:!]+$/, '')
    .trim();
}

/**
 * The ticket types MIS files, in the order a user is offered them.
 *
 * These are the three real MIS forms. The hint is shown under each option
 * because "System Request" and "Tech Support" sound interchangeable to anyone
 * who has not filed a ticket here before, and picking the wrong one means
 * answering the wrong questions and then refiling.
 */
export const TICKET_TYPE_CHOICES: ReadonlyArray<{
  label: string;
  type: TicketType;
  hint: string;
}> = Object.freeze([
  { label: 'System Request', type: 'system_request', hint: 'access, data or a change to a company system (Oracle ERP, HRIS, MES...)' },
  { label: 'Tech Support', type: 'tech_support', hint: 'something is broken, wrong or not working' },
  { label: 'IT Asset', type: 'it_asset', hint: 'borrow, replace or request equipment' }
]);

/** Render the type question as text plus a short guide. */
export function ticketTypeQuestion(): string {
  const lines = TICKET_TYPE_CHOICES.map(
    (c, i) => `**${i + 1}. ${c.label}** - ${c.hint}`
  );
  return 'Sure - what type of ticket do you need?\n\n'
    + lines.join('\n')
    + '\n\nReply with the number or the name.';
}

/**
 * Real sentences, shown alongside the menu.
 *
 * The three labels only mean something to someone who has filed a ticket here
 * before - "System Request" and "Tech Support" sound interchangeable, and both
 * sound like something you would type rather than something you would pick.
 * A concrete sentence per form is what lets someone recognise their own problem
 * without translating it into MIS vocabulary first.
 */
const TYPE_EXAMPLES: ReadonlyArray<{ type: TicketType; sentence: string }> = Object.freeze([
  { type: 'tech_support', sentence: 'my laptop won\'t turn on' },
  { type: 'system_request', sentence: 'I need access to Oracle ERP' },
  { type: 'it_asset', sentence: 'I need to borrow a monitor' }
]);

/** The examples line appended to the type question after a miss. */
function typeExamplesLine(): string {
  return 'For example: ' + TYPE_EXAMPLES.map(e => `"${e.sentence}"`).join(', ') + '.';
}

/**
 * The type question, in words, for someone who asked for help instead of an option.
 *
 * `help` was only reachable through `$help`, which lists admin commands rather
 * than explaining the ticket form, so the single most common thing a stuck user
 * types produced "I didn't catch that".
 */
export function typeHelpText(): string {
  const lines = TICKET_TYPE_CHOICES.map((c) => {
    const example = TYPE_EXAMPLES.find(e => e.type === c.type);
    return `- **${c.label}** - ${c.hint}. Say it like: "${example?.sentence ?? c.label}"`;
  });
  return 'No problem - here is what I need to know.\n\n'
    + lines.join('\n')
    + '\n\nJust tell me in your own words which one fits, or say **cancel** to stop.';
}

/**
 * Digits and the words people actually type for them.
 *
 * Only exact equality against "1"/"2"/"3" was accepted before, so "01", "1.",
 * "(2)", "one" and "first" were all answered with "I didn't catch that" - five
 * different ways of giving the right answer, all rejected. Taglish is here
 * because that is how the bot is actually being spoken to.
 */
const CHOICE_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  '1': 1, '2': 2, '3': 3, '01': 1, '02': 2, '03': 3,
  one: 1, two: 2, three: 3, first: 1, second: 2, third: 3,
  isa: 1, dalawa: 2, tatlo: 3, una: 1, ikawa: 2, ikatlo: 3
});

/**
 * Strip the ways people decorate an answer, so the matcher sees a bare choice.
 *
 * The widget echoes the rendered label back as markdown, and people type
 * "no. 2", "2)", "(3)" and "#1". All of those are the number; none of them
 * compared equal to it.
 */
function normaliseTypeAnswer(answer: string): string {
  let t = String(answer ?? '').trim().toLowerCase();
  // Markdown emphasis and stray brackets from a pasted or tapped label.
  t = t.replace(/[*_`~]+/g, ' ');
  // "option 2", "no. 3", "number: 1" - the word before the real answer.
  t = t.replace(/^\s*(?:please\s+)?(?:option|choice|number|no)\b\.?\s*[:.)-]?\s*/, ' ');
  t = t.replace(/^[\s.([{]+/, '');
  t = t.replace(/[\s.)\]}]+$/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Weighted keyword signals per form.
 *
 * Split into strong and weak on purpose. A `strong` phrase only ever means that
 * form. A `weak` word is one that genuinely shows up in more than one kind of
 * request - "laptop" is a broken machine (Tech Support) or a thing to borrow
 * (IT Asset), and only the rest of the sentence tells you which - so a weak word
 * on its own is never enough to commit the user to a form.
 *
 * The old matcher had no weights at all. It returned on the first list that
 * matched anything, and the lists were ordered system, tech, asset, so `'system'`
 * was tested before `'asset'` and `'support'` before `'asset'`: any sentence
 * containing both words could only ever resolve to whichever was listed first.
 */
const TYPE_SIGNALS: ReadonlyArray<{
  type: TicketType;
  strong: readonly string[];
  weak: readonly string[];
}> = Object.freeze([
  {
    type: 'system_request',
    strong: [
      'system request', 'access request', 'application request', 'account request',
      'request access', 'data update', 'new account', 'new system', 'permission',
      'oracle', 'erp', 'hris', 'iqar', 'edas', 'onhb', 'openkm', 'psis',
      'shared folder', 'captive portal', 'mis helpdesk'
    ],
    weak: ['access', 'system', 'module', 'report', 'change', 'update', 'data']
  },
  {
    type: 'tech_support',
    strong: [
      'tech support', 'technical support', 'not working', 'does not work', "doesn't work",
      'cant log in', 'cannot log in', "can't log in", 'wont start', "won't start",
      'wont turn on', "won't turn on", 'no internet', 'blank screen', 'locked out',
      'freezing', 'crash', 'virus', 'slow', 'error', 'trouble'
    ],
    weak: ['broken', 'issue', 'problem', 'support', 'tech', 'fix', 'help', 'repair']
  },
  {
    type: 'it_asset',
    strong: [
      'it asset', 'asset request', 'asset tag', 'request an asset', 'item request',
      'borrow', 'replacement', 'replace my', 'on hand', 'onhand', 'stock',
      'inventory', 'issue quantity', 'check out', 'checkout'
    ],
    weak: ['asset', 'equipment', 'laptop', 'monitor', 'keyboard', 'mouse', 'headset', 'avr', 'ups', 'transfer']
  }
]);

/** A parse result, with enough detail to explain itself in a test. */
export interface TypeGuess {
  type: TicketType | null;
  /** Higher is more certain. 3 = exact, 2 = classifier, 1 = scored keywords. */
  score: number;
  /** Which rule decided it. */
  matchedBy: 'number' | 'label' | 'intent' | 'keywords' | 'none';
}

/**
 * Work out which MIS form the user means, from anything they might type.
 *
 * Four passes, most certain first:
 *
 * 1. The position - "1", "01", "1.", "(2)", "one", "first", "una".
 * 2. The exact label - "System Request", "it asset".
 * 3. `classifyIntent`, the same classifier that decides whether to show this
 *    menu at all. This is the important one: the menu used to run a *separate*,
 *    much smaller keyword list, so it rejected answers the bot had already
 *    worked out - "I can't log in" was recognised as Tech Support everywhere
 *    except the one place the user had to answer. One table, one decision.
 * 4. Scored keywords, which need a clear winner rather than the first hit.
 *
 * Returns `null` when nothing is confident, because being sent to the wrong MIS
 * form means answering the wrong questions and then refiling the lot.
 */
export function guessTicketType(answer: string): TypeGuess {
  const t = normaliseTypeAnswer(answer);
  if (!t) return { type: null, score: 0, matchedBy: 'none' };

  const byPosition = CHOICE_NUMBERS[t];
  if (byPosition) {
    const choice = TICKET_TYPE_CHOICES.find((_c, i) => i + 1 === byPosition);
    if (choice) return { type: choice.type, score: 3, matchedBy: 'number' };
  }

  for (const c of TICKET_TYPE_CHOICES) {
    if (t === c.label.toLowerCase()) return { type: c.type, score: 3, matchedBy: 'label' };
  }

  const byIntent = classifyIntent(t);
  if (byIntent) return { type: byIntent, score: 2, matchedBy: 'intent' };

  // Scored fallback. Every signal is counted, then the winner has to both reach
  // a floor and beat the runner-up, so a single ambiguous word cannot decide the
  // form on its own.
  const padded = ` ${t} `;
  let best: { type: TicketType; score: number } | null = null;
  let runnerUp = 0;
  for (const signals of TYPE_SIGNALS) {
    let score = 0;
    for (const phrase of signals.strong) if (padded.includes(` ${phrase} `) || padded.includes(`${phrase} `) || padded.includes(` ${phrase}`)) score += 3;
    for (const word of signals.weak) if (padded.includes(` ${word} `)) score += 1;
    if (!best || score > best.score) {
      if (best) runnerUp = Math.max(runnerUp, best.score);
      best = { type: signals.type, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (best && best.score >= 2 && best.score >= runnerUp + 2) {
    return { type: best.type, score: 1, matchedBy: 'keywords' };
  }

  return { type: null, score: 0, matchedBy: 'none' };
}

/**
 * Map the user's answer to a ticket type, or null when it is not clear.
 *
 * The thin wrapper the chat handler uses; `guessTicketType` is exported for the
 * tests, which assert on how the answer was matched and not just the result.
 */
export function parseTicketTypeChoice(answer: string): TicketType | null {
  return guessTicketType(answer).type;
}

/** How many times the type question may be missed before intake is abandoned. */
export const TYPE_MISS_LIMIT = 3;

/** What to do about an answer to the type question that matched nothing. */
export interface TypeMissPlan {
  attempts: number;
  reply: string;
  /** Buttons to offer, or null to ask in words with no buttons at all. */
  options: string[] | null;
  /** True once intake has been given up on and chat should resume. */
  handBackToChat: boolean;
}

/**
 * The escalating replies for a missed answer to the type question.
 *
 * The step used to reprint the identical question forever: it had no attempt
 * counter while every other intake field had one, so a user who did not recognise
 * the three MIS form names had no way out of it at all. Each miss now says something
 * new, and the last one stops asking.
 *
 * Handing back to free chat rather than guessing a form is deliberate. Defaulting
 * to Tech Support would file the ticket under the wrong MIS form, and the user
 * would not find out until MIS rejected it.
 */
export function planTypeMiss(attempts: number): TypeMissPlan {
  const n = Number(attempts) || 0;

  if (n >= TYPE_MISS_LIMIT) {
    return {
      attempts: n,
      handBackToChat: true,
      options: null,
      reply: 'No problem, I\'ve closed the ticket form - we can carry on as a normal chat instead. '
        + 'Tell me what\'s going on and I\'ll help you with it.'
    };
  }

  if (n === 2) {
    // The numbered list is the thing that is not working, so stop showing it
    // and ask the same question as a single plain sentence.
    return {
      attempts: n,
      handBackToChat: false,
      options: null,
      reply: 'Let\'s do this the easy way - which is closest to what you need?\n\n'
        + '- Something is **broken or not working**\n'
        + '- You need **access or a change** to a company system\n'
        + '- You need **equipment** to borrow or replace\n\n'
        + 'Just answer in your own words.'
    };
  }

  return {
    attempts: n,
    handBackToChat: false,
    options: TICKET_TYPE_CHOICES.map(c => c.label),
    reply: `I didn't catch that. Reply with 1, 2 or 3 - or the name.\n\n${ticketTypeQuestion()}`
      + '\n\n' + typeExamplesLine()
      + ' Or say **help** if you want me to explain, or **cancel** to stop.'
  };
}

/** The label for a ticket type, for echoing the choice back. */
export function ticketTypeLabel(type?: string): string {
  return TICKET_TYPE_CHOICES.find(c => c.type === type)?.label ?? String(type ?? '');
}

/**
 * Common misspellings of "ticket", folded back to the real word.
 */
const TICKET_MISSPELLINGS = /\b(?:ticker|tikers|tiket|tikets|tikit|tickit|tickte|tickeet|ticcet)\b/gi;

/**
 * Fold a misspelt "ticket" back to the real spelling.
 *
 * Applied before trigger matching *and* before a description is seeded from
 * the message, so the typo never ends up filed as the problem text either.
 */
export function normaliseTicketSpelling(text: string): string {
  return String(text || '').replace(TICKET_MISSPELLINGS, 'ticket');
}

/**
 * Phrasings that mean "raise a ticket".
 *
 * Shared, because two things need to agree on exactly this list: deciding that
 * intake should start, and deciding that a message describes a problem rather
 * than merely requesting a ticket.
 */
const TICKET_TRIGGERS: readonly string[] = [
  'create ticket', 'create a ticket', 'create the ticket', 'file a ticket',
  'submit ticket', 'submit a ticket', 'raise ticket', 'raise a ticket',
  'open ticket', 'open a ticket', 'log a ticket', 'log ticket',
  'create a system request', 'system request', 'file a system request',
  'raise a system request', 'it asset request', 'create an it asset',
  'create it asset', 'asset request', 'item request',
  'create a request', 'raise a request', 'new request',
  'need system support', 'need support', 'need to request', 'need a request',
  'want to request', 'want to raise', 'need help from mis', 'need mis to',
  'ask mis to', 'can you request', 'can you raise', 'can you create',
  'i need to raise', 'i need to file', 'help me request',
  'i need something', 'i need to get', 'i need assistance', 'need assistance',
  'gawa ng ticket', 'gawan ng ticket', 'gawa na ng ticket', 'gawa ako ng ticket',
  'gawa ko ng ticket', 'gawan ko ng ticket', 'gawan namin ng ticket',
  'kailangan ko ng ticket', 'need ko ng ticket', 'ticket ako', 'tiket'
];

/** Politeness left over once the request phrasing is removed. */
const TRAILING_FILLER = /\s+(please|pls|thanks|thank you|now|for me|kindly)\s*$/i;

/**
 * Work out which of the three MIS forms the user is asking for.
 *
 * The three are separate systems in MIS - scrf_it_asset_master, scrf_master and
 * support_master - and they collect different fields, so guessing wrong sends the
 * person down the wrong form. Order matters: the most specific flow is tested
 * first, because "I need a new laptop for my PC setup" is an asset request, not a
 * tech-support call.
 */
export function classifyIntent(message: string, _history?: Message[]): TicketType | null {
  const text = ` ${String(message || '').toLowerCase().trim()} `;

  const assetSignals = [
    'it asset', 'it assets', 'it_asset', 'asset request', 'asset tag', 'asset_tag',
    'request an asset', 'request asset', 'item request', 'borrow', 'replacement',
    'replace my', 'transfer', 'check out', 'checkout', 'issue quantity',
    'issue_quantity', 'on hand', 'onhand', 'stock', 'inventory',
    'request a laptop', 'request a monitor', 'need a laptop', 'need a monitor',
    'need a new laptop', 'need a new monitor', 'request for a'
  ];
  if (assetSignals.some(s => text.includes(s))) return 'it_asset';

  const systemSignals = [
    'system request', 'application request', 'access request', 'permission',
    'new account', 'account request', 'data update', 'new system', 'system update',
    'oracle', 'erp', 'mes ', 'psis', 'hris', 'iqar', 'edas', 'onhb', 'openkm',
    'traceability', 'logsheet', 'shared folder', 'captive portal', 'mis helpdesk'
  ];
  if (systemSignals.some(s => text.includes(s))) return 'system_request';

  const techSignals = [
    'laptop', 'desktop', 'computer', 'monitor', 'keyboard', 'mouse', 'printer',
    'scanner', 'barcode', 'internet', 'network', 'wifi', 'email', 'outlook',
    'server', 'software', 'install', 'crash', 'error', 'not working',
    'not printing', 'slow', 'virus', 'password', 'reset', 'locked out',
    'cant log in', 'cant sign in', 'cannot log in', 'wont', 'freezing',
    'blank screen', 'no internet', 'issue', 'problem', 'broken', 'fix'
  ];
  if (techSignals.some(s => text.includes(s))) return 'tech_support';

  return null;
}

/**
 * Call the AI, retrying transient failures with a growing pause.
 *
 * Bounded to three attempts and ~1.5s of waiting in total, so a genuinely broken
 * configuration still surfaces quickly instead of hanging the request.
 */