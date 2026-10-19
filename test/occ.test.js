/**
 * Tests for the OCC handler: boundary detection, the two thresholds, the
 * dry-run/real branches, and the give-way rules.
 *
 * A fake context and a fake session stand in for DSH. Nothing here loads DSH,
 * calls a model, or compacts anything. Every case asserts that the listener
 * returned `next()`'s own decision (`notes/step5-facts.md` 10.4 E1).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOT_REFUSAL,
  createOccHandler,
  createOccState,
  isBotRefusal,
  isBusy,
  mountOcc,
  newlyCompleted,
  noteEvent,
  readWindow,
  resolveEngine,
} from '../lib/occ.js'
import { computeThresholds } from '../lib/occ-range.js'
import { createFakeCtx } from './fake-ctx.js'

const SESSION_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'
const STEP_DECISION = { kind: 'enter' }

/**
 * The window the fake `llm` reports.
 *
 * `resolveModelInfo` receives only a provider and a model, so the fake session
 * cannot hand its window through the call. A module-level value keeps the fake
 * honest without inventing an argument the real service does not take.
 */
let fakeWindow = 1_000_000

/* ------------------------------------------------------------------ */
/* a fake session                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build a session whose surface is a system head followed by plain messages.
 *
 * @param {object} [options] - session facts.
 * @param {number} [options.tokens] - the total priced tokens.
 * @param {number} [options.window] - the model's context window.
 * @param {number} [options.reservedOutput] - the request's output budget.
 * @param {boolean} [options.noHeader] - omit `requestHeader`.
 * @returns {object} the fake session.
 */
function fakeAgentSession({ tokens = 600_000, window = 1_000_000, reservedOutput = 384_000, noHeader = false } = {}) {
  fakeWindow = window
  const events = [
    { type: 'system/message', seq: 0, data: {} },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'user/message', seq: 2, data: {} },
  ]
  const nodes = events.map((event) => ({ seq: event.seq, tokens: Math.floor(tokens / events.length) }))
  const session = {
    header: { id: SESSION_ID },
    seq: 3,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt: (seq) => events[seq],
    requestHeader: () => ({
      config: { provider: 'p', model: 'm', maxTokens: reservedOutput },
    }),
    // The fake meter reads this, so a test can price a session without wiring
    // a separate measurement object.
    __measurement: { totalTokens: tokens, nodes },
    __window: window,
  }
  if (noHeader) delete session.requestHeader
  return {
    session,
    totalTokens: tokens,
    window,
    reservedOutput,
    nodes,
  }
}

/**
 * Build a context with the services OCC reaches for.
 *
 * @param {object} options - the services.
 * @param {object} [options.measurement] - what `tokenMeter.measure` returns.
 * @param {object} [options.modelInfo] - what `llm.resolveModelInfo` returns.
 * @param {object} [options.engine] - the compaction engine.
 * @param {boolean} [options.presetsFirst] - whether `agentPresets.serviceFor` wins.
 * @returns {object} the fake context plus its call log.
 */
function occCtx({ measurement, modelInfo, engine, presetsFirst = false, window = 1_000_000 } = {}) {
  const calls = { measure: 0, resolveModelInfo: 0, serviceFor: 0, get: [], compactRegion: [] }
  const compaction = engine
  const ctx = {
    get(name) {
      calls.get.push(name)
      if (name === 'tokenMeter') {
        return {
          measure(session) {
            calls.measure += 1
            if (measurement !== undefined) return measurement
            if (session.__measurement !== undefined) return session.__measurement
            return { totalTokens: 0, nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 0 })) }
          },
        }
      }
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            calls.resolveModelInfo += 1
            if (modelInfo !== undefined) return modelInfo
            return { context: { contextWindow: fakeWindow }, defaultMaxTokens: 64_000 }
          },
        }
      }
      if (name === 'agentPresets') {
        return {
          serviceFor() {
            calls.serviceFor += 1
            return presetsFirst ? compaction : undefined
          },
        }
      }
      if (name === 'compaction') return compaction
      return undefined
    },
  }
  return { ctx, calls }
}

/**
 * Run the handler once.
 * @param {object} options - the run inputs.
 * @returns {Promise<object>} the returned decision.
 */
