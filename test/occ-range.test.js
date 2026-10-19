/**
 * Tests for OCC range selection and threshold arithmetic.
 *
 * Every case is a plain object: no DSH, no model, no real compaction. The
 * expected values come from the engine's own formulas
 * (`asar:dsh-compaction-basic/lib/index.js:132-134`) and from
 * `notes/step5-facts.md` 10.1 and 10.2.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EARLY_FACTOR,
  computeCuts,
  computeThresholds,
  eventDelta,
  selectRange,
} from '../lib/occ-range.js'

/* ------------------------------------------------------------------ */
/* eventDelta                                                          */
/* ------------------------------------------------------------------ */

test('tool/call announces a call but does not open one', () => {
  // The +1 comes from the assistant message's block, never from tool/call
  // (notes/step5-facts.md 10.0 补充 a).
  assert.equal(eventDelta({ type: 'tool/call', data: { callId: 'c1' } }), 0)
})

test('an assistant message adds one per tool-call block', () => {
  assert.equal(eventDelta({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text' }, { type: 'tool-call' }, { type: 'tool-call' }] } },
  }), 2)
  assert.equal(eventDelta({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'no tools' }] } },
  }), 0)
})

test('a tool result subtracts one and anything else adds nothing', () => {
  assert.equal(eventDelta({ type: 'tool/result', data: { toolCallId: 'c1' } }), -1)
  for (const type of ['user/message', 'turn/start', 'turn/end', 'todo/write', 'compaction/start']) {
    assert.equal(eventDelta({ type }), 0, type)
  }
})

test('a malformed event yields null rather than a wrong delta', () => {
  assert.equal(eventDelta(null), null)
  assert.equal(eventDelta({ type: 'assistant/message' }), null)
  assert.equal(eventDelta({ type: 'assistant/message', data: { message: { content: 'x' } } }), null)
})

/* ------------------------------------------------------------------ */
/* computeCuts                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a surface and its events from a compact description.
 * @param {Array<[string, number]>} steps - `[type, toolCallCount]` pairs.
 * @returns {{seqs: number[], eventAt: Function}} the surface.
 */
function surfaceOf(steps) {
  const seqs = []
  const events = new Map()
  let seq = 0
  for (const [type, calls] of steps) {
    seqs.push(seq)
    if (type === 'assistant/message') {
      const content = []
      for (let index = 0; index < calls; index += 1) content.push({ type: 'tool-call' })
      events.set(seq, { type, seq, data: { message: { content } } })
    } else {
      events.set(seq, { type, seq, data: {} })
    }
    seq += 1
  }
  return { seqs, eventAt: (value) => events.get(value) }
}

test('a paired call and result makes both surrounding cuts balanced', () => {
  const { seqs, eventAt } = surfaceOf([
    ['system/message', 0],
    ['assistant/message', 1],
    ['tool/result', 0],
    ['assistant/message', 0],
  ])
  // cuts[0] before system, cuts[1] before the call (open=0), cuts[2] between
  // call and result (open=1), cuts[3] after the result (open=0), cuts[4] at end.
  assert.deepEqual(computeCuts({ surfaceSeqs: seqs, eventAt }), [true, true, false, true, true])
})

test('an unclosed call leaves every later cut unbalanced', () => {
  const { seqs, eventAt } = surfaceOf([
    ['assistant/message', 1],
    ['assistant/message', 0],
  ])
  assert.deepEqual(computeCuts({ surfaceSeqs: seqs, eventAt }), [true, false, false])
})

test('a result without an open call is a corrupt surface', () => {
  const { seqs, eventAt } = surfaceOf([['tool/result', 0]])
  assert.equal(computeCuts({ surfaceSeqs: seqs, eventAt }), null)
})

test('a missing or mismatched event is a corrupt surface', () => {
  const { seqs } = surfaceOf([['system/message', 0]])
  assert.equal(computeCuts({ surfaceSeqs: seqs, eventAt: () => undefined }), null)
  assert.equal(computeCuts({ surfaceSeqs: seqs, eventAt: () => ({ type: 'x', seq: 99 }) }), null)
})

test('a non-array surface is refused instead of throwing', () => {
  assert.equal(computeCuts({ surfaceSeqs: null, eventAt: () => ({}) }), null)
  assert.equal(computeCuts({ surfaceSeqs: [], eventAt: null }), null)
})

/* ------------------------------------------------------------------ */
/* selectRange                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build priced nodes for a surface.
 * @param {readonly number[]} seqs - the surface.
 * @param {readonly number[]} tokens - one price per node.
 * @returns {object[]} the nodes.
 */
function nodesOf(seqs, tokens) {
  return seqs.map((seq, index) => ({ seq, tokens: tokens[index], heuristicTokens: tokens[index] }))
}

test('a normal surface yields a range whose ends are balanced', () => {
  const { seqs, eventAt } = surfaceOf([
    ['system/message', 0],
    ['user/message', 0],
    ['assistant/message', 1],
    ['tool/result', 0],
    ['user/message', 0],
    ['assistant/message', 0],
  ])
  const nodes = nodesOf(seqs, [100, 100, 100, 100, 100, 100])
  const range = selectRange({ surfaceSeqs: seqs, nodes, eventAt, retainTokens: 150 })
  assert.deepEqual(range, { start: 1, end: 3, nodes: 3, tokens: 300 })
})

