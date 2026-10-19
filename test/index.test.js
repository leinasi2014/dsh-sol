import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, composePostExecute, createArchiverFor, inject, name } from '../index.js'
import { EDIT_TOOL_NAME, WRITE_TOOL_NAME } from '../lib/fusion.js'
import { DEFAULT_THRESHOLD_BYTES as CONFIG_THRESHOLD } from '../lib/config.js'
import {
  DEFAULT_THRESHOLD_BYTES as OBSERVATION_THRESHOLD,
  RECALL_TOOL_NAME,
  createObservationHandler,
} from '../lib/observation.js'
import { RECEIPT_SCHEMA, createReducerHandler } from '../lib/reducer.js'
import { createFakeCtx, fakeSession, tokenUsageState, turnEnd } from './fake-ctx.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

/**
 * A throwaway home directory, removed when the test finishes.
 *
 * These tests only pass a `home` as configuration and never append a ledger
 * line, so nothing would be written today. A literal path is still wrong: it
 * makes the suite depend on that staying true, and one added `turn/end` would
 * create real files under `C:/`. A temp directory costs nothing and cannot rot.
 *
 * @param {object} t - the test context.
 * @returns {string} the absolute path.
 */
function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sol-index-'))
  t.after(() => rm(home, { recursive: true, force: true }).catch(() => {}))
  return home
}

/**
 * Read every ledger line for one session under a home.
 * @param {string} home - the home.
 * @param {string} sessionId - the session id.
 * @returns {Promise<object[]>} the parsed lines, malformed ones skipped.
 */
async function readLedgerLines(home, sessionId) {
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

test('the plugin exports one form: apply with an inject list', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(name, 'dsh-sol')
  assert.deepEqual(inject, ['sessionProjections', 'tools'])
})

test('the default row registers nothing at all', () => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState({ uncachedInputTokens: 1 }) } })
  apply(fake.ctx, {})
  assert.equal(fake.listenerCount('session/event'), 0)
  assert.equal(fake.listenerCount('session/created'), 0)
  assert.equal(fake.listenerCount('session/disposed'), 0)
  assert.equal(fake.effects.length, 0)
  assert.equal(fake.fakeTools.registered.length, 0, 'no tool may be registered when everything is off')
  fake.emit('session/event', fakeSession(GOOD_ID), turnEnd(1))
})

test('meter on and fusion off registers no tool', (t) => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState({ uncachedInputTokens: 1 }) } })
  apply(fake.ctx, { meter: { enabled: true, home: tempHome(t) }, actionFusion: { enabled: false } })
  assert.equal(fake.listenerCount('session/event'), 1)
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('fusion on registers exactly the two tools', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { actionFusion: { enabled: true } })
  assert.deepEqual(
    fake.fakeTools.registered.map((definition) => definition.name),
    [EDIT_TOOL_NAME, WRITE_TOOL_NAME],
  )
  assert.equal(fake.listenerCount('session/event'), 0, 'fusion alone adds no session listener')
})

test('both mechanisms on register both sets', (t) => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState({ uncachedInputTokens: 1 }) } })
  apply(fake.ctx, { meter: { enabled: true, home: tempHome(t) }, actionFusion: { enabled: true } })
  assert.equal(fake.listenerCount('session/event'), 1)
  assert.deepEqual(
    fake.fakeTools.registered.map((definition) => definition.name),
    [EDIT_TOOL_NAME, WRITE_TOOL_NAME],
  )
})

test('the configured shell list reaches the fusion tools', async () => {
  const fake = createFakeCtx()
  const fakeTools = fake.fakeTools
  fakeTools.tools.get = (toolName, scope) => {
    fakeTools.looked.push({ name: toolName, scope, argumentCount: 2 })
    // The built-in `bash` declares a `oneOf` of object schemas
    // (`asar:dsh-tool-bash/lib/index.js:530-535`).
    return toolName === 'bash'
      ? { name: 'bash', output: { schema: { oneOf: [{ type: 'object' }] } } }
      : undefined
  }
  fakeTools.tools.execute = async (exec) => {
    fakeTools.executed.push(exec)
    if (exec.name === 'edit') {
      return { isError: false, content: [{ type: 'text', text: 'edited' }], value: { path: 'C:/w/a.txt', after: 'c' } }
    }
    return { isError: false, content: [{ type: 'text', text: 'ok' }], value: { exitCode: 0, timedOut: false } }
  }
  apply(fake.ctx, { actionFusion: { enabled: true, shells: ['pwsh', 'bash'] } })
  const tool = fakeTools.registered.find((definition) => definition.name === EDIT_TOOL_NAME)
  const agent = { id: 'agent-1' }
  const value = await tool.execute(
    { file_path: 'C:/w/a.txt', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    {
      token: Symbol('t'), callId: 'c1', rootCallId: 'c1', agent, signal: new AbortController().signal,
    },
  )
  // pwsh is first in the configured list but absent, so bash is used.
  assert.equal(value.shell, 'bash')
  assert.deepEqual(fakeTools.looked.map((call) => call.name), ['pwsh', 'bash'])
  void GOOD_ID
})

test('the manifest carries the documented fields', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'dsh-sol')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.engines?.dsh, '>=0.2.1-rc.2 <0.3.0')
  for (const required of ['index.js', 'lib', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(required), `files must cover ${required}`)
  }
})

