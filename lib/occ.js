/**
 * Online Context Compact: compact at a plan-step boundary, before the native
 * pressure trigger fires.
 *
 * The mechanism is a `agent/pre-step` listener that records a decision and, when
 * `dryRun` is false and every condition holds, asks the compaction engine to
 * compact one range. It never changes the step's outcome: every path returns
 * `next()` (`report.md` 2.4 rule 5, 3.7 rule 3).
 *
 * What v1 deliberately does not do (`notes/step5-facts.md` 7.2): no economy
 * model, no cooldown, no request counting, no hidden continuation message, no
 * `summarize()` override, no `update_plan` tool, no cross-turn todo rebuild, no
 * persisted state. What is left is the boundary, the two thresholds and the
 * give-way rules.
 *
 * The native engine already compacts on pressure, at
 * `min(0.8W, W − O − headroom)` — 55% of the window on this machine's main
 * model. OCC's increment is only the gap between "a step just finished" and that
 * line, which is why `dryRun` defaults to true: the guess has to be measured
 * before it is trusted (`report.md` 2.4).
 *
 * @module dsh-sol/occ
 */

import { appendLedgerRecord } from './ledger.js'
import { computeThresholds, selectRange } from './occ-range.js'

/** The sentence ds-bot rejects a Bot conversation's compaction with. */
export const BOT_REFUSAL = 'A Bot conversation makes room on its own'

/**
 * Every `decision` value the mechanism can produce.
 *
 * `would-compact` through `no-range` are exits of {@link decide}.
 * `refused` is also a `decide` exit, but the caller checks the same status
 * before calling it, so that branch is unreachable in practice — it stays as a
 * defensive guard.
 * `busy` is not a decision at all: it comes from `runCompaction`, and neither a
 * refusal nor a busy attempt writes a ledger line, they only warn
 * (`report.md` 2.4). The values are listed together so the vocabulary lives in
 * one place.
 */
export const DECISIONS = Object.freeze([
  'would-compact',
  'disabled',
  'no-boundary',
  'below-threshold',
  'no-window',
  'retain-too-large',
  'no-engine',
  'no-range',
  'refused',
  'busy',
])

/**
 * Whether an error is ds-bot refusing to compact a Bot conversation.
 *
 * Matched by message text because the rejection is a bare `Error` with no
 * `code` (`ds-bot/src/host/parts.js:186-187`). If ds-bot rewords it, this
 * degrades to "try once more and fail", never to a wrong action
 * (`notes/step5-facts.md` 1.3).
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when ds-bot refused.
 */
export function isBotRefusal(error) {
  const message = error?.message
  return typeof message === 'string' && message.includes(BOT_REFUSAL)
}

/**
 * Whether an error is the engine's compaction lock.
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when the engine reports `busy`.
 */
export function isBusy(error) {
  return error?.code === 'busy'
}

/**
 * Compare two todo lists and report which items just became completed.
 *
 * A boundary is an item that is `completed` now and either absent from the
 * previous list or not completed there (`notes/step5-facts.md` 10.4 A2). The
 * `content` string is the only identity a todo has, so rewording an item reads
 * as a new item that happens to be completed — accepted, because the threshold
 * still guards the trigger.
 *
 * @param {Map<string, string>|undefined} previous - content → status, or undefined for the first list.
 * @param {readonly object[]} todos - the new list.
 * @returns {string[]} the contents that became completed.
 */
export function newlyCompleted(previous, todos) {
  if (!Array.isArray(todos)) return []
  const completed = []
  for (const todo of todos) {
    if (todo === null || typeof todo !== 'object') continue
    if (todo.status !== 'completed') continue
    const content = typeof todo.content === 'string' ? todo.content : undefined
    if (content === undefined) continue
    if (previous?.get(content) !== 'completed') completed.push(content)
  }
  return completed
}

/**
 * Fold a todo list into its content → status map.
 * @param {readonly object[]} todos - the list.
 * @returns {Map<string, string>} the map.
 */
