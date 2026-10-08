// Configurable token pricing for the Per Session Cost table.
//
// The dashboard reports cost two different ways on purpose:
//
//   1. The LEDGER cost in `usage_messages.cost_usd`, which is what the provider
//      actually billed us for. That number is real and is kept for the record.
//   2. The RATED cost shown in the Per Session Cost table, computed from a rate
//      an admin can change without a redeploy.
//
// They are separate because the two answer different questions. "What did this
// cost?" is a billing question with one right answer. "What would this session
// have cost at our standard internal rate?" is a costing question, and the rate
// is a policy decision that changes when finance revises the schedule.
//
// The rates therefore live here, not in the environment, because an admin edits
// them from the dashboard's Live tab. Env vars set the DEFAULTS for a fresh
// install; anything saved through the API overrides them until restart.

/** Rates are per ONE MILLION tokens, which is how providers quote them. */
export interface CostRates {
  input_per_million: number;
  output_per_million: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  input_per_million: 0.30,
  output_per_million: 2.50
};

const STORE_FILE = 'data/cost-rates.json';

let override: CostRates | null = null;

/** Rates from the environment, so a deployment can be pinned without the API. */
function envRates(): CostRates {
  const i = parseFloat(process.env.COST_INPUT_PER_MILLION || '');
  const o = parseFloat(process.env.COST_OUTPUT_PER_MILLION || '');
  return {
    input_per_million: Number.isFinite(i) && i >= 0 ? i : DEFAULT_COST_RATES.input_per_million,
    output_per_million: Number.isFinite(o) && o >= 0 ? o : DEFAULT_COST_RATES.output_per_million
  };
}

/**
 * Rejects anything that is not a usable rate.
 *
 * NaN here would silently render every cost as `$NaN` in the table, and a
 * negative rate would produce a negative cost, which reads as a credit. Both are
 * worse than refusing the save, so the guard is at the API boundary.
 */
export function isValidRates(v: unknown): v is Partial<CostRates> {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  for (const key of ['input_per_million', 'output_per_million'] as const) {
    if (r[key] === undefined) continue;
    const n = Number(r[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return false;
  }
  return true;
}

/** Current rates: the admin override when one is saved, otherwise the environment. */
export function getCostRates(): CostRates {
  if (override) return { ...override };
  return envRates();
}

/** Current rates plus where they came from, so the UI can say "custom" honestly. */
export function getCostRatesWithSource(): CostRates & { source: 'custom' | 'default' } {
  return { ...getCostRates(), source: override ? 'custom' : 'default' };
}

/** Merges a validated partial over the current rates and persists the result. */
export async function saveCostRates(patch: Partial<CostRates>): Promise<CostRates> {
  const current = getCostRates();
  const next: CostRates = {
    input_per_million: patch.input_per_million !== undefined
      ? Number(patch.input_per_million)
      : current.input_per_million,
    output_per_million: patch.output_per_million !== undefined
      ? Number(patch.output_per_million)
      : current.output_per_million
  };
  override = next;
  await persist(next);
  return next;
}

/**
 * Restores the shipped defaults, discarding the override.
 *
 * The in-memory override is cleared as well as the file, because a stale file
 * that this process failed to rewrite would otherwise be reloaded on restart and
 * make "reset" look like it did nothing.
 */
export async function resetCostRates(): Promise<CostRates> {
  override = null;
  await persist(envRates());
  return getCostRates();
}

/** Loads a previously saved override. Called once at startup. */
export async function loadCostRates(): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CostRates>;
    if (isValidRates(parsed)) {
      const cur = envRates();
      override = {
        input_per_million: parsed.input_per_million ?? cur.input_per_million,
        output_per_million: parsed.output_per_million ?? cur.output_per_million
      };
    }
  } catch {
    // No saved rates is the normal case on a fresh install.
  }
}

async function persist(rates: CostRates): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
    await fs.writeFile(STORE_FILE, JSON.stringify(rates, null, 2), 'utf8');
  } catch (e) {
    // The in-memory override still applies for this process; a read-only volume
    // should not make the dashboard unusable.
    console.warn(`[cost-rates] could not persist rates: ${(e as Error).message}`);
  }
}

/** Costs a token count at the current rates. Rounded to 10dp to match the ledger. */
export function rateCost(tokens: number, perMillion: number): number {
  return Math.round((tokens * perMillion) / 1_000_000 * 1e10) / 1e10;
}