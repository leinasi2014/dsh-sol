/**
 * Range selection for Online Context Compact.
 *
 * A compaction range must satisfy the engine's own validator
 * (`asar:dsh-compaction-basic/lib/index.js:549-566`): both ends are surface
 * sequences, `start` is not after `end`, and neither end splits an
 * assistant tool-call from its result. The engine's `selectCompactableRange` is
 * not exported, so this module re-implements the same rules
 * (`notes/step5-facts.md` 10.1).
 *
 * The tool-pairing balance is computed here rather than imported: it lives in
 * `@deepseek-ai/dsh-compaction` and this plugin imports no `@deepseek-ai/*`
 * package (`report.md` 3.2). The algorithm is the engine's own
 * (`asar:dsh-compaction/lib/index.js:19-58`): `assistant/message` adds one per
 * `tool-call` block, `tool/result` subtracts one, everything else — including
 * `tool/call`, which only announces a call — adds nothing.
 *
 * Every function returns `null` instead of throwing when the surface is
 * inconsistent: a plugin must give way, not break the step
 * (`report.md` 3.7, rule 3).
 *
 * @module dsh-sol/occ-range
 */

/** Default share of the message budget kept verbatim, matching the engine. */
export const RETAIN_RATIO = 0.16

/** How much earlier than the engine OCC acts; a guess, calibrated by dry runs. */
export const EARLY_FACTOR = 0.85

/**
 * How one surface event changes the open tool-call count.
 *
 * @param {object} event - a session event.
 * @returns {number|null} the delta, or null when the event is malformed.
 */
export function eventDelta(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type === 'tool/result') return -1
  if (event.type !== 'assistant/message') return 0
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return null
  let calls = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call') calls += 1
  }
  return calls
}

/**
 * Compute which cuts leave no open tool call across them.
 *
 * `cuts[i]` is the cut immediately before `surfaceSeqs[i]`, and
 * `cuts[surfaceSeqs.length]` is the cut after the last node — the same
 * `index + offset` indexing the engine uses.
 *
 * @param {object} input - the inputs.
 * @param {readonly number[]} input.surfaceSeqs - the surface, in order.
 * @param {Function} input.eventAt - `(seq) => event|undefined`.
 * @returns {boolean[]|null} the cut array, or null when the surface is corrupt.
 */
export function computeCuts({ surfaceSeqs, eventAt }) {
  if (!Array.isArray(surfaceSeqs)) return null
  if (typeof eventAt !== 'function') return null
  const cuts = [true]
  let inProgress = 0
  for (const seq of surfaceSeqs) {
    const event = eventAt(seq)
    if (event === undefined || event === null) return null
    if (event.seq !== seq) return null
    const delta = eventDelta(event)
    if (delta === null) return null
    inProgress += delta
    if (inProgress < 0) return null
    cuts.push(inProgress === 0)
  }
  return cuts
}

/**
 * Sum the priced tokens of a node range.
 * @param {readonly object[]} nodes - priced nodes.
 * @param {number} startIdx - inclusive first index.
 * @param {number} endIdx - inclusive last index.
 * @returns {number} the token total.
 */
function sumTokens(nodes, startIdx, endIdx) {
  let total = 0
  for (let index = startIdx; index <= endIdx; index += 1) {
    const tokens = nodes[index]?.tokens
    total += Number.isFinite(tokens) && tokens > 0 ? tokens : 0
  }
  return total
}

/**
 * Pick the inclusive surface range to compact.
 *
 * The rules, in order: the priced nodes must match the surface exactly; the
 * system head never enters the range; the tail worth `retainTokens` stays
 * verbatim; the cut is moved back to a balanced one; and both ends are
 * re-checked before returning (`notes/step5-facts.md` 10.1).
 *
 * @param {object} input - the inputs.
 * @param {readonly number[]} input.surfaceSeqs - the current surface.
 * @param {readonly {seq: number, tokens: number}[]} input.nodes - the priced nodes.
 * @param {Function} input.eventAt - `(seq) => event|undefined`.
 * @param {number} input.retainTokens - the tail budget kept verbatim.
 * @returns {{start: number, end: number, nodes: number, tokens: number}|null} the range.
 */
export function selectRange({ surfaceSeqs, nodes, eventAt, retainTokens }) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  if (!Array.isArray(surfaceSeqs) || surfaceSeqs.length !== nodes.length) return null
  for (let index = 0; index < surfaceSeqs.length; index += 1) {
    if (surfaceSeqs[index] !== nodes[index]?.seq) return null
  }
  const cuts = computeCuts({ surfaceSeqs, eventAt })
  if (cuts === null) return null

  const head = eventAt(surfaceSeqs[0])
  if (head === undefined || head === null) return null
  const firstIdx = head.type === 'system/message' ? 1 : 0

  const budget = Number.isFinite(retainTokens) && retainTokens > 0 ? retainTokens : 0
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += sumTokens(nodes, index, index)
    keepFrom = index
    if (accumulated >= budget) break
  }
  if (keepFrom <= firstIdx) return null

  while (keepFrom > firstIdx && cuts[keepFrom] !== true) keepFrom -= 1
  if (keepFrom <= firstIdx) return null

  const startIdx = firstIdx
  const endIdx = keepFrom - 1
  if (cuts[startIdx] !== true) return null
  if (cuts[endIdx + 1] !== true) return null
  if (startIdx > endIdx) return null

  return {
    start: surfaceSeqs[startIdx],
    end: surfaceSeqs[endIdx],
    nodes: endIdx - startIdx + 1,
    tokens: sumTokens(nodes, startIdx, endIdx),
  }
}

/**
 * The engine's pressure and retention budgets for one model.
 *
 * The engine triggers at `min(ratio × W, W − O − headroom)` and keeps
 * `(W − O) × retainRatio` verbatim (`asar:dsh-compaction-basic/lib/index.js:132-134`).
 * OCC triggers earlier than that, by `EARLY_FACTOR`, but never later
 * (`notes/step5-facts.md` 10.2).
 *
 * @param {object} input - the inputs.
 * @param {number} input.contextWindow - the model's window, in tokens.
 * @param {number} input.reservedOutput - the output budget one request reserves.
 * @param {number} [input.thresholdRatio] - OCC's share of the window.
 * @param {number} [input.nativeRatio] - the engine's share of the window.
 * @param {number} [input.headroomTokens] - the engine's headroom.
 * @param {number} [input.retainRatio] - the share kept verbatim.
 * @returns {{nativeThreshold: number, occThreshold: number, retainTokens: number}|null} the budgets.
 */
export function computeThresholds({
  contextWindow,
  reservedOutput,
  thresholdRatio = 0.5,
  nativeRatio = 0.8,
  headroomTokens = 65536,
  retainRatio = RETAIN_RATIO,
}) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null
  if (!Number.isInteger(reservedOutput) || reservedOutput < 0) return null
  const messageBudget = contextWindow - reservedOutput
  if (messageBudget <= 0) return null
  const nativeThreshold = Math.floor(Math.min(contextWindow * nativeRatio, messageBudget - headroomTokens))
  const occThreshold = Math.floor(Math.min(thresholdRatio * contextWindow, nativeThreshold * EARLY_FACTOR))
  const retainTokens = Math.floor(messageBudget * retainRatio)
  return { nativeThreshold, occThreshold, retainTokens }
}
