import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { apply } from '../index.js'
import { sha256 } from '../lib/archive.js'
import { EDIT_TOOL_NAME, WRITE_TOOL_NAME } from '../lib/fusion.js'
import { RECALL_TOOL_NAME } from '../lib/observation.js'
import { RECEIPT_MARKER } from '../lib/reducer.js'
import { createFakeCtx, fakeSession, tokenUsageState } from './fake-ctx.js'

/** Every test home made by {@link buildAll}, removed once the file is done. */
const homes = []
after(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  homes.length = 0
})

/**
 * End-to-end wiring test (`notes/e2e-design.md`).
 *
 * This file does not re-test one mechanism. It proves the five mechanisms are
 * wired to each other: one composed post-execute listener with a fixed order,
 * one pre-step listener, and a ledger where each kind of line appears once.
 *
 * The two ordering facts it leans on:
 * - `composePostExecute` gives each handler the previous handler's decision as
 *   its `next` (`index.js`), so the Reducer runs before ObservationPack.
 * - A waterfall listener may call `next()` only once
 *   (`asar:cordis/lib/index.js:317-325`); `test/fake-ctx.js` mirrors that.
 */

const SESSION_ID = 'session-e2e-1'
const CONTEXT_WINDOW = 1000000
const MAX_TOKENS = 384000

/** A shell result that failed by exit code but is NOT `isError` (`report.md` 2.1). */
function failedShellResult(text) {
  return { isError: false, content: [{ type: 'text', text }], value: { exitCode: 1, stdout: text } }
}

/** A successful shell result. */
function okShellResult(text) {
  return { isError: false, content: [{ type: 'text', text }], value: { exitCode: 0, stdout: text } }
}

/**
 * Build failing test output large enough to cross every threshold.
 * @param {number} lines - how many case blocks to emit.
 * @returns {string} the text.
 */
function bigLog(lines) {
  const parts = ['$ node --test', '']
  for (let index = 0; index < lines; index += 1) {
    parts.push(`not ok ${String(index)} - case ${String(index)}`)
    parts.push(`  AssertionError: expected ${String(index)} to equal ${String(index + 1)}`)
    parts.push('    at test/example.test.js:12:9')
  }
  parts.push('', '# fail 1', 'Error: 1 test failed')
  return parts.join('\n')
}

/**
 * A receipt the Reducer accepts: its quote is an exact substring of the log.
 * @param {string} sourceSha256 - the digest the receipt must name.
 * @returns {string} the JSON reply.
 */
function validReceipt(sourceSha256) {
  return JSON.stringify({
    schema: 'dsh-sol-evidence-receipt/1',
    source_sha256: sourceSha256,
    // The Reducer states `is_error=true` to the model: only failed commands are
    // reduced, even though a non-zero exit is `isError: false` (report.md 2.1).
    status: 'failure',
    uncertain: false,
    evidence: [{ kind: 'fatal', quote: 'Error: 1 test failed' }],
  })
}

/**
 * A fake `llm.stream` answering with one fixed text.
 * @param {string} reply - the model's reply.
 * @returns {Function} the stream factory.
 */
function fakeStream(reply) {
  return async function* stream() {
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 40 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * The session fake carrying what the five mechanisms read.
 * @param {number} count - surface node count.
 * @param {number} tokens - tokens per surface node.
 * @returns {object} the session.
 */
function e2eSession(count = 60, tokens = 12000) {
  const nodes = []
  const nodeTokens = []
  for (let index = 0; index < count; index += 1) {
    nodes.push(index + 1)
    nodeTokens.push(tokens)
  }
  const base = fakeSession(SESSION_ID)
  return {
    ...base,
    surface: { nodes },
    nodeTokens,
    eventAt(seq) {
      // Every node is a plain assistant message: no open tool call crosses a cut.
      return { type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [] } } }
    },
    requestHeader() {
      return { config: { provider: 'fake-provider', model: 'fake-model', maxTokens: MAX_TOKENS } }
    },
  }
}

/**
 * Build a fake context with all five mechanisms on.
 * @param {object} [options] - the setup.
 * @param {string} [options.reply] - the reducer model reply.
 * @param {object} [options.reducer] - reducer config overrides.
 * @param {object} [options.occ] - occ config overrides.
 * @returns {object} the bundle.
 */