function todoStatuses(todos) {
  const map = new Map()
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (todo === null || typeof todo !== 'object') continue
    if (typeof todo.content !== 'string') continue
    map.set(todo.content, typeof todo.status === 'string' ? todo.status : 'pending')
  }
  return map
}

/**
 * The per-session state OCC keeps in memory.
 *
 * Nothing is persisted: a restart only costs one extra refused call for a Bot
 * conversation (`notes/step5-facts.md` 7.2).
 *
 * @returns {object} a fresh state.
 */
export function createOccState() {
  return {
    /** content → status of the last todo list, or undefined before the first. */
    todos: undefined,
    /** The boundary waiting to be used, or undefined. */
    boundary: undefined,
    /** Steps since the last compaction of any kind. */
    sinceLastCompactSteps: 0,
    /** `unknown`, `allowed`, or `refused`. */
    status: 'unknown',
  }
}

/**
 * Record one committed session event.
 *
 * Synchronous and I/O free, like the meter: the event arrives inside commit
 * (`report.md` 3.1, `asar:dsh-session/lib/index.js:1567,1592`).
 *
 * @param {object} state - the session state.
 * @param {object} event - the committed event.
 * @returns {void}
 */
export function noteEvent(state, event) {
  if (event?.type === 'todo/write') {
    const todos = event.data?.todos
    const completed = newlyCompleted(state.todos, todos)
    state.todos = todoStatuses(todos)
    if (completed.length > 0) {
      state.boundary = {
        turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
        completed,
      }
    }
    return
  }
  if (event?.type === 'compaction/start') {
    // Any compaction resets the count: the surface changed, so the occupancy
    // measured before it no longer describes the session
    // (`notes/step5-facts.md` 10.3 补充 d).
    state.sinceLastCompactSteps = 0
  }
}

/**
 * Read the routed model and its window for one session.
 *
 * @param {object} input - the inputs.
 * @param {object} input.session - the session.
 * @param {object} input.llm - the `ctx.llm` service, if any.
 * @param {AbortSignal} [input.signal] - the step's signal.
 * @returns {Promise<{contextWindow: number, reservedOutput: number}|undefined>} the window, or undefined.
 */
export async function readWindow({ session, llm, signal }) {
  if (typeof llm?.resolveModelInfo !== 'function') return undefined
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
  const config = header?.config
  const provider = config?.provider
  const model = config?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, signal)
  } catch {
    return undefined
  }
  const contextWindow = info?.context?.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  const requested = config?.maxTokens
  const reservedOutput = Number.isInteger(requested) && requested >= 0
    ? requested
    : (Number.isInteger(info?.defaultMaxTokens) && info.defaultMaxTokens >= 0 ? info.defaultMaxTokens : 0)
  return { contextWindow, reservedOutput }
}

/**
 * Pick the compaction engine for one agent, preferring the preset's own.
 *
 * The lookup is repeated on every decision: ds-bot replaces the engine's methods
 * in place, so a cached reference could be the unwrapped one and the Bot
 * conversation would not be refused (`notes/step5-facts.md` 2.3).
 *
 * @param {object} input - the inputs.
 * @param {object} input.ctx - the plugin context.
 * @param {object} input.agent - the agent.
 * @returns {object|undefined} the engine, when one exposes `compactRegion`.
 */
export function resolveEngine({ ctx, agent }) {
  const candidates = []
  try {
    const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined
    if (typeof presets?.serviceFor === 'function') candidates.push(presets.serviceFor(agent, 'compaction'))
  } catch {
    // A preset registry that throws is the same as one that is absent.
  }
  try {
    if (typeof ctx?.get === 'function') candidates.push(ctx.get('compaction'))
  } catch {
    // Same.
  }
  return candidates.find((engine) => typeof engine?.compactRegion === 'function')
}