test('the system head never enters the range', () => {
  const { seqs, eventAt } = surfaceOf([
    ['system/message', 0],
    ['user/message', 0],
    ['user/message', 0],
  ])
  const nodes = nodesOf(seqs, [1000, 100, 100])
  const range = selectRange({ surfaceSeqs: seqs, nodes, eventAt, retainTokens: 100 })
  assert.equal(range.start, 1, 'start must not be the system head')
})

test('without a system head the range starts at node 0', () => {
  const { seqs, eventAt } = surfaceOf([
    ['user/message', 0],
    ['user/message', 0],
  ])
  const nodes = nodesOf(seqs, [100, 100])
  const range = selectRange({ surfaceSeqs: seqs, nodes, eventAt, retainTokens: 100 })
  assert.equal(range.start, 0)
  assert.equal(range.end, 0)
})

test('a tail larger than the whole surface leaves nothing to compact', () => {
  const { seqs, eventAt } = surfaceOf([
    ['system/message', 0],
    ['user/message', 0],
  ])
  const nodes = nodesOf(seqs, [100, 100])
  assert.equal(selectRange({ surfaceSeqs: seqs, nodes, eventAt, retainTokens: 1000 }), null)
})

test('the cut moves back off an unclosed tool call', () => {
  const { seqs, eventAt } = surfaceOf([
    ['system/message', 0],
    ['user/message', 0],
    ['assistant/message', 1],
    ['tool/result', 0],
    ['user/message', 0],
  ])
  const nodes = nodesOf(seqs, [10, 100, 100, 100, 100])
  // retainTokens=100 puts the cut before the last node; walking back one more
  // lands between the call and its result, so the cut must retreat to before
  // the assistant message.
  const range = selectRange({ surfaceSeqs: seqs, nodes, eventAt, retainTokens: 150 })
  assert.equal(range.end, 1, 'the range must not end inside a tool-call pair')
})

test('priced nodes that disagree with the surface yield null, not a throw', () => {
  const { seqs, eventAt } = surfaceOf([['system/message', 0], ['user/message', 0]])
  assert.equal(selectRange({
    surfaceSeqs: seqs,
    nodes: nodesOf([10, 11], [1, 1]),
    eventAt,
    retainTokens: 0,
  }), null)
  assert.equal(selectRange({ surfaceSeqs: seqs, nodes: [], eventAt, retainTokens: 0 }), null)
  assert.equal(selectRange({ surfaceSeqs: seqs, nodes: nodesOf(seqs, [1, 1]), eventAt, retainTokens: 0 }), null,
    'a missing event makes the surface unreadable')
})

test('an empty surface yields null', () => {
  assert.equal(selectRange({ surfaceSeqs: [], nodes: [], eventAt: () => undefined, retainTokens: 0 }), null)
})

/* ------------------------------------------------------------------ */
/* computeThresholds                                                   */
/* ------------------------------------------------------------------ */

test('the main model of this machine triggers at 55% natively', () => {
  // 1M window, 384k reserved output, 65536 headroom (notes/step5-facts.md 10.2).
  const budgets = computeThresholds({ contextWindow: 1_000_000, reservedOutput: 384_000 })
  assert.equal(budgets.nativeThreshold, 550_464)
  assert.equal(budgets.occThreshold, Math.floor(Math.min(0.5 * 1_000_000, 550_464 * EARLY_FACTOR)))
  assert.equal(budgets.occThreshold, 467_894)
  assert.equal(budgets.retainTokens, Math.floor((1_000_000 - 384_000) * 0.16))
})

test('a small window uses the pressure budget, so OCC must use the 0.85 cap', () => {
  const budgets = computeThresholds({ contextWindow: 128_000, reservedOutput: 8_192 })
  assert.equal(budgets.nativeThreshold, 54_272)
  assert.equal(budgets.occThreshold, Math.floor(54_272 * EARLY_FACTOR))
  assert.ok(budgets.occThreshold < 0.5 * 128_000, 'the raw ratio would fire after the engine already did')
})

test('a window with no room at all produces a negative budget, which the caller skips', () => {
  // The engine throws a config error here (`:132-134`); OCC must not throw, so
  // the numbers come back negative and the handler skips on `occThreshold <= 0`.
  const budgets = computeThresholds({ contextWindow: 64_000, reservedOutput: 8_192 })
  assert.ok(budgets.occThreshold <= 0)
  assert.ok(budgets.nativeThreshold <= 0)
  assert.equal(computeThresholds({ contextWindow: 0, reservedOutput: 0 }), null)
  assert.equal(computeThresholds({ contextWindow: 1000, reservedOutput: 1000 }), null)
  assert.equal(computeThresholds({ contextWindow: 1000, reservedOutput: -1 }), null)
})

test('the 96k case is the one that needs both guards', () => {
  // occ is positive but retain is larger: the engine throws a config error here,
  // OCC must skip (notes/step5-facts.md 10.2 补充 b).
  const budgets = computeThresholds({ contextWindow: 96_000, reservedOutput: 16_384 })
  assert.equal(budgets.nativeThreshold, 14_080)
  assert.equal(budgets.occThreshold, 11_968)
  assert.equal(budgets.retainTokens, 12_738)
  assert.ok(budgets.occThreshold > 0, 'the <= 0 guard alone would let this through')
  assert.ok(budgets.retainTokens >= budgets.occThreshold, 'the retain guard is what catches it')
})
