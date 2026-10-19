/**
 * dsh-sol host half.
 *
 * One export form only — `apply(ctx, config)` with an optional `inject`
 * (`dsh-plugin-guide/official/cordis-plugin-development/references/host-plugin.md:59-64`).
 * Every registration goes through `ctx.effect` or `ctx.on` and is therefore
 * owned by this plugin's fiber: unloading the row removes it.
 *
 * `inject` lists every service this plugin reads, so a profile without one
 * keeps the plugin inactive instead of throwing (`practices.md:20`). Both are
 * always present in a base-backed profile: `sessionProjections`
 * (`asar:dsh-base/cordis.patch.yml:172-173`) and `tools` (`:167-168`).
 *
 * Nothing here touches another plugin's data, registers a name that already
 * exists, or writes outside `$DSH_HOME/dsh-sol/` (`report.md` 3.7).
 *
 * @module dsh-sol
 */

import { appendLedgerRecord, resolveDshHome } from './lib/ledger.js'
import { createArchiver } from './lib/archive.js'
import { anyMechanismEnabled, resolveConfig } from './lib/config.js'
import { mountFusion } from './lib/fusion.js'
import { mountMeter } from './lib/meter.js'
import { mountOcc } from './lib/occ.js'
import { createObservationHandler, defineRecallTool } from './lib/observation.js'
import { createReducerHandler } from './lib/reducer.js'

export const name = 'dsh-sol'

/** Services this plugin needs; a profile without them keeps it inactive. */
export const inject = ['sessionProjections', 'tools']

/**
 * Run several post-execute handlers as one listener, in order.
 *
 * The event is a waterfall: every listener wraps `next()`, so two separate
 * registrations would nest in an order this plugin does not control. Composing
 * them here makes the order data: the real `next()` runs first, then each
 * handler in array order receives the previous handler's decision as its
 * `next()`. That is what "Reducer first, ObservationPack second" means
 * (`docs/diagrams/flow-overview.svg:43`): the later handler sees the earlier
 * one's replacement instead of overwriting it.
 *
 * A handler that throws must not break the chain, so every call is guarded
 * (`report.md` 3.7, rule 3).
 *
 * @param {Function[]} handlers - post-execute handlers, in order.
 * @param {Function} [warn] - a warning sink.
 * @returns {Function} the composed listener.
 */
export function composePostExecute(handlers, warn = () => {}) {
  return async function dshSolPostExecute(exec, result, next) {
    let decision = await next()
    for (const handler of handlers) {
      try {
        decision = await handler(exec, result, () => Promise.resolve(decision))
      } catch (error) {
        warn(`dsh-sol post-execute: kept the previous decision: ${String(error?.message ?? error)}`)
      }
    }
    return decision
  }
}

/**
 * Build the archiver factory the mechanisms share.
 *
 * One archive directory for ObservationPack and Reducer, so identical bytes are
 * stored once (`report.md` 2.2). A call without an owning session has nowhere
 * to archive to, so it throws and the caller keeps the original result.
 *
 * @param {string|undefined} home - the configured home override.
 * @returns {Function} `(exec) => archiver`.
 */
export function createArchiverFor(home) {
  return function archiverFor(exec) {
    const sessionId = exec?.agent?.session?.header?.id
    if (typeof sessionId !== 'string') {
      throw new Error('the call has no owning session, so there is nowhere to archive')
    }
    return createArchiver({ home, sessionId })
  }
}

/**
 * Build the ledger sink the mechanisms share.
 *
 * The ledger is best effort for the mechanisms that replace a result: a failed
 * write is a warning, never a reason to hand back something different
 * (`report.md` 3.4).
 *
 * The home is resolved here, not by the caller. `resolveConfig` leaves
 * `meter.home` undefined when the user did not set it, and
 * `appendLedgerRecord` builds its path with `join()`, which throws on
 * `undefined`. A live run hit exactly that: the archive write succeeded, the
 * ledger write threw, and ObservationPack kept the original result — so the
 * mechanism silently did nothing (`notes/live-load-1.md`).
 *
 * @param {string|undefined} home - the configured home override.
 * @param {Function} warn - a warning sink.
 * @returns {Function} `(record) => Promise<void>`.
 */
function createRecordSink(home, warn) {
  const resolvedHome = resolveDshHome(home)
  return async function record(entry) {
    const sessionId = entry?.sessionId
    if (typeof sessionId !== 'string') {
      warn('dsh-sol: refusing a ledger line without a session id')
      return
    }
    await appendLedgerRecord({ home: resolvedHome, sessionId, record: entry })
  }
}

/**
 * Assemble the mechanisms the row config enables.
 * @param {object} ctx - the plugin context.
 * @param {unknown} rawConfig - the row's `config`.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // Every mechanism is off by default; an all-off row must still load quietly
  // and register nothing at all (`report.md` 3.7, rule 5).
  if (!anyMechanismEnabled(config)) return
  const warn = (message) => {
    try {
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
      else console.warn(message)
    } catch {
      // A logger failure must not change behaviour.
    }
  }
  ctx.effect(() => {
    const disposers = []
    if (config.meter.enabled) {
      disposers.push(mountMeter(ctx, { enabled: true, home: config.meter.home }))
    }
    if (config.actionFusion.enabled) {
      disposers.push(mountFusion(ctx, { shells: config.actionFusion.shells }))
    }

    // One post-execute listener for the whole plugin, with the mechanisms as
    // ordered steps inside it. The order is fixed here and not by registration
    // timing (`docs/diagrams/flow-overview.svg:43`): the Reducer runs first, so
    // a receipt it produces is what ObservationPack sees and leaves alone.
    const archiverFor = createArchiverFor(config.meter.home)
    const record = createRecordSink(config.meter.home, warn)
    const postExecute = []
    if (config.reducer.enabled) {
      postExecute.push(createReducerHandler({
        ctx,
        configFor: () => config.reducer,
        archiverFor,
        // The shell list is shared with Fusion: a second configuration key would
        // be one more thing to get wrong (`notes/step34-spec.md` 7.2).
        shells: config.actionFusion.shells,
        warn,
        record,
      }))
    }
    const observation = config.observationPack
    if (observation.enabled) {
      postExecute.push(createObservationHandler({
        archiverFor,
        thresholdBytes: observation.thresholdBytes,
        warn,
        record,
      }))
    }
    if (postExecute.length > 0) {
      disposers.push(ctx.on('tools/post-execute', composePostExecute(postExecute, warn)))
    }
    if (observation.enabled) {
      disposers.push(ctx.tools.register(defineRecallTool({ archiverFor, record })))
    }

    // OCC reads `tokenMeter`, `llm`, `agentPresets` and `compaction` through
    // `ctx.get` rather than `inject`: making the whole plugin inactive because
    // one optional service is missing would take the other mechanisms with it
    // (`notes/step5-facts.md` 10.5).
    if (config.occ.enabled) {
      disposers.push(mountOcc(ctx, {
        configFor: () => config.occ,
        append: appendLedgerRecord,
        // Resolved, for the same reason `createRecordSink` resolves it: an
        // undefined home makes every OCC ledger line throw.
        home: resolveDshHome(config.meter.home),
        warn,
      }))
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // A disposer that throws must not block the remaining ones.
        }
      }
    }
  }, 'dsh-sol: mechanisms')
}