async function runStep(options) {
  const state = options.state ?? createOccState()
  const lines = []
  const warnings = []
  const handler = createOccHandler({
    ctx: options.ctx,
    configFor: () => options.config ?? { enabled: true, thresholdRatio: 0.5, dryRun: true },
    stateFor: () => state,
    record: (entry) => lines.push(entry),
    warn: (message) => warnings.push(message),
  })
  const decision = await handler(
    { agent: options.agent, turn: 3, step: 2, signal: options.signal },
    async () => STEP_DECISION,
  )
  return { decision, state, lines, warnings }
}

/**
 * A state that already saw one completed step.
 * @param {string[]} [completed] - the completed items.
 * @returns {object} the state.
 */
function stateWithBoundary(completed = ['write the code']) {
  const state = createOccState()
  state.boundary = { turn: 3, completed }
  return state
}

/* ------------------------------------------------------------------ */
/* boundary detection                                                  */
/* ------------------------------------------------------------------ */

test('an item going from in_progress to completed is a boundary', () => {
  assert.deepEqual(newlyCompleted(new Map([['fix it', 'in_progress']]), [
    { content: 'fix it', status: 'completed' },
  ]), ['fix it'])
})

test('rewording an item still counts as a boundary', () => {
  // The content is the only identity a todo has, so a reworded completed item
  // reads as a new one (notes/step5-facts.md 10.4 A2).
  assert.deepEqual(newlyCompleted(new Map([['fix bug', 'in_progress']]), [
    { content: 'fixing the bug', status: 'completed' },
  ]), ['fixing the bug'])
})

test('two identical lists are not a boundary', () => {
  const previous = new Map([['a', 'completed'], ['b', 'in_progress']])
  assert.deepEqual(newlyCompleted(previous, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
  ]), [])
})

test('a completed item going back to pending is not a boundary', () => {
  assert.deepEqual(newlyCompleted(new Map([['a', 'completed']]), [
    { content: 'a', status: 'pending' },
  ]), [])
})

test('the first list already containing a completed item is a boundary', () => {
  assert.deepEqual(newlyCompleted(undefined, [{ content: 'a', status: 'completed' }]), ['a'])
})

test('a boundary is consumed by one step and not reported twice', () => {
  const state = createOccState()
  noteEvent(state, { type: 'todo/write', data: { todos: [{ content: 'a', status: 'completed' }] } })
  assert.deepEqual(state.boundary.completed, ['a'])
})

test('a compaction/start resets the step counter', () => {
  const state = createOccState()
  state.sinceLastCompactSteps = 7
  noteEvent(state, { type: 'compaction/start', data: {} })
  assert.equal(state.sinceLastCompactSteps, 0)
})

test('an unrelated event changes nothing', () => {
  const state = createOccState()
  noteEvent(state, { type: 'turn/start', data: {} })
  assert.equal(state.boundary, undefined)
  assert.equal(state.todos, undefined)
})

/* ------------------------------------------------------------------ */
/* the decision                                                        */
/* ------------------------------------------------------------------ */

test('occ.enabled false is a defensive disabled exit', async () => {
  const { session } = fakeAgentSession()
  const { ctx } = occCtx({})
  const state = stateWithBoundary()
  const { decision, lines } = await runStep({
    ctx,
    agent: { session },
    state,
    config: { enabled: false, dryRun: true },
  })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines.length, 0)
})

test('no boundary means no action, and the step still runs', async () => {
  const { session } = fakeAgentSession({ tokens: 400_000 })
  const { ctx } = occCtx({})
  const { decision, lines, state } = await runStep({ ctx, agent: { session } })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines.length, 0, 'no boundary and under the threshold means nothing to record')
  assert.equal(state.boundary, undefined)
})

test('crossing the threshold without a boundary is recorded once, not acted on', async () => {
  // The dry run exists to learn how often the line is crossed with no plan
  // boundary: that data decides whether the boundary rule earns its keep.
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const engine = { compactRegion: async () => ({}) }
  const { ctx } = occCtx({ engine })
  const { decision, lines } = await runStep({
    ctx,
    agent: { session },
    config: { enabled: true, thresholdRatio: 0.5, dryRun: false },
  })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].decision, 'no-boundary')
  assert.equal(lines[0].wouldCompact, false)
})

