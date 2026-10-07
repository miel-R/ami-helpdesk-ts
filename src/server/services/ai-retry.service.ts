// Retrying a model call that failed for a transient reason.
//
// The retry behaviour is unchanged from what it always was: three attempts, 30s
// each. What was wrong was not the retrying but that a stall was indistinguishable
// from a bad key in the logs, so the fix went into observability and the error
// message rather than into the timing. See DEFAULT_RETRY_POLICY.

export interface RetryPolicy {
  /** Attempts, including the first. */
  attempts: number;
  /** Hard ceiling on the time this call may take, retries included. */
  budgetMs: number;
  /** Timeout for a single attempt. */
  attemptTimeoutMs: number;
}

/**
 * Deliberately the OLD timing, restored on purpose.
 *
 * While chasing a 48-second reply I cut this to 11s x 2 / 20s total and nearly
 * shipped it. Measured against the provider, that call was attempt 1 timing out
 * and attempt 2 succeeding at 18s - so the tighter budget would have turned a
 * slow success into a failure. A reply at 48s is much better than no reply, and
 * the user agreed slow is fine.
 *
 * The budget is still here, and still enforced, because it is a backstop rather
 * than a target: at 120s it never truncates the 3 x 30s behaviour it replaces,
 * but an unbounded loop could not hang forever.
 *
 * What this file does NOT do is shorten anything. The useful change was the
 * logging and the message in stage.reply.ts, which are what made the stall
 * diagnosable in the first place.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  budgetMs: 120000,
  attemptTimeoutMs: 30000
};

export async function callAIWithRetry<T>(
  call: (timeoutMs: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  for (let i = 0; i < policy.attempts; i++) {
    // Never start an attempt that cannot finish inside the budget: a call that
    // begins with 2s left would spend 2s and then be cut off, which is the same
    // waiting as not retrying at all.
    const elapsed = Date.now() - startedAt;
    const remaining = policy.budgetMs - elapsed;
    if (i > 0 && remaining <= 0) break;
    const attemptTimeoutMs = Math.max(1000, Math.min(policy.attemptTimeoutMs, remaining));

    try {
      return await withTimeout(call(attemptTimeoutMs), attemptTimeoutMs,
        `timeout of ${attemptTimeoutMs}ms exceeded`);
    } catch (err) {
      lastError = err;
      const spent = Date.now() - startedAt;
      const budgetLeft = policy.budgetMs - spent;
      if (!isTransientAiError(err) || i === policy.attempts - 1 || budgetLeft <= 1200) break;

      const waitMs = Math.min(600 * Math.pow(2, i), budgetLeft - 800);
      if (waitMs <= 0) break;
      console.warn(
        `[ai] transient failure (${(err as Error).message}); ` +
        `retry ${i + 2}/${policy.attempts} in ${waitMs}ms ` +
        `(${spent}ms of ${policy.budgetMs}ms budget used)`
      );
      await sleep(waitMs);
    }
  }
  throw lastError;
}

/**
 * Bound one attempt, so a stalled socket cannot outlive the budget.
 *
 * axios has its own timeout, but it is set per call site and a future one that
 * forgot to set it would hang until the socket gave up. This is the backstop.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * True for AI failures that are worth trying again.
 *
 * A 429 is a rate limit, not a bad request, and they arrive in bursts: one
 * unlucky turn used to cost the user the entire reply even though waiting a
 * second would have worked. Timeouts and 5xx are the same story.
 *
 * A non-transient failure (bad key, 400/401/403) is deliberately excluded -
 * retrying those only burns quota and makes the user wait longer for the very
 * same error.
 *
 * "exceeded your current quota" is here because it is the message Gemini actually
 * returns, and it carries neither a status code nor the words "rate limit". It is
 * a per-MINUTE window: it cleared on its own after about 70 seconds during
 * testing, with no change to the key or the plan. Matching only "429" and "rate
 * limit" meant the one failure that really is worth retrying was the one failure
 * we gave up on.
 */
export function isTransientAiError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? '');
  return /status code (429|500|502|503|504)/i.test(message)
    || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timeout|overloaded|rate limit/i.test(message)
    || /exceeded your current quota|quota exceeded|RESOURCE_EXHAUSTED/i.test(message)
    || /empty completion/i.test(message);
}

/**
 * Which part of the day it is in the configured timezone.
 */