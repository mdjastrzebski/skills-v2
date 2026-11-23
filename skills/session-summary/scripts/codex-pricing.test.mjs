import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calculateCost } from './codex-pricing.mjs';

const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prices cached, uncached, cache write and output tokens', () => {
  const usage = {
    input_tokens: 1_000_000,
    cached_input_tokens: 200_000,
    cache_write_input_tokens: 100_000,
    output_tokens: 100_000,
  };
  assert.equal(calculateCost('gpt-6.1-terra', usage), 2.42);
  assert.equal(calculateCost('unknown', usage), null);
  assert.equal(calculateCost('gpt-6.1-terra', { ...usage, cached_input_tokens: 2_000_000 }), null);
});

test('prices each request once and includes subagents', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-summary-'));
  tempRoots.push(home);
  const dir = join(home, 'sessions');
  mkdirSync(dir);
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 };
  const root = [
    { type: 'session_meta', payload: { id: 'root', cwd: home } },
    { type: 'turn_context', payload: { turn_id: 'turn', model: 'gpt-6.1-terra' } },
    { type: 'token_usage_record', payload: { thread_id: 'root', turn_id: 'turn', usage } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } },
  ];
  const child = [
    {
      type: 'session_meta',
      payload: {
        id: 'child',
        source: {
          subagent: { thread_spawn: { parent_thread_id: 'root', agent_path: '/root/task' } },
        },
      },
    },
    { type: 'turn_context', payload: { turn_id: 'child-turn', model: 'gpt-6-luna' } },
    { type: 'token_usage_record', payload: { thread_id: 'child', turn_id: 'child-turn', usage } },
  ];
  const file = join(dir, 'rollout-root.jsonl');
  writeFileSync(file, root.map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'rollout-child.jsonl'), child.map(JSON.stringify).join('\n'));
  const script = fileURLToPath(new URL('./summary.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [script, file], {
    cwd: home,
    env: { ...process.env, HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
    encoding: 'utf8',
  });
  assert.match(output, /Main agent: gpt-6.1-terra, \$2.00/);
  assert.match(output, /Subagents: 1, \$0.20/);
  assert.match(output, /Total: \$2.20/);
});
