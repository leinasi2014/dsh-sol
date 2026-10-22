/**
 * A minimal fake Cordis context for the unit tests.
 *
 * It records `on`/`effect` registrations so a test can fire an event and check
 * what the plugin did, and it implements just the surfaces dsh-sol uses:
 * `ctx.on`, `ctx.effect`, `ctx.logger`, and `ctx.sessionProjections.stateOf`.
 *
 * @module dsh-sol/test/fake-ctx
 */

/**
 * Build a fake `ctx.tools` service.
 *
 * The real registry is a Cordis service whose `register` validates only
 * `output.schema` and `output.render`, never the model's arguments
 * (`asar:dsh-tools/lib/index.js:2974-2982`), and whose `get(name, scope)` reads
 * one scope's view (`:3091-3093`). `execute(exec)` runs the whole pipeline and
 * returns a materialized result (`:3212-3214`).
 *
 * @param {object} [options] - the fake's behaviour.
 * @param {Record<string, object>} [options.visible] - tool definitions by name, as `get` sees them.
 * @param {Record<string, Function>} [options.results] - name → (exec) => result for `execute`.
 * @param {Function} [options.onGet] - called with every `get` call, for scope assertions.
 * @returns {object} the fake service plus its call log.
 */
export function createFakeTools({ visible = {}, results = {}, onGet } = {}) {
  /** Every `register` call, in order. */
  const registered = []
  /** Every `execute` call's input, in order. */
  const executed = []
  /** Every `get` call's arguments, in order. */
  const looked = []
  /** Names whose registration must throw, to simulate a duplicate. */
  const reject = new Set()

  const tools = {
    /**
     * Record a definition.
     * @param {object} definition - the tool definition.
     * @returns {Function} the disposer.
     */
    register(definition) {
      if (reject.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    /**
     * Resolve a tool in one scope.
     * @param {string} name - the tool name.
     * @param {unknown} scope - the viewing scope.
     * @returns {object|undefined} the definition.
     */
    get(name, scope) {
      looked.push({ name, scope, argumentCount: arguments.length })
      if (typeof onGet === 'function') onGet(name, scope, arguments.length)
      return visible[name]
    },
    /**
     * Run a nested tool call.
     * @param {object} exec - the execution input.
     * @returns {Promise<object>} the materialized result.
     */
    async execute(exec) {
      executed.push(exec)
      const handler = results[exec.name]
      if (handler === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: unknown tool "${exec.name}"` }],
          error: { message: `unknown tool "${exec.name}"`, info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } },
        }
      }
      return handler(exec)
    },
  }

  return { tools, registered, executed, looked, reject }
}

/**
 * Build a fake context.
 *
 * It records `on`/`effect` registrations so a test can fire an event and check
 * what the plugin did, and it implements just the surfaces dsh-sol uses:
 * `ctx.on`, `ctx.effect`, `ctx.get`, `ctx.logger`, `ctx.sessionProjections.stateOf`,
 * and `ctx.tools`.
 *
 * @param {object} [options] - the fake's initial state.
 * @param {Record<string, unknown>} [options.projectionState] - what `stateOf` returns per key.
 * @param {boolean} [options.throwOnStateOf] - make `stateOf` throw, to test the no-projection path.
 * @param {Record<string, unknown>} [options.services] - what `ctx.get(name)` returns.
 * @param {object} [options.agent] - the agent `agent/pre-step` is fused with.
 * @returns {object} the fake context and test helpers.
 */
export function createFakeCtx({ projectionState = {}, throwOnStateOf = false, services = {}, agent } = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const effects = []
  /** @type {string[]} */
  const warnings = []
  const projections = new Map()
  function projectionCell(entry, session) {
    let cell = entry.cells.get(session)
    if (cell === undefined) {
      const events = session.snapshotEvents?.() ?? []
      let state = entry.definition.init(session.header, session.inheritedEventCount ?? 0)
      for (const event of events) state = entry.definition.apply(state, event)
      cell = { state, seq: events.at(-1)?.seq ?? -1 }
      entry.cells.set(session, cell)
    }
    return cell
  }
  const fakeTools = createFakeTools()
  /** The agent `agent/pre-step` is fused with when the emitter passes none. */
  const defaultAgent = agent

  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      error: () => {},
    },
    tools: fakeTools.tools,
    /**
     * Read one service, like `ctx.get(name)`.
     *
     * A real `ctx.get` returns `undefined` for an unprovided service
     * (`asar:cordis/lib/index.js` `get(name, strict)`), which is what the
     * optional-service lookups rely on.
     *
     * @param {string} name - the service name.
     * @returns {unknown} the service, or undefined.
     */
    get(name) {
      return services[name]
    },
    /**
     * Register a listener; returns a disposer like Cordis does.
     * @param {string} name - the event name.
     * @param {Function} listener - the listener.
     * @returns {Function} the disposer.
     */
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
        return true
      }
    },
    /**
     * Run a setup function and collect its disposer, like `ctx.effect`.
     * @param {Function} execute - the setup.
     * @param {string} [label] - the effect label.
     * @returns {Function} the disposer.
     */
    effect(execute, label) {
      const result = execute()
      const dispose = typeof result === 'function' ? result : () => {}
      effects.push(dispose)
      void label
      return () => dispose()
    },
    sessionProjections: {
      register(definition) {
        let entry = projections.get(definition.key)
        if (entry === undefined) {
          entry = { definition, cells: new WeakMap(), refs: 0 }
          projections.set(definition.key, entry)
        }
        entry.refs += 1
        return () => {
          entry.refs -= 1
          if (entry.refs === 0) projections.delete(definition.key)
        }
      },
      /**
       * Return the configured state for a key.
       * @param {object} session - the session.
       * @param {string} key - the projection key.
       * @returns {unknown} the state.
       */
      stateOf(session, key) {
        if (throwOnStateOf) throw new Error('projection unavailable')
        const entry = projections.get(key)
        if (entry !== undefined) return projectionCell(entry, session).state
        return projectionState[key]
      },
    },
  }

  /**
   * Fire one event at every registered listener.
   *
   * `agent/pre-step` is fused before dispatch, exactly as the real runtime does:
   * `agentEvents` wraps the payload with `fused = (payload) => ({...payload,
   * agent})` (`asar:dsh-agent/lib/index.js:242-246`, dispatched at `:268-271`),
   * so a listener always receives `agent` even when the emitter did not pass it.
   *
   * @param {string} name - the event name.
   * @param {...unknown} args - the dispatch arguments.
   * @returns {void}
   */
  function emit(name, ...args) {
    if (name === 'session/event') {
      const [session, event] = args
      for (const entry of projections.values()) {
        const cell = projectionCell(entry, session)
        if (event.seq > cell.seq) {
          cell.state = entry.definition.apply(cell.state, event)
          cell.seq = event.seq
        }
      }
    }
    if (name === 'session/disposed') {
      for (const entry of projections.values()) entry.cells.delete(args[0])
    }
    const fused = name === 'agent/pre-step' && args[0] !== null && typeof args[0] === 'object'
      ? [{ ...args[0], agent: args[0].agent ?? defaultAgent }, ...args.slice(1)]
      : args
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...fused)
  }

  /**
   * Run one waterfall event through every listener, outermost first.
   *
   * Mirrors `Context.waterfall` (`asar:cordis/lib/index.js:317-325`): the last
   * argument is the innermost `next`, each listener wraps it, and the outermost
   * listener's return value is the result. `agent/pre-step` gets the same `agent`
   * fusion {@link emit} applies.
   *
   * @param {string} name - the event name.
   * @param {...unknown} args - the listener arguments, then the innermost `next`.
   * @returns {Promise<unknown>} the outermost listener's return value.
   */
  async function waterfall(name, ...args) {
    const inner = args.pop()
    const fused = name === 'agent/pre-step' && args[0] !== null && typeof args[0] === 'object'
      ? [{ ...args[0], agent: args[0].agent ?? defaultAgent }, ...args.slice(1)]
      : args
    const queue = [...(listeners.get(name) ?? [])]
    const next = () => {
      const listener = queue.shift()
      return listener === undefined ? inner(...fused) : listener(...fused, next)
    }
    return await next()
  }

  /**
   * Dispose every effect, as an unload would.
   * @returns {void}
   */
  function disposeAll() {
    for (const dispose of effects.splice(0).reverse()) dispose()
  }

  /**
   * How many listeners are registered for an event.
   * @param {string} name - the event name.
   * @returns {number} the count.
   */
  function listenerCount(name) {
    return (listeners.get(name) ?? []).length
  }

  return { ctx, emit, waterfall, disposeAll, listenerCount, warnings, effects, fakeTools }
}

/**
 * A fake session carrying the fields the real `Session` exposes.
 *
 * Every field is copied from the real class:
 * - `header.isSeeded` / `header.parentSession` — `asar:dsh-session/lib/index.js:1051-1052,1415`
 * - `inheritedEventCount` — the exact inherited prefix length, 同文件 `:1342`
 * - `firstLiveSeq` — the log length captured right after the constructor seed, never updated, 同文件 `:1360,1414`
 * - `firstLifecycleSeq` — `inheritedEventCount` for a seeded snapshot (a fresh fork), else `firstLiveSeq`, 同文件 `:1361-1366,1426`
 * - `seq` — the next event's number, always the log length, 同文件 `:1476-1479`
 *
 * Defaults describe an unseeded session that has appended nothing since
 * construction, so `firstLiveSeq === seq`.
 *
 * @param {string} id - the session id.
 * @param {object} [options] - session facts.
 * @param {boolean} [options.isSeeded] - whether this session inherits a prefix.
 * @param {string} [options.parentSession] - the fork parent id.
 * @param {number} [options.inheritedEventCount] - the inherited prefix length.
 * @param {number} [options.firstLiveSeq] - the first-live sequence.
 * @param {number} [options.firstLifecycleSeq] - the first-lifecycle sequence.
 * @param {number} [options.seq] - the next event's sequence number.
 * @returns {object} the fake session.
 */
export function fakeSession(id, {
  isSeeded = false,
  parentSession,
  inheritedEventCount = 0,
  firstLiveSeq,
  firstLifecycleSeq,
  seq,
} = {}) {
  const header = { id, version: 4, createdAt: 0, isSeeded }
  if (parentSession !== undefined) header.parentSession = parentSession
  const resolvedSeq = seq ?? firstLiveSeq ?? inheritedEventCount
  const resolvedLive = firstLiveSeq ?? resolvedSeq
  return {
    id,
    header,
    inheritedEventCount,
    firstLiveSeq: resolvedLive,
    // A seeded snapshot is a fresh fork: firstLifecycleSeq is the inherited cut.
    firstLifecycleSeq: firstLifecycleSeq
      ?? (isSeeded ? inheritedEventCount : resolvedLive),
    seq: resolvedSeq,
  }
}

/**
 * Build the session a real `ctx.sessions.fork()` produces.
 *
 * `buildForkSeed` copies the prefix through `boundary`, pushes an inherited
 * `session/end-seed` at `boundary + 1`, then appends the open turn's closers
 * (`asar:dsh-session/lib/index.js:927-936`). `inheritedEventCount` counts only
 * the copied prefix, `boundary + 1` (`:2014`). The constructor then leaves
 * `firstLiveSeq === seq === inheritedEventCount + 1 + closers`, while
 * `firstLifecycleSeq === inheritedEventCount` — the fresh-fork signature.
 *
 * @param {string} id - the child session id.
 * @param {object} [options] - fork shape.
 * @param {string} [options.parentSession] - the parent session id.
 * @param {number} [options.boundary] - the inclusive source seq forked through.
 * @param {number} [options.closers] - how many open-turn closer events the seed carries.
 * @returns {object} the fake session.
 */
export function fakeForkSession(id, { parentSession = 'session-parent', boundary = 39, closers = 2 } = {}) {
  const inheritedEventCount = boundary + 1
  const length = inheritedEventCount + 1 + closers
  return fakeSession(id, {
    isSeeded: true,
    parentSession,
    inheritedEventCount,
    firstLiveSeq: length,
    firstLifecycleSeq: inheritedEventCount,
    seq: length,
  })
}

/**
 * Build a forked session that was restored from disk.
 *
 * The restore path seeds the constructor with the whole stored log and presets
 * `storedCount` to its full length, so `appendUnstoredSuffix` appends nothing
 * (`asar:dsh-agent-loop/lib/index.js:2000-2004`). The constructor runs in
 * restore mode, so `firstLifecycleSeq === firstLiveSeq` — NOT the fork shape.
 * Its projection folds the parent prefix plus the child's own pre-restart
 * history, so no baseline can be derived from it.
 *
 * @param {string} id - the child session id.
 * @param {object} [options] - restore shape.
 * @param {string} [options.parentSession] - the parent session id.
 * @param {number} [options.inheritedEventCount] - the inherited prefix length.
 * @param {number} [options.length] - the stored log length.
 * @returns {object} the fake session.
 */
export function fakeRestoredForkSession(id, {
  parentSession = 'session-parent',
  inheritedEventCount = 40,
  length = 300,
} = {}) {
  return fakeSession(id, {
    isSeeded: true,
    parentSession,
    inheritedEventCount,
    firstLiveSeq: length,
    firstLifecycleSeq: length,
    seq: length,
  })
}

/**
 * Build a `turn/end` event.
 * @param {number} turn - the turn number.
 * @param {number} [seq] - the sequence number; defaults to a turn-derived value.
 * @returns {object} the event.
 */
export function turnEnd(turn, seq = turn * 10) {
  return { type: 'turn/end', seq, data: { turn, reason: { kind: 'completed' } } }
}

/**
 * Build a `compaction/summary` event.
 * @param {object} usage - the provider usage of the summarization call.
 * @param {number} [seq] - the sequence number.
 * @returns {object} the event.
 */
export function compactionSummary(usage, seq = 1) {
  return { type: 'compaction/summary', seq, data: { summary: [], usage } }
}

/**
 * Build an `assistant/message` event, the one request settlement that counts as
 * a completed request (`asar:dsh-agent-loop/lib/index.js:1156-1162`).
 * @param {number} [seq] - the sequence number.
 * @param {number} [turn] - the turn number.
 * @returns {object} the event.
 */
export function assistantMessage(seq = 1, turn = 1) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    },
  }
}

/**
 * The `tokenUsage` projection state for given totals.
 * @param {object} totals - the four buckets.
 * @returns {{totals: object, last: null}} the projection state.
 */
export function tokenUsageState(totals) {
  return { totals, last: null }
}