test('both locale files carry a human title and a description, not the package name', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const lang of ['en', 'zh']) {
    const text = await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(typeof parsed.meta?.title, 'string', lang)
    assert.equal(typeof parsed.meta?.description, 'string', lang)
    assert.notEqual(parsed.meta.title, 'dsh-sol', `${lang} title must not be the bare package name`)
    assert.ok(parsed.meta.title.trim().length > 3, lang)
    assert.ok(parsed.meta.description.trim().length > 10, lang)
  }
})

test('the default row from the shipped patch registers nothing', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const patch = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /disabled: true/u)
  assert.match(patch, /enabled: false/u)
  assert.match(patch, /id: sol$/mu)
  assert.match(patch, /name: dsh-sol$/mu)
})

test('an enabled meter registers exactly the three session listeners', (t) => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState({ uncachedInputTokens: 1 }) } })
  apply(fake.ctx, { meter: { enabled: true, home: tempHome(t) } })
  assert.equal(fake.listenerCount('session/event'), 1)
  assert.equal(fake.listenerCount('session/created'), 1)
  assert.equal(fake.listenerCount('session/disposed'), 1)
  assert.equal(fake.effects.length, 1)
})

test('unloading the plugin removes every listener and tool', (t) => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState({ uncachedInputTokens: 1 }) } })
  apply(fake.ctx, { meter: { enabled: true, home: tempHome(t) }, actionFusion: { enabled: true } })
  assert.equal(fake.fakeTools.registered.length, 2)
  fake.disposeAll()
  assert.equal(fake.listenerCount('session/event'), 0)
  assert.equal(fake.listenerCount('session/created'), 0)
  assert.equal(fake.listenerCount('session/disposed'), 0)
  assert.equal(fake.fakeTools.registered.length, 0, 'unloading must remove both tools')
})

test('a bad config fails loud at activation instead of silently disabling', () => {
  const fake = createFakeCtx()
  assert.throws(() => apply(fake.ctx, { meter: { enabled: 'yes' } }), /must be a boolean/u)
  assert.equal(fake.listenerCount('session/event'), 0)
})

test('an undeclared key still fails loud, naming the key', () => {
  const fake = createFakeCtx()
  assert.throws(() => apply(fake.ctx, { actionFusion: { enable: true } }), /unknown key/u)
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('every documented mechanism now mounts instead of being refused', () => {
  const fake = createFakeCtx()
  for (const key of ['meter', 'actionFusion', 'observationPack', 'reducer', 'occ']) {
    assert.doesNotThrow(() => apply(createFakeCtx().ctx, { [key]: { enabled: false } }), key)
  }
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('the shipped patch config parses through resolveConfig', async () => {
  const { resolveConfig } = await import('../lib/config.js')
  const config = resolveConfig({ meter: { enabled: false } })
  assert.equal(config.meter.enabled, false)
  assert.equal(config.actionFusion.enabled, false)
  assert.deepEqual(config.actionFusion.shells, ['ops_bash', 'pwsh', 'bash'])
  assert.equal(config.observationPack.enabled, false)
  assert.equal(config.observationPack.thresholdBytes, CONFIG_THRESHOLD)
})

test('the two threshold defaults are the same number', () => {
  // config.js duplicates the constant to stay a leaf module; a drift would make
  // the documented default disagree with the behaviour.
  assert.equal(CONFIG_THRESHOLD, OBSERVATION_THRESHOLD)
  assert.equal(CONFIG_THRESHOLD, 10 * 1024)
})

test('observationPack on registers obs_recall and exactly one post-execute listener', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { observationPack: { enabled: true } })
  assert.deepEqual(fake.fakeTools.registered.map((definition) => definition.name), [RECALL_TOOL_NAME])
  assert.equal(fake.listenerCount('tools/post-execute'), 1, 'one listener for the whole plugin')
  assert.equal(fake.listenerCount('session/event'), 0)
})

test('observationPack off registers neither the listener nor the tool', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { observationPack: { enabled: false } })
  assert.equal(fake.listenerCount('tools/post-execute'), 0)
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('a misspelled observationPack key fails loud', () => {
  const fake = createFakeCtx()
  assert.throws(() => apply(fake.ctx, { observationPack: { enable: true } }), /unknown key/u)
  assert.equal(fake.listenerCount('tools/post-execute'), 0)
})

test('a non-integer thresholdBytes fails loud', () => {
  const fake = createFakeCtx()
  assert.throws(() => apply(fake.ctx, { observationPack: { enabled: true, thresholdBytes: 0 } }),
    /positive integer/u)
  assert.throws(() => apply(fake.ctx, { observationPack: { enabled: true, thresholdBytes: '1k' } }),
    /positive integer/u)
})

test('observationPack and fusion together still add one post-execute listener', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { actionFusion: { enabled: true }, observationPack: { enabled: true } })
  assert.equal(fake.listenerCount('tools/post-execute'), 1)
  assert.deepEqual(
    fake.fakeTools.registered.map((definition) => definition.name),
    [EDIT_TOOL_NAME, WRITE_TOOL_NAME, RECALL_TOOL_NAME],
  )
})