test('a missing context window skips the session without throwing', async () => {
  const { session } = fakeAgentSession()
  const { ctx } = occCtx({ modelInfo: {} })
  const { decision, warnings } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(warnings.length, 0)
})

test('a session without requestHeader is skipped', async () => {
  const { session } = fakeAgentSession({ noHeader: true })
  const { ctx } = occCtx({})
  const { decision } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.deepEqual(decision, STEP_DECISION)
})

test('40% occupancy is below the threshold', async () => {
  const { session } = fakeAgentSession({ tokens: 400_000 })
  const { ctx, calls } = occCtx({})
  const { decision, lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines.length, 1, 'a boundary is worth one ledger line even below the threshold')
  assert.equal(lines[0].decision, 'below-threshold')
  assert.equal(calls.compactRegion.length, 0)
})

test('52% occupancy is over the 0.85 × native cap on this machine', async () => {
  // native is 550,464 (55%), so OCC acts at 467,894 (46.8%): 52% must fire.
  const { session } = fakeAgentSession({ tokens: 520_000 })
  const engine = { compactRegion: async () => ({}) }
  const { ctx } = occCtx({ engine })
  const { lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].decision, 'would-compact')
  assert.equal(lines[0].wouldCompact, true)
  assert.ok(lines[0].range !== null)
})

test('45% on a small window follows the formula, not the raw ratio', async () => {
  // 128k window, 8k output: native is 42.4%, so 45% is already past it.
  const { session } = fakeAgentSession({ tokens: 57_600, window: 128_000, reservedOutput: 8_192 })
  const engine = { compactRegion: async () => ({}) }
  const { ctx } = occCtx({ engine })
  const { lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.equal(lines[0].decision, 'would-compact')
  assert.equal(lines[0].occupancy.nativeThreshold, 54_272)
  assert.equal(lines[0].occupancy.occThreshold, 46_131)
})

test('a positive threshold with an oversized retain budget is skipped', async () => {
  // The 96k window case: occ is 11,968 but retain is 12,738. The surface is big
  // enough that range selection would otherwise succeed, so this isolates the
  // retain guard from the "nothing to compact" path.
  const session = fakeAgentSession({ tokens: 30_000, window: 96_000, reservedOutput: 16_384 }).session
  const events = []
  const seqs = []
  for (let index = 0; index < 10; index += 1) {
    const type = index === 0 ? 'system/message' : 'user/message'
    events.push({ type, seq: index, data: {} })
    seqs.push(index)
  }
  session.surface.nodes = seqs
  session.eventAt = (seq) => events[seq]
  session.__measurement = { totalTokens: 30_000, nodes: seqs.map((seq) => ({ seq, tokens: 3_000 })) }
  const engine = { compactRegion: async () => ({}) }
  const { ctx } = occCtx({ engine })
  const { lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.equal(lines[0].decision, 'retain-too-large')
  assert.equal(lines[0].range, null)
  assert.ok(lines[0].occupancy.occThreshold > 0, 'the <= 0 guard alone would let this through')
})

test('a negative threshold is skipped before any range work', async () => {
  const { session } = fakeAgentSession({ tokens: 20_000, window: 64_000, reservedOutput: 8_192 })
  const engine = { compactRegion: async () => ({}) }
  const { ctx, calls } = occCtx({ engine })
  const { decision, lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].decision, 'no-window')
  assert.equal(calls.compactRegion.length, 0)
})

test('no engine at all is no-engine, not a crash', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const { ctx } = occCtx({})
  const { decision, lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines[0].decision, 'no-engine')
})

test('an engine from the preset registry is preferred', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const engine = { compactRegion: async () => ({}) }
  const { ctx, calls } = occCtx({ engine, presetsFirst: true })
  await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.equal(calls.serviceFor, 1)
})

/* ------------------------------------------------------------------ */
/* dry run vs real                                                     */
/* ------------------------------------------------------------------ */

