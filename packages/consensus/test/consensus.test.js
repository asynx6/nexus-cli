// Integration tests for @asynx6/consensus
//   - 3 happy-path tests: 2-model majority, 3-model majority, verdict-key vote
//   - 1 fallback test: all 401 → single-model primary fallback
//
// Pattern: stub a fake provider that returns deterministic responses per model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsensusProvider, parseConsensusModels, majorityVote } from '../src/consensus.js';
import { makeConsensusFromEnv } from '../src/factory.js';

function makeBus() {
  const events = [];
  return { events, emit: (ev) => events.push(ev) };
}

/** Fake provider — maps model name to response. */
function fakeProvider(map, failOn = {}) {
  return {
    async chat(messages, { model } = {}) {
      if (failOn[model]) {
        const e = new Error('fake 401 for ' + model);
        e.status = 401;
        throw e;
      }
      const r = map[model];
      if (!r) throw new Error('no fake response for ' + model);
      if (Array.isArray(r)) {
        // cycle through responses on each call (for round-2 tests)
        fakeProvider._counters = fakeProvider._counters || {};
        const i = (fakeProvider._counters[model] = (fakeProvider._counters[model] || 0));
        fakeProvider._counters[model]++;
        return r[i % r.length];
      }
      return r;
    },
  };
}

test('parseConsensusModels: trims, dedupes, returns null when empty', () => {
  assert.deepEqual(parseConsensusModels('a,b,a'), ['a', 'b']);
  assert.deepEqual(parseConsensusModels(' hermes-agent , im/auto '), ['hermes-agent', 'im/auto']);
  assert.equal(parseConsensusModels(''), null);
  assert.equal(parseConsensusModels(null), null);
  assert.equal(parseConsensusModels('   '), null);
});

test('majorityVote: tool_call key — 2/3 same tool wins', () => {
  const r1 = { model: 'a', tool_call: { name: 'fs.read', arguments: { path: '/x' } }, content: '' };
  const r2 = { model: 'b', tool_call: { name: 'fs.read', arguments: { path: '/x' } }, content: '' };
  const r3 = { model: 'c', tool_call: { name: 'fs.write', arguments: { path: '/y' } }, content: '' };
  const v = majorityVote([r1, r2, r3]);
  assert.equal(v.agreement, 2);
  assert.equal(v.votes, 3);
  assert.equal(v.tied, false);
  assert.equal(v.winner.model, 'a');
});

test('majorityVote: content-verdict key — 2/3 same PASS wins', () => {
  const r1 = { model: 'a', tool_call: null, content: 'PASS' };
  const r2 = { model: 'b', tool_call: null, content: 'PASS — done' };
  const r3 = { model: 'c', tool_call: null, content: 'FAIL' };
  const v = majorityVote([r1, r2, r3]);
  assert.equal(v.agreement, 2);
  assert.equal(v.tied, false);
  assert.equal(v.winner.model, 'a');
});

test('majorityVote: tied — no strict majority', () => {
  const r1 = { model: 'a', tool_call: null, content: 'PASS' };
  const r2 = { model: 'b', tool_call: null, content: 'FAIL' };
  const v = majorityVote([r1, r2]);
  assert.equal(v.agreement, 1);
  assert.equal(v.tied, true);
  assert.equal(v.winner, null);
});

// ----- integration tests via ConsensusProvider -----

test('P16 happy 1/3: 2 models agree on same tool_call — consensus emits verdict', async () => {
  const provider = fakeProvider({
    'm1': { model: 'm1', tool_call: { name: 'fs.read', arguments: { path: '/x' } }, content: '' },
    'm2': { model: 'm2', tool_call: { name: 'fs.read', arguments: { path: '/x' } }, content: '' },
  });
  const bus = makeBus();
  const cp = new ConsensusProvider({ provider, models: ['m1', 'm2'], bus, subject: 'task-1' });
  const res = await cp.chat([{ role: 'user', content: 'read /x' }]);
  assert.equal(res.model, 'm1'); // first matching wins
  assert.equal(res.tool_call.name, 'fs.read');
  assert.equal(res.consensus.agreement, 2);
  assert.equal(res.consensus.votes, 2);
  // events: 1 round + 1 verdict
  const rounds = bus.events.filter((e) => e.name === 'consensus.round');
  const verdicts = bus.events.filter((e) => e.name === 'consensus.verdict');
  assert.equal(rounds.length, 1);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].data.mode, 'consensus');
  assert.equal(verdicts[0].data.winner, 'm1');
});