/**
 * Build a fake context with all five mechanisms on.
 *
 * The bundle owns a fresh home and registers its own cleanup on the test that
 * asked for it: `t.after` runs even when the test fails, and a module-level
 * `after` hook does not fire in every `node --test` process mode.
 *
 * @param {object} [options] - the setup.
 * @param {string} [options.reply] - the reducer model reply.
 * @param {object} [options.reducer] - reducer config overrides.
 * @param {object} [options.occ] - occ config overrides.
 * @param {object} [options.t] - the test context, for cleanup.
 * @returns {object} the bundle.
 */
function buildAll({ reply, reducer = {}, occ = {}, t } = {}) {
  const session = e2eSession()
  // One fresh home per bundle: the ledger and objects are real files, and a
  // shared directory would make every object assertion depend on run order.
  const home = mkdtempSync(join(tmpdir(), 'dsh-sol-e2e-'))
  if (t !== undefined) {
    t.after(() => rm(home, { recursive: true, force: true }).catch(() => {}))
  } else {
    homes.push(home)
  }
  const compactCalls = []
  const recorded = []
  const fake = createFakeCtx({
    projectionState: {
      tokenUsage: tokenUsageState({ uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    },
    agent: { session },
    services: {
      tokenMeter: {
        measure: () => ({
          totalTokens: session.nodeTokens.reduce((sum, value) => sum + value, 0),
          nodes: session.nodeTokens.map((tokens, index) => ({ seq: index + 1, tokens, heuristicTokens: tokens })),
        }),
      },
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: CONTEXT_WINDOW }, defaultMaxTokens: MAX_TOKENS }),
        stream: () => fakeStream(reply ?? '{}')(),
      },
      agentPresets: { serviceFor: () => undefined },
      compaction: {
        compactRegion: async (...args) => {
          compactCalls.push(args)
          return { shadowedTokenCount: 1 }
        },
      },
    },
  })
  // Capture the ledger sink by replacing the archive module's writer is not
  // needed: the lines land under the fake home, which a test can read.
  apply(fake.ctx, {
    meter: { enabled: true, home },
    actionFusion: { enabled: true },
    observationPack: { enabled: true },
    reducer: { enabled: true, provider: 'fake-provider', model: 'fake-model', ...reducer },
    occ: { enabled: true, ...occ },
  })
  return { fake, session, compactCalls, recorded, home }
}

/**
 * The archive directory for one session under a test home.
 * @param {string} home - the test home.
 * @param {string} sessionId - the session id.
 * @returns {string} the objects directory.
 */
function objectsDirOf(home, sessionId) {
  return join(home, 'dsh-sol', sessionId, 'objects')
}

/**
 * Read every ledger line for one session.
 * @param {string} home - the test home.
 * @param {string} sessionId - the session id.
 * @returns {Promise<object[]>} the parsed lines, malformed ones skipped.
 */