/**
 * Measure the session without choosing a range.
 *
 * @param {object} input - the inputs.
 * @param {object} input.session - the session.
 * @param {object} input.ctx - the plugin context.
 * @param {object} input.config - the resolved OCC config.
 * @param {AbortSignal} [input.signal] - the step's signal.
 * @returns {Promise<object|undefined>} the measurement.
 */
async function measureOnly({ session, ctx, config, signal }) {
  const meter = typeof ctx?.get === 'function' ? ctx.get('tokenMeter') : undefined
  if (typeof meter?.measure !== 'function') return undefined
  let measurement
  try {
    measurement = meter.measure(session)
  } catch {
    return undefined
  }
  const totalTokens = measurement?.totalTokens
  if (!Number.isFinite(totalTokens) || totalTokens < 0) return undefined
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  const window = await readWindow({ session, llm, signal })
  if (window === undefined) return undefined
  const thresholds = computeThresholds({
    contextWindow: window.contextWindow,
    reservedOutput: window.reservedOutput,
    thresholdRatio: config?.thresholdRatio,
  })
  if (thresholds === null) return undefined
  const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : []
  return {
    occupancy: {
      totalTokens,
      contextWindow: window.contextWindow,
      ratio: Math.round((totalTokens / window.contextWindow) * 10000) / 10000,
      nativeThreshold: thresholds.nativeThreshold,
      occThreshold: thresholds.occThreshold,
      // The measurement is taken before the pruner runs, so it is the un-pruned
      // number: the bias is always early, never late (`notes/step5-facts.md` 10.3 c).
      pruned: false,
    },
    thresholds,
    tokens: nodes,
  }
}

/**
 * Decide what this step should do.
 *
 * @param {object} input - the inputs.
 * @param {object} input.state - the session state.
 * @param {object} input.session - the session.
 * @param {object} input.agent - the agent.
 * @param {object} input.ctx - the plugin context.
 * @param {object} input.config - the resolved OCC config.
 * @param {AbortSignal} [input.signal] - the step's signal.
 * @returns {Promise<object>} the decision record.
 */
export async function decide({ state, session, agent, ctx, config, signal }) {
  const base = { decision: 'no-boundary', boundary: null, range: null, occupancy: null }
  if (config?.enabled !== true) return { ...base, decision: 'disabled' }
  if (state.status === 'refused') return { ...base, decision: 'refused' }

  const boundary = state.boundary ?? null
  const measured = await measureOnly({ session, ctx, config, signal })
  if (measured === undefined) return { ...base, decision: 'no-window', boundary }
  const { occupancy, thresholds, tokens } = measured
  // Without a boundary there is nothing to act on, but the occupancy is still
  // returned so the caller can record a crossed threshold: that is the data the
  // dry run exists to collect.
  if (boundary === null) return { ...base, decision: 'no-boundary', occupancy }
  if (thresholds.occThreshold <= 0) return { ...base, decision: 'no-window', boundary, occupancy }
  if (thresholds.retainTokens >= thresholds.occThreshold) {
    // The tail alone is bigger than the trigger line, so compacting would not
    // free anything. The engine treats this as a configuration error; a plugin
    // must skip instead (`notes/step5-facts.md` 10.2 补充 b).
    return { ...base, decision: 'retain-too-large', boundary, occupancy }
  }
  if (occupancy.totalTokens < thresholds.occThreshold) {
    return { ...base, decision: 'below-threshold', boundary, occupancy }
  }

  const engine = resolveEngine({ ctx, agent })
  if (engine === undefined) return { ...base, decision: 'no-engine', boundary, occupancy }

  const range = selectRange({
    surfaceSeqs: session?.surface?.nodes ?? [],
    nodes: tokens,
    eventAt: (seq) => session.eventAt(seq),
    retainTokens: thresholds.retainTokens,
  })
  if (range === null) return { ...base, decision: 'no-range', boundary, occupancy }
  return { ...base, decision: 'would-compact', boundary, occupancy, range, engine }
}

