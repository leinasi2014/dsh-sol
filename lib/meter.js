/**
 * Token metering: one ledger line per finished turn.
 *
 * The main loop's usage is read from the Harness's own `tokenUsage`
 * projection (`report.md` 3.1) instead of wrapping `llm/stream`: ds-bot
 * re-issues a rewritten request (`ds-bot/src/host/secrets.js:465-473`), so a
 * stream listener would double-count, and the projection already replaces a
 * retried attempt instead of adding it twice
 * (`asar:dsh-token-meter/lib/index.js:401-421`).
 *
 * The projection state is `{ totals, last }`, so the four buckets live under
 * `.totals`; `stateOf` hands out the live state, so it is copied, never kept
 * (`asar:dsh-token-meter/lib/index.js:349-356`,
 * `asar:dsh-session-projection/lib/index.js:126-131`).
 *
 * A forked Session folds its parent's prefix into the same projection: `init`
 * ignores `inheritedEventCount` and the registry folds the whole
 * `snapshotEvents()` (`asar:dsh-token-meter/lib/index.js:396-399`,
 * `asar:dsh-session-projection/lib/index.js:377-384`). So this module records
 * a baseline — the totals at `session/created` for a seeded Session, zero
 * otherwise — and every line carries the delta, never the raw cumulative
 * number.
 *
 * The projection does not count the compaction call, so the usage recorded on
 * each `compaction/summary` event is accumulated in a host-only projection
 * (`asar:dsh-compaction-basic/lib/index.js:634-649`), counting only events at
 * or after `inheritedEventCount`. Completed requests use the same projection,
 * so both counters are rebuilt from durable history after a restart.
 *
 * Nothing here throws into a session, and the listener performs no synchronous
 * I/O and never appends to the session (`report.md` 3.7, rule 3): a missing
 * projection, an unsafe session id, or a write failure produces one warning.
 *
 * @module dsh-sol/meter
 */

import { appendLedgerRecord, isValidSessionId, resolveDshHome } from './ledger.js'

/** The four usage buckets, named as the `tokenUsage` projection names them. */
export const BUCKET_KEYS = [
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]

/** Record shape version; bump when fields change. */
export const RECORD_VERSION = 1

/**
 * A zeroed bucket set.
 * @returns {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} the buckets.
 */
export function zeroBuckets() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

/** Host-only counters rebuilt by the public projection registry on restore. */
export const COUNTERS_KEY = 'dshSolMeterCounters'

export const meterCountersProjection = {
  key: COUNTERS_KEY,
  stateVersion: 1,
  stateSchema: {
    parse(value) {
      const count = (number) => Number.isSafeInteger(number) && number >= 0
      if (!value || !count(value.inheritedEventCount) || !count(value.requests)
        || !count(value.compactionCalls) || !value.compaction
        || BUCKET_KEYS.some((key) => !Number.isFinite(value.compaction[key]) || value.compaction[key] < 0)) {
        throw new TypeError('invalid dsh-sol meter counters checkpoint')
      }
      return value
    },
  },
  init: (_header, inheritedEventCount) => ({
    inheritedEventCount,
    requests: 0,
    compactionCalls: 0,
    compaction: zeroBuckets(),
  }),
  apply(state, event) {
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'assistant/message') return { ...state, requests: state.requests + 1 }
    if (event.type !== 'compaction/summary' || event.data?.usage == null) return state
    return {
      ...state,
      compaction: addBuckets(state.compaction, bucketsFromUsage(event.data.usage)),
      compactionCalls: state.compactionCalls + 1,
    }
  },
}

/**
 * Map one provider usage sample onto the four buckets, defaulting the optional
 * cache counters to zero exactly as the projection does
 * (`asar:dsh-token-meter/lib/index.js:326-331`).
 * @param {object|undefined} usage - a usage sample.
 * @returns {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} the buckets.
 */
export function bucketsFromUsage(usage) {
  if (usage === undefined || usage === null) return zeroBuckets()
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    uncachedInputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    cacheReadTokens: number(usage.cacheReadTokens),
    cacheWriteTokens: number(usage.cacheWriteTokens),
  }
}

/**
 * Add two bucket sets.
 * @param {object} left - the accumulator.
 * @param {object} right - the increment.
 * @returns {object} a new bucket set.
 */
export function addBuckets(left, right) {
  const sum = {}
  for (const key of BUCKET_KEYS) sum[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0)
  return sum
}

/**
 * Subtract a baseline from totals, clamping at zero so a baseline taken after
 * a restore can never produce a negative line.
 * @param {object} totals - the current cumulative buckets.
 * @param {object|undefined} baseline - the buckets to subtract.
 * @returns {object} the delta.
 */
