const PRICES_PER_MILLION_TOKENS = {
  'gpt-6.2-astra': { input: 8, cached: 0.4, output: 40 },
  'gpt-6.2-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
};

export function calculateCost(model, usage) {
  const prices = PRICES_PER_MILLION_TOKENS[model];
  if (
    !prices ||
    !usage ||
    !Number.isFinite(usage.input_tokens) ||
    !Number.isFinite(usage.output_tokens)
  )
    return null;
  const input = usage.input_tokens;
  const cached = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  if (
    input < 0 ||
    cached < 0 ||
    cacheWrite < 0 ||
    cached + cacheWrite > input ||
    usage.output_tokens < 0
  )
    return null;
  const longInput = input > 272_000 ? 2 : 1;
  const longOutput = input > 272_000 ? 1.5 : 1;
  return (
    ((input - cached - cacheWrite) * prices.input * longInput +
      cached * prices.cached * longInput +
      cacheWrite * prices.input * 1.25 * longInput +
      usage.output_tokens * prices.output * longOutput) /
    1_000_000
  );
}