/**
 * Build the `agent/pre-step` listener.
 *
 * @param {object} options - the handler inputs.
 * @param {object} options.ctx - the plugin context.
 * @param {Function} options.configFor - returns the resolved OCC config.
 * @param {Function} options.stateFor - returns (creating if needed) one session's state.
 * @param {Function} [options.record] - the ledger sink.
 * @param {Function} [options.warn] - a warning sink.
 * @returns {Function} the waterfall listener.
 */
export function createOccHandler({ ctx, configFor, stateFor, record = () => {}, warn = () => {} }) {
  /**
   * Work out what this step should do, without touching `next()`.
   *
   * Every "give way" path returns `undefined`. Keeping this separate from the
   * listener is what makes the single `next()` call safe: a `next()` inside the
   * try would be called a second time by the catch when the downstream listener
   * throws (`asar:cordis/lib/index.js:317-325`).
   *
   * @param {object} payload - the pre-step payload.
   * @returns {Promise<object|undefined>} the compaction plan, or undefined.
   */
  async function planStep(payload) {
    const agent = payload?.agent
    const session = agent?.session
    const sessionId = session?.header?.id
    if (typeof sessionId !== 'string') return undefined
    const config = configFor()
    if (config?.enabled !== true) return undefined
    const state = stateFor(sessionId)
    // Counted only for an enabled mechanism: a disabled row should not keep a
    // counter running that nothing reads.
    state.sinceLastCompactSteps += 1
    if (payload?.signal?.aborted === true) return undefined
    if (state.status === 'refused') return undefined

    const outcome = await decide({ state, session, agent, ctx, config, signal: payload?.signal })
    const boundary = outcome.boundary ?? null
    const overThreshold = outcome.occupancy !== null
      && outcome.occupancy.occThreshold > 0
      && outcome.occupancy.totalTokens >= outcome.occupancy.occThreshold
    if (boundary !== null || overThreshold) {
      await writeLedger({
        record,
        warn,
        sessionId,
        session,
        payload,
        state,
        outcome,
        // The boundary carries no turn of its own: `todo/write` data has only
        // `todos`, so the step's own turn is the only accurate one.
        boundaryTurn: typeof payload?.turn === 'number' ? payload.turn : undefined,
      })
    }
    if (boundary !== null) {
      // The boundary is used once: a later step without a new todo/write must
      // not compact again (10.4 A6).
      state.boundary = undefined
    }
    if (outcome.decision !== 'would-compact') return undefined
    if (config.dryRun !== false) return undefined
    return { outcome, agent, session, state, payload, sessionId }
  }

  /**
   * @param {object} payload - `{agent, turn, step, signal}`.
   * @param {Function} next - the next listener.
   * @returns {Promise<object>} the step decision.
   */
  return async function occPreStep(payload, next) {
    try {
      const plan = await planStep(payload)
      // `runCompaction` compacts and returns; it never touches `next()`.
      if (plan !== undefined) await runCompaction({ ...plan, warn, record })
    } catch (error) {
      warn(`dsh-sol occ: skipped this step: ${String(error?.message ?? error)}`)
    }
    // The only `next()` this listener calls, on every path.
    return next()
  }
}

/**
 * Write one dry-run line.
 *
 * Awaited by the caller. A fire-and-forget write would let the step finish
 * before the line lands, so a test (or a crash right after) sees a decision that
 * was never recorded; the ledger is the only record of why OCC did nothing.
 *
 * @param {object} input - the inputs.
 * @returns {Promise<void>} settles when the line is written or the failure warned.
 */
async function writeLedger({ record, warn, sessionId, session, payload, state, outcome, boundaryTurn }) {
  try {
    const entry = {
      v: 1,
      kind: 'occ-dry',
      sessionId,
      at: new Date().toISOString(),
      turn: typeof payload?.turn === 'number' ? payload.turn : undefined,
      step: typeof payload?.step === 'number' ? payload.step : undefined,
      seq: typeof session?.seq === 'number' ? session.seq : undefined,
      occupancy: outcome.occupancy,
      sinceLastCompactSteps: state.sinceLastCompactSteps,
      boundary: outcome.boundary === null || outcome.boundary === undefined ? null : {
        turn: boundaryTurn,
        completed: outcome.boundary.completed,
      },
      range: outcome.range,
      decision: outcome.decision,
      wouldCompact: outcome.decision === 'would-compact',
    }
    await record(entry)
  } catch (error) {
    warn(`dsh-sol occ: ledger write failed: ${String(error?.message ?? error)}`)
  }
}