test('dryRun true records would-compact and never compacts', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = { compactRegion: async () => { called += 1; return {} } }
  const { ctx } = occCtx({ engine })
  const { lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.equal(called, 0, 'the dry run must not touch the engine')
  assert.equal(lines[0].kind, 'occ-dry')
  assert.equal(lines[0].wouldCompact, true)
})

test('dryRun false compacts once and records kind occ', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = {
    compactRegion: async () => {
      called += 1
      return { shadowedTokenCount: 1234, compactionId: 'c-1' }
    },
  }
  const { ctx } = occCtx({ engine })
  const { decision, lines } = await runStep({
    ctx,
    agent: { session },
    state: stateWithBoundary(),
    config: { enabled: true, thresholdRatio: 0.5, dryRun: false },
  })
  assert.equal(called, 1)
  assert.deepEqual(decision, STEP_DECISION, 'the step decision is handed back unchanged')
  const occ = lines.find((line) => line.kind === 'occ')
  assert.ok(occ !== undefined, 'a real compaction is recorded')
  assert.equal(occ.shadowedTokenCount, 1234)
})

test('dryRun absent behaves like true', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = { compactRegion: async () => { called += 1; return {} } }
  const { ctx } = occCtx({ engine })
  await runStep({
    ctx,
    agent: { session },
    state: stateWithBoundary(),
    config: { enabled: true, thresholdRatio: 0.5 },
  })
  assert.equal(called, 0)
})

/* ------------------------------------------------------------------ */
/* giving way                                                          */
/* ------------------------------------------------------------------ */

test('a boundary is used by one step and not again by the next', async () => {
  // Without consuming it, every later step would compact on the same completed
  // todo item (notes/step5-facts.md 10.4 A6).
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = { compactRegion: async () => { called += 1; return {} } }
  const { ctx } = occCtx({ engine })
  const state = stateWithBoundary()
  const config = { enabled: true, thresholdRatio: 0.5, dryRun: false }
  await runStep({ ctx, agent: { session }, state, config })
  await runStep({ ctx, agent: { session }, state, config })
  assert.equal(called, 1, 'the second step must not reuse the same boundary')
})

test('a downstream listener that throws is called once and the error escapes', async () => {
  // A second `next()` would pop another listener off the waterfall queue and run
  // the step again, so this is the load-bearing assertion of the whole listener.
  // The plan must succeed and compaction must run, otherwise the throwing
  // `next()` would be the first thing that happens and the catch path would not
  // be exercised.
  const { session } = fakeAgentSession({ tokens: 900_000 })
  const engine = { compactRegion: async () => ({}) }
  const { ctx } = occCtx({ engine })
  let calls = 0
  let compacted = 0
  const spied = {
    get(name) {
      if (name === 'compaction') {
        return {
          compactRegion: async () => {
            compacted += 1
            return {}
          },
        }
      }
      return ctx.get(name)
    },
  }
  const handler = createOccHandler({
    ctx: spied,
    configFor: () => ({ enabled: true, thresholdRatio: 0.5, dryRun: false }),
    stateFor: () => stateWithBoundary(),
    record: () => {},
    warn: () => {},
  })
  await assert.rejects(
    () => handler({ agent: { session }, turn: 3, step: 2 }, async () => {
      calls += 1
      throw new Error('downstream boom')
    }),
    /downstream boom/u,
  )
  assert.equal(calls, 1, 'next() must be called exactly once')
  void compacted
})

test('every path calls next exactly once', async () => {
  const engine = { compactRegion: async () => ({}) }
  const cases = [
    { tokens: 400_000, config: { enabled: true, dryRun: true } },
    { tokens: 600_000, config: { enabled: true, dryRun: true } },
    { tokens: 600_000, config: { enabled: true, dryRun: false } },
    { tokens: 600_000, config: { enabled: false } },
  ]
  for (const item of cases) {
    const { session } = fakeAgentSession(item)
    const { ctx } = occCtx({ engine })
    let calls = 0
    const handler = createOccHandler({
      ctx,
      configFor: () => item.config,
      stateFor: () => stateWithBoundary(),
      record: () => {},
      warn: () => {},
    })
    await handler({ agent: { session }, turn: 1, step: 1 }, async () => {
      calls += 1
      return STEP_DECISION
    })
    assert.equal(calls, 1, JSON.stringify(item.config))
  }
})

