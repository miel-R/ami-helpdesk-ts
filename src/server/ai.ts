// AI Client Handlers
import axios from 'axios';
import { config } from './config/config.service';

/** A chat turn in the shape every provider here accepts. */
export interface AIMessage {
  role: string;
  content: string;
}

/** Token usage for one call, in our own normalised shape. */
export interface TokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** What every AI call returns: the text plus the tokens THIS call consumed. */
export interface AIResult {
  text: string;
  usage: TokenUsage;
}

export type ProviderKey = 'gemini' | 'openai';

/**
 * Estimate the cost of a single call.
 *
 * IMPORTANT: pass the tokens for THIS call only. Passing a running total and
 * then adding the result to another running total double-counts badly.
 */
export function estimateCost(
  provider: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing =
    config.pricing[provider as ProviderKey] ?? config.pricing.gemini;
  return promptTokens / 1e6 * pricing.input + completionTokens / 1e6 * pricing.output;
}

export function emptyUsage(): TokenUsage {
  return { provider: '', model: '', inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Normalise a provider's usage payload into our shape.
 *
 * Gemini and OpenAI name these fields differently, and Gemini sometimes omits the
 * total, so both spellings are accepted and the total is derived when absent.
 */
export function normaliseUsage(
  provider: string,
  model: string,
  raw: Record<string, unknown> = {}
): TokenUsage {
  const inputTokens = raw.promptTokenCount ?? raw.prompt_tokens ?? 0;
  const outputTokens = raw.candidatesTokenCount ?? raw.completion_tokens ?? 0;
  const totalTokens =
    raw.totalTokenCount ?? raw.total_tokens ?? Number(inputTokens) + Number(outputTokens);
  return {
    provider,
    model,
    inputTokens: Number(inputTokens) || 0,
    outputTokens: Number(outputTokens) || 0,
    totalTokens: Number(totalTokens) || 0
  };
}

/**
 * Call the Gemini API.
 *
 * `systemPrompt` is used when `messages` carries no system turn. It used to be
 * accepted and then ignored, which meant a caller passing a system prompt got
 * silently different behaviour from one embedding a system message.
 */
export async function callGemini(
  messages: AIMessage[],
  systemPrompt: string | undefined,
  timeoutMs = 11000
): Promise<AIResult> {
  if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY not set');

  const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
  if (!systemParts.length && systemPrompt) systemParts.push(systemPrompt);

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`,
    {
      contents,
      systemInstruction:
        systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }
  );

  const data = response.data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: Record<string, unknown>;
  };
  const usage = normaliseUsage('gemini', config.gemini.model, data.usageMetadata ?? {});
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  return { text, usage };
}

/** Call the OpenAI API. */
export async function callOpenAI(messages: AIMessage[], timeoutMs = 11000): Promise<AIResult> {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY not set');

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: config.openai.model, messages, temperature: 0.6, max_tokens: 500 },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`
      },
      timeout: timeoutMs
    }
  );

  const data = response.data as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: Record<string, unknown>;
  };
  const usage = normaliseUsage('openai', config.openai.model, data.usage ?? {});
  const text = data.choices?.[0]?.message?.content ?? '';

  return { text, usage };
}

/**
 * Call the AI.
 *
 * Gemini is used whenever its key is present; OpenAI is NOT a runtime fallback,
 * it is only used when GEMINI_API_KEY is empty. Returns { text, usage } so the
 * caller gets the tokens for this exact call rather than reading shared state.
 */
export async function callAI(
  messages: AIMessage[],
  systemPrompt: string | undefined,
  timeoutMs = 11000
): Promise<AIResult> {
  if (config.gemini.apiKey) return callGemini(messages, systemPrompt, timeoutMs);
  if (config.openai.apiKey) return callOpenAI(messages, timeoutMs);
  throw new Error('No AI provider configured');
}
/**
 * Describe an image using Gemini.
 *
 * Returns { text, usage } - the vision call consumes real tokens, so the usage is
 * reported rather than discarded. Returns null when no provider is configured or
 * the call fails: a missing image analysis must not fail the upload.
 */
export async function analyzeImage(
  base64: string,
  mimeType: string,
  // Image analysis runs inside the upload path, which the user is already waiting
  // on. It gets a longer ceiling than a chat turn because a vision call is
  // genuinely slower, but it is still bounded: an upload must never hang.
  timeoutMs = 20000
): Promise<{ text: string; usage: TokenUsage } | null> {
  if (!config.gemini.apiKey && !config.openai.apiKey) return null;

  const imagePrompt =
    'Describe what you see in this image in 1-2 sentences. Do NOT provide troubleshooting steps, fixes, or diagnostic advice. If it contains data (table, chart, list), extract and summarize the key information.';

  if (config.gemini.apiKey) {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: imagePrompt }, { inline_data: { mime_type: mimeType, data: base64 } }]
        }
      ],
      systemInstruction: { parts: [{ text: 'You are Ami, a helpdesk assistant. Analyze images and help users.' }] }
    };

    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }
      );

      const data = response.data as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: Record<string, unknown>;
      };
      const parts = data.candidates?.[0]?.content?.parts;
      if (!parts || !parts.length) {
        console.warn('[analyzeImage] empty response from Gemini');
        return null;
      }
      return {
        text: parts[0]?.text ?? '',
        usage: normaliseUsage('gemini', config.gemini.model, data.usageMetadata ?? {})
      };
    } catch (err) {
      console.warn(`[analyzeImage] failed (${config.gemini.model}): ${(err as Error).message}`);
      return null;
    }
  }

  return null;
}

/** Cost for one call, using the provider recorded on the usage object. */
export function costOf(usage: TokenUsage | null | undefined): number {
  if (!usage) return 0;
  return estimateCost(usage.provider || 'gemini', usage.inputTokens || 0, usage.outputTokens || 0);
}