async function readLedger(home, sessionId) {
  let text
  try {
    text = await readFile(join(home, 'dsh-sol', sessionId, 'ledger.jsonl'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const lines = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      lines.push(JSON.parse(raw))
    } catch {
      // A torn last line is not this test's concern.
    }
  }
  return lines
}

/**
 * Run the plugin's single composed post-execute listener.
 * @param {object} fake - the fake bundle.
 * @param {object} exec - the execution.
 * @param {object} result - the tool result.
 * @returns {Promise<object>} the decision.
 */
async function postExecute(fake, exec, result) {
  return fake.waterfall('tools/post-execute', exec, result, async () => ({ kind: 'accept' }))
}

/**
 * Read the text a decision hands to the model.
 * @param {object} decision - the post-execute decision.
 * @returns {string} the joined text.
 */
function decisionText(decision) {
  return (decision.content ?? []).map((block) => block.text ?? '').join('')
}

test('e2e: one post-execute listener, one pre-step listener, two session listeners', (t) => {
  const { fake } = buildAll({ t })
  assert.equal(fake.listenerCount('tools/post-execute'), 1, 'composePostExecute must be the only post-execute listener')
  assert.equal(fake.listenerCount('agent/pre-step'), 1, 'OCC is the only pre-step listener')
  assert.equal(fake.listenerCount('session/event'), 2, 'Meter and OCC each own one')
  assert.equal(fake.listenerCount('session/created'), 1, 'Meter')
  assert.equal(fake.listenerCount('session/disposed'), 2, 'Meter and OCC')
})

test('e2e: five mechanisms register three tools, and obs_recall only once', (t) => {
  const { fake } = buildAll({ t })
  const names = fake.fakeTools.registered.map((definition) => definition.name)
  assert.deepEqual(names.slice().sort(), [EDIT_TOOL_NAME, RECALL_TOOL_NAME, WRITE_TOOL_NAME].sort())
  assert.equal(
    names.filter((entry) => entry === RECALL_TOOL_NAME).length,
    1,
    'obs_recall must not be registered twice',
  )
})

test('e2e: everything off registers nothing at all', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, {})
  assert.equal(fake.listenerCount('tools/post-execute'), 0)
  assert.equal(fake.listenerCount('agent/pre-step'), 0)
  assert.equal(fake.listenerCount('session/event'), 0)
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('e2e: a 60 KB failure becomes a receipt, because the Reducer runs before ObservationPack', async (t) => {
  const body = bigLog(800)
  assert.ok(Buffer.byteLength(body, 'utf8') > 60 * 1024, 'the fixture must exceed both thresholds')
  const { fake, session, home } = buildAll({ reply: validReceipt(sha256(body)), t })
  const exec = {
    name: 'pwsh',
    callId: 'call-e2e-receipt',
    arguments: { command: 'node --test' },
    agent: { session },
    signal: new AbortController().signal,
  }

  const decision = await postExecute(fake, exec, failedShellResult(body))
  const text = decisionText(decision)

  assert.ok(text.includes(RECEIPT_MARKER), `expected a receipt, got: ${text.slice(0, 200)}`)
  assert.ok(!text.includes('[large tool result replaced'), 'ObservationPack must not have replaced the receipt')
  assert.ok(text.length < body.length, 'the receipt must be smaller than the log')

  // The receipt path must leave no trace of a replacement: no observation line
  // for this call, and exactly one archived object (the log the receipt quotes).
  // A reversed order still ends in a receipt, but it archives twice and writes
  // an observation line — which is what these two assertions catch.
  const lines = await readLedger(home, session.header.id)
  assert.equal(
    lines.filter((line) => line.kind === 'observation' && line.callId === exec.callId).length,
    0,
    'no observation line may exist for the receipt path',
  )
  const objects = await readdir(join(objectsDirOf(home, session.header.id)))
  assert.equal(objects.length, 1, `exactly one archived object, got: ${objects.join(', ')}`)
  assert.equal(objects[0], `${sha256(body)}.txt`, 'the object is the log the receipt quotes')
})

test('e2e: a large successful output is replaced by ObservationPack instead', async (t) => {
  const body = bigLog(800)
  const { fake, session } = buildAll({ reply: validReceipt(sha256(body)), t })
  const exec = {
    name: 'pwsh',
    callId: 'call-e2e-placeholder',
    arguments: { command: 'node --test' },
    agent: { session },
    signal: new AbortController().signal,
  }

  const decision = await postExecute(fake, exec, okShellResult(body))
  const text = decisionText(decision)

  assert.ok(text.includes('[large tool result replaced'), `expected a placeholder, got: ${text.slice(0, 200)}`)
  assert.ok(text.includes('id: obs_'), 'the placeholder must carry an observation id')
  assert.ok(!text.includes(RECEIPT_MARKER), 'a successful result is never reduced')
})

test('e2e: a truncated output is neither reduced nor replaced', async (t) => {
  const body = `${bigLog(800)}\n[output truncated; full output: C:\\tmp\\pwsh-1.log]`
  const { fake, session } = buildAll({ reply: validReceipt(sha256(body)), t })
  const exec = {
    name: 'pwsh',
    callId: 'call-e2e-truncated',
    arguments: { command: 'node --test' },
    agent: { session },
    signal: new AbortController().signal,
  }

  const decision = await postExecute(fake, exec, failedShellResult(body))
  const text = decisionText(decision)
  assert.ok(!text.includes(RECEIPT_MARKER), 'a truncated log must not be reduced')
})

test('e2e: a nested call is left alone by both mechanisms', async (t) => {
  const body = bigLog(800)
  const { fake, session } = buildAll({ reply: validReceipt(sha256(body)), t })
  const exec = {
    name: 'pwsh',
    callId: 'call-e2e-nested',
    arguments: { command: 'node --test' },
    agent: { session },
    signal: new AbortController().signal,
    parent: { token: 'parent-token' },
  }

  const decision = await postExecute(fake, exec, failedShellResult(body))
  const text = decisionText(decision)
  assert.ok(!text.includes(RECEIPT_MARKER), 'a nested call is not reduced')
  assert.ok(!text.includes('[large tool result replaced'), 'a nested call is not replaced')
})

test('e2e: the dry-run pre-step records a decision and never compacts', async (t) => {
  const { fake, session, compactCalls } = buildAll({ reply: validReceipt('x'), t })
  // One completed todo step is the boundary.
  fake.emit('session/event', session, {
    type: 'todo/write',
    seq: 90,
    data: { todos: [{ content: 'change a.js', status: 'in_progress' }] },
  })
  fake.emit('session/event', session, {
    type: 'todo/write',
    seq: 100,
    data: { todos: [{ content: 'change a.js', status: 'completed' }] },
  })

  let nextCalls = 0
  const decision = await fake.waterfall('agent/pre-step', { turn: 2, step: 3, signal: new AbortController().signal }, async () => {
    nextCalls += 1
    return { kind: 'enter', messages: [] }
  })

  assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'pre-step must return the downstream decision')
  assert.equal(nextCalls, 1, 'pre-step must call next exactly once')
  assert.equal(compactCalls.length, 0, 'dryRun must never compact')
})