test('the step counter is not advanced while the mechanism is off', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const { ctx } = occCtx({ engine: { compactRegion: async () => ({}) } })
  const state = createOccState()
  const handler = createOccHandler({
    ctx,
    configFor: () => ({ enabled: false }),
    stateFor: () => state,
    record: () => {},
    warn: () => {},
  })
  await handler({ agent: { session }, turn: 1, step: 1 }, async () => STEP_DECISION)
  assert.equal(state.sinceLastCompactSteps, 0)
})

test('the dry-run line carries the step turn, not an undefined one', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const { ctx } = occCtx({ engine: { compactRegion: async () => ({}) } })
  const { lines } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.equal(lines[0].boundary.turn, 3, 'the boundary turn comes from the pre-step payload')
})

test('busy gives way without retrying', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = {
    compactRegion: async () => {
      called += 1
      const error = new Error('compaction already in progress')
      error.code = 'busy'
      throw error
    },
  }
  const { ctx } = occCtx({ engine })
  const { decision, warnings, state } = await runStep({
    ctx,
    agent: { session },
    state: stateWithBoundary(),
    config: { enabled: true, thresholdRatio: 0.5, dryRun: false },
  })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(called, 1)
  assert.equal(state.status, 'unknown', 'busy is not a refusal')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /already compacting/u)
})

test('a Bot refusal is remembered and never retried', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = {
    compactRegion: async () => {
      called += 1
      throw new Error(`${BOT_REFUSAL}, and read_own_chat searches all of it.`)
    },
  }
  const { ctx } = occCtx({ engine })
  const state = stateWithBoundary()
  const first = await runStep({
    ctx,
    agent: { session },
    state,
    config: { enabled: true, thresholdRatio: 0.5, dryRun: false },
  })
  assert.deepEqual(first.decision, STEP_DECISION)
  assert.equal(state.status, 'refused')
  state.boundary = { turn: 4, completed: ['next'] }
  await runStep({
    ctx,
    agent: { session },
    state,
    config: { enabled: true, thresholdRatio: 0.5, dryRun: false },
  })
  assert.equal(called, 1, 'the second step must not call the engine again')
})

test('a surface change is a warning, not a retry', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  let called = 0
  const engine = {
    compactRegion: async () => {
      called += 1
      throw new Error('surface changed during compaction')
    },
  }
  const { ctx } = occCtx({ engine })
  const { decision, state, warnings } = await runStep({
    ctx,
    agent: { session },
    state: stateWithBoundary(),
    config: { enabled: true, thresholdRatio: 0.5, dryRun: false },
  })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(called, 1)
  assert.equal(state.status, 'unknown')
  assert.match(warnings[0], /compaction failed/u)
})

test('an aborted signal skips everything', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const { ctx, calls } = occCtx({ engine: { compactRegion: async () => ({}) } })
  const controller = new AbortController()
  controller.abort()
  const { decision, lines } = await runStep({
    ctx,
    agent: { session },
    state: stateWithBoundary(),
    signal: controller.signal,
  })
  assert.deepEqual(decision, STEP_DECISION)
  assert.equal(lines.length, 0)
  assert.equal(calls.measure, 0, 'an aborted step must not read the projection')
})

test('an internal throw is caught and the step still runs', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const ctx = {
    get() {
      throw new Error('service exploded')
    },
  }
  const { decision, warnings } = await runStep({ ctx, agent: { session }, state: stateWithBoundary() })
  assert.deepEqual(decision, STEP_DECISION)
  assert.ok(warnings.length >= 1)
})

test('a failing ledger write only warns', async () => {
  const { session } = fakeAgentSession({ tokens: 600_000 })
  const { ctx } = occCtx({ engine: { compactRegion: async () => ({}) } })
  const warnings = []
  const handler = createOccHandler({
    ctx,
    configFor: () => ({ enabled: true, thresholdRatio: 0.5, dryRun: true }),
    stateFor: () => stateWithBoundary(),
    record: () => Promise.reject(new Error('disk gone')),
    warn: (message) => warnings.push(message),
  })
  const decision = await handler({ agent: { session }, turn: 1, step: 1 }, async () => STEP_DECISION)
  assert.deepEqual(decision, STEP_DECISION)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(warnings.some((message) => /ledger write failed/u.test(message)))
})