/**
 * Ask the engine to compact.
 *
 * It does not touch `next()`: the caller calls it exactly once, outside this
 * function's error handling, so a failing downstream listener cannot trigger a
 * second call and pop another listener off the waterfall queue.
 *
 * @param {object} input - the inputs.
 * @returns {Promise<void>} settles when the attempt is over.
 */
async function runCompaction({ outcome, agent, session, state, payload, warn, record, sessionId }) {
  const engine = outcome.engine
  const range = outcome.range
  try {
    const result = await engine.compactRegion(range.start, range.end, agent, payload?.signal)
    state.status = 'allowed'
    state.sinceLastCompactSteps = 0
    try {
      Promise.resolve(record({
        v: 1,
        kind: 'occ',
        sessionId,
        at: new Date().toISOString(),
        turn: payload?.turn,
        step: payload?.step,
        seq: session?.seq,
        range,
        shadowedTokenCount: result?.shadowedTokenCount,
        compactionId: result?.compactionId,
      })).catch(() => {})
    } catch {
      // A ledger failure must not change the step.
    }
  } catch (error) {
    if (isBusy(error)) {
      warn('dsh-sol occ: the engine is already compacting this session; giving way')
    } else if (isBotRefusal(error)) {
      state.status = 'refused'
      warn('dsh-sol occ: this Bot conversation compacts on its own; not trying again')
    } else {
      warn(`dsh-sol occ: compaction failed, keeping the step: ${String(error?.message ?? error)}`)
    }
  }
}

/**
 * Mount OCC: one session-event listener, one disposed listener, one pre-step.
 *
 * Every service is read through `ctx.get` inside {@link resolveEngine} rather
 * than declared in `inject`, so a profile without the compaction engine keeps
 * the other mechanisms running (`notes/step5-facts.md` 10.5).
 *
 * @param {object} ctx - a context providing `on` and `get`.
 * @param {object} options - the resolved configuration.
 * @param {Function} options.configFor - returns the resolved OCC config.
 * @param {Function} [options.append] - ledger writer, injectable for tests.
 * @param {string} [options.home] - the Harness home override.
 * @param {Function} [options.warn] - a warning sink.
 * @returns {Function} the disposer removing every listener.
 */
export function mountOcc(ctx, options) {
  const { configFor, append = appendLedgerRecord, home, warn = () => {} } = options ?? {}
  /** Per-session state, dropped on `session/disposed`. */
  const states = new Map()
  /**
   * Get one session's state, creating it on first use.
   * @param {string} sessionId - the session id.
   * @returns {object} the state.
   */
  const stateFor = (sessionId) => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = createOccState()
      states.set(sessionId, state)
    }
    return state
  }
  /**
   * Write one ledger line for a session.
   * @param {object} entry - the record.
   * @returns {Promise<void>} settles when written.
   */
  const record = (entry) => append({ home, sessionId: entry.sessionId, record: entry })
  const disposers = [
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.header?.id
        if (typeof sessionId !== 'string') return
        noteEvent(stateFor(sessionId), event)
      } catch {
        // A listener inside commit must not throw.
      }
    }),
    ctx.on('session/disposed', (session) => {
      try {
        const sessionId = session?.header?.id
        if (typeof sessionId === 'string') states.delete(sessionId)
      } catch {
        // Forgetting is best effort.
      }
    }),
    ctx.on('agent/pre-step', createOccHandler({ ctx, configFor, stateFor, record, warn })),
  ]
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // One failing disposer must not block the rest.
      }
    }
  }
}