test('e2e: with dryRun off the same step compacts exactly once', async (t) => {
  const { fake, session, compactCalls } = buildAll({ reply: validReceipt('x'), occ: { dryRun: false }, t })
  fake.emit('session/event', session, {
    type: 'todo/write',
    seq: 90,
    data: { todos: [{ content: 'change a.js', status: 'in_progress' }] },
  })
  fake.emit('session/event', session, {
    type: 'todo/write',
    seq: 100,
    data: { todos: [{ content: 'change a.js', status: 'completed' }] },
  })

  await fake.waterfall('agent/pre-step', { turn: 2, step: 3, signal: new AbortController().signal }, async () => ({
    kind: 'enter',
    messages: [],
  }))

  assert.equal(compactCalls.length, 1, 'exactly one compaction')
  const [start, end, agent, signal] = compactCalls[0]
  assert.equal(typeof start, 'number', 'start must be a surface seq')
  assert.equal(typeof end, 'number', 'end must be a surface seq')
  assert.ok(start <= end, 'start must not be after end')
  assert.equal(agent.session, session)
  assert.ok(signal !== undefined, 'a cancellation signal must be forwarded')
})

test('e2e: a downstream failure escapes and next is still called only once', async (t) => {
  const { fake } = buildAll({ reply: validReceipt('x'), t })
  let nextCalls = 0
  await assert.rejects(
    fake.waterfall('agent/pre-step', { turn: 2, step: 3, signal: new AbortController().signal }, async () => {
      nextCalls += 1
      throw new Error('downstream boom')
    }),
    /downstream boom/u,
  )
  assert.equal(nextCalls, 1, 'the error must escape and next must not be retried')
})

test('e2e: unloading removes every listener and tool', (t) => {
  const { fake } = buildAll({ reply: validReceipt('x'), t })
  assert.ok(fake.listenerCount('tools/post-execute') > 0)
  fake.disposeAll()
  assert.equal(fake.listenerCount('tools/post-execute'), 0)
  assert.equal(fake.listenerCount('agent/pre-step'), 0)
  assert.equal(fake.listenerCount('session/event'), 0)
  assert.equal(fake.fakeTools.registered.length, 0)
})