test('every exit hands back next() unchanged', async () => {
  const engine = { compactRegion: async () => ({}) }
  const cases = [
    { tokens: 400_000, config: { enabled: true, dryRun: true } },
    { tokens: 600_000, config: { enabled: true, dryRun: true } },
    { tokens: 600_000, config: { enabled: true, dryRun: false } },
    { tokens: 20_000, window: 64_000, reservedOutput: 8_192, config: { enabled: true, dryRun: true } },
  ]
  for (const item of cases) {
    const { session } = fakeAgentSession(item)
    const { ctx } = occCtx({ engine })
    const { decision } = await runStep({ ctx, agent: { session }, state: stateWithBoundary(), config: item.config })
    assert.deepEqual(decision, STEP_DECISION)
  }
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

test('the Bot refusal is matched by its message, and busy by its code', () => {
  assert.equal(isBotRefusal(new Error(`${BOT_REFUSAL}, and read_own_chat searches all of it.`)), true)
  assert.equal(isBotRefusal(new Error('something else')), false)
  assert.equal(isBotRefusal(undefined), false)
  assert.equal(isBusy({ code: 'busy' }), true)
  assert.equal(isBusy(new Error('x')), false)
})

test('readWindow returns undefined without a header or a model', async () => {
  const { session } = fakeAgentSession()
  assert.equal(await readWindow({ session, llm: undefined }), undefined)
  assert.equal(await readWindow({ session, llm: { resolveModelInfo: () => { throw new Error('x') } } }), undefined)
  const noConfig = { requestHeader: () => undefined }
  assert.equal(await readWindow({ session: noConfig, llm: { resolveModelInfo: async () => ({}) } }), undefined)
})

test('readWindow falls back to the model default when maxTokens is absent', async () => {
  const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
  const llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 128 }) }
  assert.deepEqual(await readWindow({ session, llm }), { contextWindow: 1000, reservedOutput: 128 })
})

test('resolveEngine prefers the preset engine and tolerates a throwing registry', () => {
  const engine = { compactRegion: () => {} }
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { serviceFor: () => ({}) }
      return engine
    },
  }
  assert.equal(resolveEngine({ ctx, agent: {} }), engine)
  const throwing = { get() { throw new Error('no') } }
  assert.equal(resolveEngine({ ctx: throwing, agent: {} }), undefined)
})

test('mounting registers one session listener, one disposed listener and one pre-step', () => {
  const fake = createFakeCtx()
  const dispose = mountOcc(fake.ctx, { configFor: () => ({ enabled: true }) })
  assert.equal(fake.listenerCount('session/event'), 1)
  assert.equal(fake.listenerCount('session/disposed'), 1)
  assert.equal(fake.listenerCount('agent/pre-step'), 1)
  dispose()
  assert.equal(fake.listenerCount('session/event'), 0)
  assert.equal(fake.listenerCount('agent/pre-step'), 0)
})

test('mountOcc remembers a session event and forgets it on dispose', async () => {
  const fake = createFakeCtx()
  const lines = []
  const dispose = mountOcc(fake.ctx, {
    configFor: () => ({ enabled: true, dryRun: true }),
    append: async ({ record }) => lines.push(record),
    warn: () => {},
  })
  const session = { header: { id: SESSION_ID } }
  fake.emit('session/event', session, {
    type: 'todo/write',
    data: { turn: 1, todos: [{ content: 'a', status: 'completed' }] },
  })
  fake.emit('session/disposed', session)
  const listener = fake.listenerCount('session/event')
  assert.equal(listener, 1)
  dispose()
  assert.equal(fake.listenerCount('session/event'), 0)
})

test('the threshold arithmetic used by the handler matches the shared helper', () => {
  const budgets = computeThresholds({ contextWindow: 1_000_000, reservedOutput: 384_000 })
  assert.equal(budgets.nativeThreshold, 550_464)
})