export function subtractBuckets(totals, baseline) {
  const delta = {}
  for (const key of BUCKET_KEYS) {
    delta[key] = Math.max(0, (totals?.[key] ?? 0) - (baseline?.[key] ?? 0))
  }
  return delta
}

/**
 * Normalize whatever the projection currently holds into bucket totals.
 * Anything that is not the documented `{totals: {...}}` shape is treated as
 * absent, so a schema change cannot fabricate numbers.
 * @param {unknown} state - `stateOf(session, 'tokenUsage')`.
 * @returns {object|undefined} a fresh copy of the totals, or undefined when unusable.
 */
export function totalsOf(state) {
  if (state === null || typeof state !== 'object') return undefined
  const totals = /** @type {Record<string, unknown>} */ (state).totals
  if (totals === null || typeof totals !== 'object') return undefined
  const out = {}
  for (const key of BUCKET_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (totals)[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    out[key] = value
  }
  return out
}

/**
 * Read the fork-relevant facts off a Session without trusting any one of them.
 * `isSeeded` and `parentSession` live on the immutable header
 * (`asar:dsh-session/lib/index.js:1051-1052,1415`); `inheritedEventCount` is
 * the exact inherited prefix length (同文件 `:1342`).
 * @param {object} session - the Session.
 * @returns {{isSeeded: boolean, parentSession: string|undefined, inheritedEventCount: number}} the facts.
 */
export function forkFacts(session) {
  const header = session?.header
  const isSeeded = header?.isSeeded === true
  const parentSession = typeof header?.parentSession === 'string' ? header.parentSession : undefined
  const inherited = session?.inheritedEventCount
  const inheritedEventCount = typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0
    ? inherited
    : 0
  return { isSeeded, parentSession, inheritedEventCount }
}

/**
 * Whether a Session is a freshly forked child, i.e. its constructor seed holds
 * the parent prefix plus the fork's own marker and closers, and nothing else.
 *
 * Two public fields separate the two ways a seeded Session comes into being:
 *
 * - `firstLifecycleSeq` is `inheritedEventCount` for a seeded snapshot (a fresh
 *   fork, built through `Session.create`) and `firstLiveSeq` otherwise (a
 *   restore, built through `Session.fromRestore`)
 *   (`asar:dsh-session/lib/index.js:1361-1366` describes it, `:1426` assigns it).
 * - `firstLiveSeq` is the log length right after the constructor seed, never
 *   updated (`:1360,1414`).
 *
 * A fresh fork therefore has `firstLifecycleSeq < firstLiveSeq`: the seed
 * carries the inherited marker plus the open turn's closers past the inherited
 * cut (`:927-936`). A restored Session has the two equal, because its seed is
 * the whole stored log and the pre-publication suffix append is a no-op
 * (`asar:dsh-agent-loop/lib/index.js:2000-2004`).
 *
 * The distinction matters: a restored fork's projection folds the parent prefix
 * AND the child's own pre-restart history, so its totals cannot serve as a
 * baseline — doing so would silently drop every token spent before the restart.
 *
 * @param {object} session - the Session.
 * @returns {boolean} true only for a Session that is a fresh fork.
 */
export function isFreshFork(session) {
  const facts = forkFacts(session)
  if (!facts.isSeeded) return false
  const firstLifecycleSeq = session?.firstLifecycleSeq
  const firstLiveSeq = session?.firstLiveSeq
  if (typeof firstLifecycleSeq !== 'number' || !Number.isSafeInteger(firstLifecycleSeq)) return false
  if (typeof firstLiveSeq !== 'number' || !Number.isSafeInteger(firstLiveSeq)) return false
  return firstLifecycleSeq < firstLiveSeq
}

/**
 * Build one ledger record for a finished turn.
 * @param {object} input - the record fields.
 * @param {string} input.sessionId - the session id.
 * @param {number} input.seq - the `turn/end` sequence number.
 * @param {number} input.turn - the turn number that just ended.
 * @param {object} input.usage - this session's own buckets, baseline removed.
 * @param {object} input.usageTotal - the projection's raw cumulative buckets.
 * @param {object} input.compaction - this session's own compaction buckets.
 * @param {number} input.compactionCalls - how many compaction calls contributed.
 * @param {number} input.requests - how many completed model requests this session made.
 * @param {string} input.baseline - `zero`, `fork`, or `unknown`.
 * @param {boolean} input.isSeeded - whether the Session inherits a prefix.
 * @param {string|undefined} input.parentSession - the fork parent, when known.
 * @param {number} input.inheritedEventCount - the inherited prefix length.
 * @param {string} input.at - ISO timestamp.
 * @returns {object} the record, ready to serialize.
 */
export function buildTurnRecord({
  sessionId,
  seq,
  turn,
  usage,
  usageTotal,
  compaction,
  compactionCalls,
  requests,
  baseline,
  isSeeded,
  parentSession,
  inheritedEventCount,
  at,
}) {
  return {
    v: RECORD_VERSION,
    kind: 'turn',
    sessionId,
    seq,
    turn,
    at,
    isSeeded,
    ...parentSession === undefined ? {} : { parentSession },
    baseline,
    inheritedEventCount,
    usage: { ...usage },
    usageTotal: { ...usageTotal },
    compaction: { ...compaction },
    compactionCalls,
    requests,
  }
}

/**
 * Per-session baseline and in-process turn deduplication. Durable counters
 * live in meterCountersProjection, rather than resetting with this object.
 */
export class MeterState {
  /**
   * Session id to its fold state. `baseline` is undefined while a seeded
   * Session is still waiting for a `session/created` snapshot.
   * @type {Map<string, {lastTurn: number, lastSeq: number, baseline: object|undefined, baselineKind: string}>}
   */
  #sessions = new Map()

  /**
   * Baselines captured at `session/created` for seeded Sessions, which are the
   * only ones whose projection starts non-zero.
   * @type {Map<string, object>}
   */
  #created = new Map()

  /**
   * Record the totals a Session started with.
   *
   * Only a fresh fork has a usable baseline: at that moment the projection
   * holds the parent's contribution and nothing else. A restored seeded
   * Session is reported as `unknown` instead of guessing, because its
   * projection also contains its own pre-restart history.
   *
   * An unseeded Session needs no baseline: the projection folds only its own
   * log, which starts at zero (whether it is new or restored).
   *
   * @param {object} session - the announced Session.
   * @returns {void}
   */
  noteCreated(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (!isFreshFork(session)) return
    const state = /** @type {{stateOf: Function}} */ (this.projection)?.stateOf?.(session, 'tokenUsage')
    const totals = totalsOf(state)
    if (totals !== undefined) this.#created.set(sessionId, totals)
  }

  /**
   * The projection service, injected by {@link mountMeter} so `noteCreated` can
   * read the starting totals without a second argument at every call site.
   * @type {{stateOf: Function}|undefined}
   */
  projection

  /**
   * @param {object} session - the Session.
   * @returns {{lastTurn: number, lastSeq: number, baseline: object|undefined, baselineKind: string}} the mutable state.
   */
  #stateFor(session) {
    const sessionId = session.id
    let state = this.#sessions.get(sessionId)
    if (state === undefined) {
      const facts = forkFacts(session)
      const created = this.#created.get(sessionId)
      let baseline
      let baselineKind
      if (!facts.isSeeded) {
        baseline = zeroBuckets()
        baselineKind = 'zero'
      } else if (created !== undefined) {
        baseline = created
        baselineKind = 'fork'
      } else {
        // A seeded Session this plugin did not see announced: its projection
        // already carries the parent's usage and no baseline exists.
        baseline = undefined
        baselineKind = 'unknown'
      }
      state = { lastTurn: -1, lastSeq: -1, baseline, baselineKind }
      this.#sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * Forget a disposed Session so a long-lived process does not accumulate
   * state for sessions that are gone.
   * @param {object} session - the disposed Session.
   * @returns {void}
   */
  forget(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    this.#sessions.delete(sessionId)
    this.#created.delete(sessionId)
  }

  /**
   * Whether a turn (or its sequence position) was already recorded.
   * @param {object} session - the Session.
   * @param {number} turn - the turn number.
   * @param {number} seq - the `turn/end` sequence number.
   * @returns {boolean} true when this line already exists.
   */
  hasTurn(session, turn, seq) {
    const state = this.#stateFor(session)
    return state.lastTurn >= turn || (Number.isSafeInteger(seq) && state.lastSeq >= seq)
  }

  /**
   * Mark a turn recorded and copy its baseline.
   * @param {object} session - the Session.
   * @param {number} turn - the turn number.
   * @param {number} seq - the `turn/end` sequence number.
   * @returns {{baseline: object|undefined, baselineKind: string}} a snapshot.
   */
  claimTurn(session, turn, seq) {
    const state = this.#stateFor(session)
    state.lastTurn = turn
    if (Number.isSafeInteger(seq)) state.lastSeq = seq
    return {
      baseline: state.baseline === undefined ? undefined : { ...state.baseline },
      baselineKind: state.baselineKind,
    }
  }
}

/**
 * Mount the meter on a context that provides `sessionProjections`.
 *
 * @param {object} ctx - a Cordis context providing `sessionProjections`.
 * @param {object} options - the resolved meter configuration.
 * @param {boolean} options.enabled - whether the mechanism runs at all.
 * @param {string|undefined} options.home - explicit Harness home override.
 * @param {Function} [options.append] - ledger writer, injectable for tests.
 * @param {Function} [options.now] - clock, injectable for tests.
 * @param {Function} [options.warn] - warning sink, injectable for tests.
 * @returns {Function} the disposer removing every listener.
 */
export function mountMeter(ctx, options) {
  const {
    home,
    append = appendLedgerRecord,
    now = () => new Date(),
    warn = (message) => {
      const logger = ctx?.logger
      if (typeof logger?.warn === 'function') logger.warn(message)
      else console.warn(message)
    },
  } = options ?? {}

  const resolvedHome = resolveDshHome(home)
  const state = new MeterState()
  state.projection = ctx.sessionProjections
  const disposeCounters = ctx.sessionProjections.register(meterCountersProjection)
  /** Sessions that already produced a missing-projection warning. */
  const warnedMissing = new Set()
  /** Sessions whose id was rejected, so one warning is enough. */
  const warnedId = new Set()

  /**
   * Take the starting totals for a seeded Session.
   * @param {object} session - the announced Session.
   * @returns {void}
   */
  const onCreated = (session) => {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) return
      state.noteCreated(session)
    } catch (error) {
      warn(`dsh-sol meter: could not record the starting totals: ${String(error)}`)
    }
  }

  /**
   * Drop per-session state.
   * @param {object} session - the disposed Session.
   * @returns {void}
   */
  const onDisposed = (session) => {
    try {
      state.forget(session)
      const sessionId = session?.id
      if (typeof sessionId === 'string') {
        warnedMissing.delete(sessionId)
        warnedId.delete(sessionId)
      }
    } catch {
      // Forgetting is best effort; a failure must not reach the session.
    }
  }

  /**
   * Handle one committed session event. Synchronous, no I/O, no append.
   * @param {object} session - the session.
   * @param {object} event - the committed event.
   * @returns {void}
   */
  const onEvent = (session, event) => {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      if (!isValidSessionId(sessionId)) {
        if (!warnedId.has(sessionId)) {
          warnedId.add(sessionId)
          warn(`dsh-sol meter: skipping session with unsafe id ${JSON.stringify(sessionId)}`)
        }
        return
      }
      if (event?.type !== 'turn/end') return
      const turn = event?.data?.turn
      if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) return
      const seq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : undefined
      if (state.hasTurn(session, turn, seq)) return

      const totals = totalsOf(ctx.sessionProjections.stateOf(session, 'tokenUsage'))
      if (totals === undefined) {
        if (!warnedMissing.has(sessionId)) {
          warnedMissing.add(sessionId)
          warn('dsh-sol meter: the tokenUsage projection is unavailable; no ledger line for this session')
        }
        return
      }

      // Seed events do not emit session/event. A registered projection folds
      // the full durable log, so requests and compaction survive a reload too.
      const counters = ctx.sessionProjections.stateOf(session, COUNTERS_KEY)
      if (counters === undefined) throw new Error('the meter counters projection is unavailable')
      const claimed = state.claimTurn(session, turn, seq)
      const facts = forkFacts(session)
      const usage = claimed.baseline === undefined ? zeroBuckets() : subtractBuckets(totals, claimed.baseline)
      const record = buildTurnRecord({
        sessionId,
        seq,
        turn,
        usage,
        usageTotal: totals,
        compaction: counters.compaction,
        compactionCalls: counters.compactionCalls,
        requests: counters.requests,
        baseline: claimed.baselineKind,
        isSeeded: facts.isSeeded,
        parentSession: facts.parentSession,
        inheritedEventCount: facts.inheritedEventCount,
        at: now().toISOString(),
      })
      // Fire and forget: the listener must not await, and a failure is a warning.
      Promise.resolve(append({ home: resolvedHome, sessionId, record })).catch((error) => {
        warn(`dsh-sol meter: ledger write failed for session ${sessionId}: ${String(error)}`)
      })
    } catch (error) {
      warn(`dsh-sol meter: skipped one event: ${String(error)}`)
    }
  }

  const disposers = [
    disposeCounters,
    ctx.on('session/created', onCreated),
    ctx.on('session/disposed', onDisposed),
    ctx.on('session/event', onEvent),
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