test('unloading removes the post-execute listener and obs_recall', () => {
  const fake = createFakeCtx()
  apply(fake.ctx, { observationPack: { enabled: true } })
  assert.equal(fake.listenerCount('tools/post-execute'), 1)
  fake.disposeAll()
  assert.equal(fake.listenerCount('tools/post-execute'), 0)
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('composed handlers run in order and each sees the previous decision', async () => {
  const seen = []
  const first = async (exec, result, next) => {
    const decision = await next()
    seen.push(['first', decision])
    return { kind: 'accept', content: [{ type: 'text', text: 'first' }] }
  }
  const second = async (exec, result, next) => {
    const decision = await next()
    seen.push(['second', decision])
    return decision
  }
  const composed = composePostExecute([first, second])
  const result = await composed({}, {}, async () => ({ kind: 'accept' }))
  assert.deepEqual(seen.map(([who]) => who), ['first', 'second'])
  assert.deepEqual(seen[1][1], { kind: 'accept', content: [{ type: 'text', text: 'first' }] })
  assert.deepEqual(result, { kind: 'accept', content: [{ type: 'text', text: 'first' }] })
})

test('a throwing step keeps the decision from before it', async () => {
  const warnings = []
  const boom = async () => {
    throw new Error('step failed')
  }
  const composed = composePostExecute([boom], (message) => warnings.push(message))
  const decision = await composed({}, {}, async () => ({ kind: 'accept' }))
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /kept the previous decision/u)
})

test('the archiver factory refuses a call with no owning session', (t) => {
  const archiverFor = createArchiverFor(tempHome(t))
  assert.throws(() => archiverFor({}), /no owning session/u)
  assert.throws(() => archiverFor({ agent: {} }), /no owning session/u)
  const archiver = archiverFor({ agent: { session: { header: { id: GOOD_ID } } } })
  assert.equal(typeof archiver.putObservation, 'function')
})

/* ------------------------------------------------------------------ */
/* the full five-mechanism wiring                                      */
/* ------------------------------------------------------------------ */

/**
 * Every mechanism on, with the reducer given a provider and a model.
 * @param {string} home - the home the mechanisms write under.
 * @returns {object} the row config.
 */
function allOn(home) {
  return {
    meter: { enabled: true, home },
    actionFusion: { enabled: true },
    observationPack: { enabled: true },
    reducer: { enabled: true, provider: 'p', model: 'm' },
    occ: { enabled: true },
  }
}

test('all five on: one post-execute, one pre-step, two session listeners', (t) => {
  const fake = createFakeCtx()
  apply(fake.ctx, allOn(tempHome(t)))
  assert.equal(fake.listenerCount('tools/post-execute'), 1, 'one post-execute for reducer and observation')
  assert.equal(fake.listenerCount('agent/pre-step'), 1, 'OCC owns the only pre-step listener')
  assert.equal(fake.listenerCount('session/event'), 2, 'meter and occ each watch committed events')
  assert.equal(fake.listenerCount('session/created'), 1)
  assert.equal(fake.listenerCount('session/disposed'), 2, 'meter and occ each forget their own state')
  assert.deepEqual(
    fake.fakeTools.registered.map((definition) => definition.name),
    [EDIT_TOOL_NAME, WRITE_TOOL_NAME, RECALL_TOOL_NAME],
  )
})

test('each mechanism alone registers only what it needs', (t) => {
  const expectations = {
    meter: { post: 0, pre: 0, event: 1, created: 1, disposed: 1, tools: [] },
    actionFusion: { post: 0, pre: 0, event: 0, created: 0, disposed: 0, tools: [EDIT_TOOL_NAME, WRITE_TOOL_NAME] },
    observationPack: { post: 1, pre: 0, event: 0, created: 0, disposed: 0, tools: [RECALL_TOOL_NAME] },
    reducer: { post: 1, pre: 0, event: 0, created: 0, disposed: 0, tools: [] },
    occ: { post: 0, pre: 1, event: 1, created: 0, disposed: 1, tools: [] },
  }
  for (const [mechanism, expected] of Object.entries(expectations)) {
    const fake = createFakeCtx()
    const config = mechanism === 'reducer'
      ? { reducer: { enabled: true, provider: 'p', model: 'm' } }
      : mechanism === 'meter'
        ? { meter: { enabled: true, home: tempHome(t) } }
        : { [mechanism]: { enabled: true } }
    apply(fake.ctx, config)
    assert.equal(fake.listenerCount('tools/post-execute'), expected.post, `${mechanism} post-execute`)
    assert.equal(fake.listenerCount('agent/pre-step'), expected.pre, `${mechanism} pre-step`)
    assert.equal(fake.listenerCount('session/event'), expected.event, `${mechanism} session/event`)
    assert.equal(fake.listenerCount('session/created'), expected.created, `${mechanism} session/created`)
    assert.equal(fake.listenerCount('session/disposed'), expected.disposed, `${mechanism} session/disposed`)
    assert.deepEqual(
      fake.fakeTools.registered.map((definition) => definition.name),
      expected.tools,
      `${mechanism} tools`,
    )
  }
})

test('the composed listener runs the reducer before observation', async () => {
  // Order is the whole point of composing instead of registering twice: a
  // receipt the reducer produces is what observation then sees, and observation
  // leaves a receipt alone. Proven by driving the real handlers through
  // `composePostExecute` with a scripted model.
  const body = `${'build step ok\n'.repeat(300)}FAIL src/a.test.ts\n  Error: expected 1 to be 2\n`
  const receipt = JSON.stringify({
    schema: RECEIPT_SCHEMA,
    source_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    status: 'failure',
    uncertain: false,
    evidence: [{ kind: 'failure', quote: 'FAIL src/a.test.ts' }],
  })
  const llm = {
    stream: () => (async function* one() {
      yield { type: 'text-delta', index: 0, text: receipt }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: receipt } }
      yield { type: 'usage', usage: { totalTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const archiver = {
    digestOf: (content) => createHash('sha256').update(content, 'utf8').digest('hex'),
    put: async (content) => ({ digest: createHash('sha256').update(content, 'utf8').digest('hex'), path: '/mem/x', created: true, bytes: 0 }),
    putObservation: async (content) => ({ digest: createHash('sha256').update(content, 'utf8').digest('hex'), path: '/mem/x', created: true, bytes: 0 }),
  }
  const archiverFor = () => archiver
  const composed = composePostExecute([
    createReducerHandler({
      ctx: createFakeCtx({ services: { llm } }).ctx,
      configFor: () => ({ enabled: true, provider: 'p', model: 'm' }),
      archiverFor,
      shells: ['pwsh'],
      warn: () => {},
      record: () => {},
    }),
    createObservationHandler({ archiverFor, warn: () => {}, record: () => {} }),
  ])
  const result = { isError: false, content: [{ type: 'text', text: body }], value: { exitCode: 1 } }
  const decision = await composed({ name: 'pwsh', callId: 'c' }, result, async () => ({ kind: 'accept' }))
  assert.equal(decision.content[0].text.includes('dsh-sol_evidence_receipt_v1'), true,
    'the receipt survives: observation saw it and left it alone')
  assert.equal(decision.content[0].text.includes('large tool result replaced'), false,
    'the receipt must not be replaced by a placeholder')
})

test('unloading all five removes every listener and tool', (t) => {
  const fake = createFakeCtx()
  apply(fake.ctx, allOn(tempHome(t)))
  fake.disposeAll()
  for (const name of ['tools/post-execute', 'agent/pre-step', 'session/event', 'session/created', 'session/disposed']) {
    assert.equal(fake.listenerCount(name), 0, name)
  }
  assert.equal(fake.fakeTools.registered.length, 0)
})

test('a misspelled key in any section fails loud', () => {
  for (const config of [
    { reducer: { enable: true } },
    { occ: { enable: true } },
    { observationPack: { enable: true } },
    { actionFusion: { enable: true } },
    { meter: { enable: true } },
  ]) {
    const fake = createFakeCtx()
    assert.throws(() => apply(fake.ctx, config), /unknown key/u, JSON.stringify(config))
    assert.equal(fake.listenerCount('tools/post-execute'), 0)
    assert.equal(fake.listenerCount('agent/pre-step'), 0)
  }
})

/* ------------------------------------------------------------------ */
/* no home configured                                                  */
/* ------------------------------------------------------------------ */

/**
 * A live run found this the hard way: with no `meter.home`, the archive write
 * succeeded but the ledger write threw `TypeError: The "path" argument must be
 * of type string`, so ObservationPack kept the original result and the mechanism
 * silently did nothing (`notes/live-load-1.md`). Every unit test passed a home,
 * which is exactly why it was missed.
 */
test('observationPack replaces a result even with no home configured', async (t) => {
  const home = tempHome(t)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const fake = createFakeCtx()
    apply(fake.ctx, { observationPack: { enabled: true, thresholdBytes: 2048 } })
    assert.equal(fake.listenerCount('tools/post-execute'), 1)
    const body = 'x'.repeat(5000)
    const decision = await fake.waterfall(
      'tools/post-execute',
      { name: 'pwsh', callId: 'c1', agent: { session: { header: { id: GOOD_ID } } } },
      { isError: false, content: [{ type: 'text', text: body }], value: { exitCode: 0 } },
      async () => ({ kind: 'accept' }),
    )
    assert.match(decision.content[0].text, /large tool result replaced/u,
      'the replacement must happen without an explicit home')
    const lines = await readLedgerLines(home, GOOD_ID)
    assert.equal(lines.filter((line) => line.kind === 'observation').length, 1,
      'the ledger line must be written too')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('occ records a dry-run line with no home configured', async (t) => {
  const home = tempHome(t)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const session = {
      header: { id: GOOD_ID },
      seq: 3,
      surface: { nodes: [0, 1, 2] },
      eventAt: (seq) => ({ type: 'user/message', seq, data: {} }),
      requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 16384 } }),
    }
    // The pre-step payload carries an agent whose `.session` is the session;
    // passing the session itself would make every lookup silently skip.
    const agent = { session }
    const nodes = [{ seq: 0, tokens: 100000 }, { seq: 1, tokens: 100000 }, { seq: 2, tokens: 100000 }]
    const fake = createFakeCtx({
      agent,
      services: {
        tokenMeter: { measure: () => ({ totalTokens: 300000, nodes }) },
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 200000 } }) },
        compaction: { compactRegion: async () => ({}) },
      },
    })
    apply(fake.ctx, { occ: { enabled: true, thresholdRatio: 0.5 } })
    fake.emit('session/event', session, {
      type: 'todo/write',
      data: { turn: 1, todos: [{ content: 'a', status: 'completed' }] },
    })
    await fake.waterfall('agent/pre-step', { agent, turn: 1, step: 1 }, async () => ({ kind: 'enter' }))
    const lines = await readLedgerLines(home, GOOD_ID)
    assert.equal(lines.filter((line) => line.kind === 'occ-dry').length, 1,
      'the dry-run line must be written without an explicit home')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('obs_recall records a recall line, so the readback is auditable', async (t) => {
  const home = tempHome(t)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const fake = createFakeCtx()
    apply(fake.ctx, { observationPack: { enabled: true, thresholdBytes: 2048 } })
    const body = 'y'.repeat(5000)
    const decision = await fake.waterfall(
      'tools/post-execute',
      { name: 'pwsh', callId: 'c2', agent: { session: { header: { id: GOOD_ID } } } },
      { isError: false, content: [{ type: 'text', text: body }], value: { exitCode: 0 } },
      async () => ({ kind: 'accept' }),
    )
    const id = /^id: (obs_[0-9a-f]{24})$/mu.exec(decision.content[0].text)[1]
    const tool = fake.fakeTools.registered.find((definition) => definition.name === RECALL_TOOL_NAME)
    await tool.execute({ id, offset: 0 }, { name: RECALL_TOOL_NAME, agent: { session: { header: { id: GOOD_ID } } } })
    const lines = await readLedgerLines(home, GOOD_ID)
    assert.equal(lines.filter((line) => line.kind === 'observation-recall').length, 1,
      'a recall must leave a ledger line')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