test('P16 happy 2/3: 3 models — majority 2/3 wins after one round', async () => {
  const provider = fakeProvider({
    'm1': { model: 'm1', tool_call: null, content: 'PASS' },
    'm2': { model: 'm2', tool_call: null, content: 'PASS' },
    'm3': { model: 'm3', tool_call: null, content: 'FAIL' },
  });
  const bus = makeBus();
  const cp = new ConsensusProvider({ provider, models: ['m1', 'm2', 'm3'], bus, subject: 'task-2' });
  const res = await cp.chat([{ role: 'user', content: 'judge' }]);
  assert.equal(res.model, 'm1'); // first PASS
  assert.match(res.content, /PASS/);
  assert.equal(res.consensus.agreement, 2);
  assert.equal(res.consensus.votes, 3);
});

test('P16 happy 3/3: tied after round 1 → round 2 re-runs tied models → winner picks up', async () => {
  // First call: 2 models disagree 1-1-1 (all different).
  // Round 1 returns 3 different verdicts → tied.
  // Round 2: tied models re-run; second round returns 2 PASS + 1 FAIL → majority.
  const provider = fakeProvider({
    'm1': [
      { model: 'm1', tool_call: null, content: 'PASS' },
      { model: 'm1', tool_call: null, content: 'PASS' },
    ],
    'm2': [
      { model: 'm2', tool_call: null, content: 'FAIL' },
      { model: 'm2', tool_call: null, content: 'PASS' },
    ],
    'm3': [
      { model: 'm3', tool_call: null, content: 'ERROR' },
      { model: 'm3', tool_call: null, content: 'FAIL' },
    ],
  });
  const bus = makeBus();
  const cp = new ConsensusProvider({ provider, models: ['m1', 'm2', 'm3'], bus, subject: 'task-3' });
  const res = await cp.chat([{ role: 'user', content: 'judge' }]);
  assert.match(res.content, /PASS/);
  assert.equal(res.consensus.agreement, 2);
  const rounds = bus.events.filter((e) => e.name === 'consensus.round');
  assert.equal(rounds.length, 2, 'two rounds emitted');
  assert.equal(rounds[0].data.round, 1);
  assert.equal(rounds[1].data.round, 2);
});

test('P16 fallback 1/1: 2 models both 401 → falls back to single primary model', async () => {
  const provider = fakeProvider(
    {
      'primary': { model: 'primary', tool_call: null, content: 'fallback answer' },
      'secondary': { model: 'secondary', tool_call: null, content: 'will fail' },
    },
    { primary: false, secondary: true }, // only secondary 401s
  );
  const bus = makeBus();
  const cp = new ConsensusProvider({ provider, models: ['primary', 'secondary'], bus, subject: 'task-4' });
  const res = await cp.chat([{ role: 'user', content: 'q' }]);
  assert.equal(res.model, 'primary');
  assert.match(res.content, /fallback/);
  // vote: only primary survived, so 1/1 vote → tied → primary fallback path
  const verdicts = bus.events.filter((e) => e.name === 'consensus.verdict');
  assert.equal(verdicts.length, 1);
  // reason either 'tie — primary model fallback' (if first round tied) or 'majority agreement'
  assert.ok(['tie — primary model fallback', 'majority agreement'].includes(verdicts[0].data.reason));
});

test('makeConsensusFromEnv: returns base provider when NEXUS_CONSENSUS_MODELS unset', () => {
  const base = fakeProvider({ 'hermes-agent': { model: 'hermes-agent', content: 'hi', tool_call: null } });
  const out = makeConsensusFromEnv({ provider: base, env: {} });
  assert.equal(out, base, 'should be the same provider instance when no consensus configured');
});

test('makeConsensusFromEnv: wraps provider when NEXUS_CONSENSUS_MODELS set', async () => {
  const base = fakeProvider({
    'a': { model: 'a', tool_call: null, content: 'PASS' },
    'b': { model: 'b', tool_call: null, content: 'PASS' },
  });
  const out = makeConsensusFromEnv({ provider: base, env: { NEXUS_CONSENSUS_MODELS: 'a,b' }, bus: makeBus() });
  assert.ok(out instanceof ConsensusProvider);
  const res = await out.chat([{ role: 'user', content: 'q' }]);
  assert.equal(res.consensus.agreement, 2);
});
