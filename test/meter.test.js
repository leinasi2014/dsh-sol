import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addBuckets,
  bucketsFromUsage,
  buildTurnRecord,
  BUCKET_KEYS,
  forkFacts,
  isFreshFork,
  MeterState,
  mountMeter,
  subtractBuckets,
  totalsOf,
  zeroBuckets,
} from '../lib/meter.js'
import {
  compactionSummary,
  assistantMessage,
  createFakeCtx,
  fakeForkSession,
  fakeRestoredForkSession,
  fakeSession,
  tokenUsageState,
  turnEnd,
} from './fake-ctx.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'
const CHILD_ID = 'session-child-0001'
const PARENT_ID = 'session-parent-0001'

/**
 * Fill a partial bucket set, because the real `tokenUsage` projection state is
 * strict and always carries all four counters
 * (`asar:dsh-token-meter/lib/index.js:339-356`).
 * @param {object} [partial] - the buckets the test cares about.
 * @returns {object} all four buckets.
 */
function buckets(partial = {}) {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  }
}

/**
 * Mount the meter on a fake context and collect the records it appends.
 *
 * `totals` is mutable so a test can advance the "projection" between turns.
 * @param {object} [options] - overrides.
 * @param {object} [options.totals] - the tokenUsage totals.
 * @param {object} [options.session] - the session to use.
 * @param {boolean} [options.throwOnStateOf] - make the projection read throw.
 * @param {boolean} [options.announce] - fire `session/created` before returning.
 * @returns {object} the harness.
 */
function harness({ totals, session, throwOnStateOf = false, announce = false } = {}) {
  const live = buckets(totals)
  const fake = createFakeCtx({ throwOnStateOf })
  fake.ctx.sessionProjections.stateOf = () => (throwOnStateOf ? (() => { throw new Error('nope') })() : tokenUsageState(live))
  const records = []
  const append = ({ sessionId, record }) => {
    records.push({ sessionId, record })
  }
  mountMeter(fake.ctx, {
    enabled: true,
    home: 'C:/fake-home',
    append,
    now: () => new Date('2026-10-18T04:00:00.000Z'),
  })
  const target = session ?? fakeSession(GOOD_ID)
  if (announce) fake.emit('session/created', target)
  /**
   * Replace the projection totals, as the real fold would.
   * @param {object} next - the new totals.
   * @returns {void}
   */
  const setTotals = (next) => Object.assign(live, buckets(next))
  return { ...fake, records, session: target, setTotals, totals: live }
}

test('one turn produces exactly one ledger line', () => {
  const h = harness({
    totals: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 },
  })
  h.emit('session/event', h.session, turnEnd(1))
  assert.equal(h.records.length, 1)
  const record = h.records[0].record
  assert.equal(record.kind, 'turn')
  assert.equal(record.sessionId, GOOD_ID)
  assert.equal(record.turn, 1)
  assert.equal(record.seq, 10)
  assert.deepEqual(record.usage, {
    uncachedInputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
  })
  assert.deepEqual(record.usageTotal, record.usage)
  assert.equal(record.at, '2026-10-18T04:00:00.000Z')
  assert.equal(record.v, 1)
  assert.equal(record.baseline, 'zero')
  assert.equal(record.isSeeded, false)
  assert.equal(record.inheritedEventCount, 0)
})

test('the four buckets are read from .totals, not the top level', () => {
  const fake = createFakeCtx()
  const records = []
  // A state shaped exactly like the projection: buckets under `.totals`.
  fake.ctx.sessionProjections.stateOf = () => ({
    totals: buckets({ uncachedInputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 }),
    last: { turn: 1, step: 0, buckets: buckets({ uncachedInputTokens: 11 }) },
  })
  mountMeter(fake.ctx, { enabled: true, home: 'C:/h', append: (entry) => records.push(entry) })
  fake.emit('session/event', fakeSession(GOOD_ID), turnEnd(1))
  assert.deepEqual(records[0].record.usage, {
    uncachedInputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheWriteTokens: 44,
  })
})

test('the live projection state is copied, not retained', () => {
  const live = tokenUsageState(buckets({ uncachedInputTokens: 5 }))
  const fake = createFakeCtx()
  const records = []
  fake.ctx.sessionProjections.stateOf = () => live
  mountMeter(fake.ctx, { enabled: true, home: 'C:/h', append: (entry) => records.push(entry) })
  fake.emit('session/event', fakeSession(GOOD_ID), turnEnd(1))
  // Mutating the projection's own object must not change what was recorded.
  live.totals.uncachedInputTokens = 999
  assert.equal(records[0].record.usage.uncachedInputTokens, 5)
  assert.equal(records[0].record.usageTotal.uncachedInputTokens, 5)
})

test('a replayed turn/end for the same seq does not write a second line', () => {
  const h = harness({ totals: { uncachedInputTokens: 10, outputTokens: 1 } })
  h.emit('session/event', h.session, turnEnd(1))
  h.emit('session/event', h.session, turnEnd(1))
  assert.equal(h.records.length, 1)
})

test('the same turn number at a later seq is a new line, and an earlier seq is not', () => {
  const h = harness({ totals: { uncachedInputTokens: 10, outputTokens: 1 } })
  h.emit('session/event', h.session, turnEnd(1, 10))
  h.emit('session/event', h.session, turnEnd(1, 5))
  assert.equal(h.records.length, 1)
})

test('each new turn writes one more line carrying the cumulative totals', () => {
  const h = harness({ totals: { uncachedInputTokens: 10, outputTokens: 1 } })
  h.emit('session/event', h.session, turnEnd(1))
  h.setTotals({ uncachedInputTokens: 30, outputTokens: 4 })
  h.emit('session/event', h.session, turnEnd(2))
  assert.equal(h.records.length, 2)
  assert.deepEqual(h.records.map((entry) => entry.record.turn), [1, 2])
  assert.equal(h.records[1].record.usage.uncachedInputTokens, 30)
})

test('compaction usage is counted into its own bucket, not the main loop', () => {
  const h = harness({ totals: { uncachedInputTokens: 500, outputTokens: 50 } })
  h.emit('session/event', h.session, compactionSummary({ inputTokens: 900, outputTokens: 60, cacheReadTokens: 100 }))
  h.emit('session/event', h.session, turnEnd(1))
  const record = h.records[0].record
  assert.equal(record.compactionCalls, 1)
  assert.deepEqual(record.compaction, {
    uncachedInputTokens: 900,
    outputTokens: 60,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
  })
  assert.deepEqual(record.usage, { uncachedInputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

test('several compactions accumulate across turns', () => {
  const h = harness({ totals: { uncachedInputTokens: 1, outputTokens: 1 } })
  h.emit('session/event', h.session, compactionSummary({ inputTokens: 100, outputTokens: 10 }, 1))
  h.emit('session/event', h.session, turnEnd(1))
  h.emit('session/event', h.session, compactionSummary({ inputTokens: 200, outputTokens: 20 }, 2))
  h.emit('session/event', h.session, turnEnd(2))
  assert.equal(h.records[1].record.compactionCalls, 2)
  assert.equal(h.records[1].record.compaction.uncachedInputTokens, 300)
  assert.equal(h.records[1].record.compaction.outputTokens, 30)
})

test('a compaction summary without usage is ignored', () => {
  const h = harness({ totals: { uncachedInputTokens: 1, outputTokens: 1 } })
  h.emit('session/event', h.session, { type: 'compaction/summary', seq: 5, data: { summary: [] } })
  h.emit('session/event', h.session, turnEnd(1))
  assert.equal(h.records[0].record.compactionCalls, 0)
  assert.deepEqual(h.records[0].record.compaction, zeroBuckets())
})

test('a real forked session records only its own share', () => {
  // The shape `ctx.sessions.fork()` actually produces: firstLifecycleSeq is the
  // inherited cut, firstLiveSeq/seq are inherited+1+closers.
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID, boundary: 39, closers: 2 })
  assert.equal(child.inheritedEventCount, 40)
  assert.equal(child.firstLifecycleSeq, 40)
  assert.equal(child.firstLiveSeq, 43)
  assert.equal(child.seq, 43)
  // At creation the projection already carries the parent's 1000 tokens.
  const h = harness({ session: child, totals: { uncachedInputTokens: 1000, outputTokens: 100 }, announce: true })
  h.setTotals({ uncachedInputTokens: 1050, outputTokens: 110 })
  h.emit('session/event', h.session, turnEnd(1, 50))
  const record = h.records[0].record
  assert.equal(record.baseline, 'fork')
  assert.equal(record.isSeeded, true)
  assert.equal(record.parentSession, PARENT_ID)
  assert.equal(record.inheritedEventCount, 40)
  assert.equal(record.usage.uncachedInputTokens, 50, 'only the child turns are billed to the child')
  assert.equal(record.usage.outputTokens, 10)
  assert.equal(record.usageTotal.uncachedInputTokens, 1050, 'the raw cumulative number is kept for auditing')
})

test('a restored unseeded session needs no baseline and records its whole log', () => {
  // A restored session is unseeded: the projection folds only its own log, so
  // its totals are already its own and no created event is required.
  const restored = fakeSession(GOOD_ID, { seq: 300 })
  const h = harness({ session: restored, totals: { uncachedInputTokens: 42, outputTokens: 3 } })
  h.emit('session/event', h.session, turnEnd(1, 310))
  const record = h.records[0].record
  assert.equal(record.baseline, 'zero')
  assert.equal(record.usage.uncachedInputTokens, 42)
})

test('a restored fork is unknown, never fork — its projection holds pre-restart history', () => {
  // firstLifecycleSeq === firstLiveSeq on the restore path, so it is NOT a
  // fresh fork. Taking its totals as a baseline would silently drop every
  // token the child spent before the restart.
  const child = fakeRestoredForkSession(CHILD_ID, { parentSession: PARENT_ID, inheritedEventCount: 40, length: 300 })
  assert.equal(child.firstLifecycleSeq, child.firstLiveSeq)
  const h = harness({ session: child, totals: { uncachedInputTokens: 2000 }, announce: true })
  h.emit('session/event', h.session, turnEnd(1, 310))
  const record = h.records[0].record
  assert.equal(record.baseline, 'unknown')
  assert.deepEqual(record.usage, zeroBuckets(), 'without an exact baseline, no delta is claimed')
  assert.equal(record.usageTotal.uncachedInputTokens, 2000)
})

test('a seeded session first seen after creation is unknown', () => {
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID })
  // No `session/created` was delivered to this plugin instance.
  const h = harness({ session: child, totals: { uncachedInputTokens: 1000 } })
  h.emit('session/event', h.session, turnEnd(1, 50))
  const record = h.records[0].record
  assert.equal(record.baseline, 'unknown')
  assert.deepEqual(record.usage, zeroBuckets())
})

test('a seeded session with no own events and no readable projection stays unknown', () => {
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID })
  const fake = createFakeCtx()
  fake.ctx.sessionProjections.stateOf = () => undefined
  const records = []
  mountMeter(fake.ctx, { enabled: true, home: 'C:/h', append: (entry) => records.push(entry) })
  fake.emit('session/created', child)
  fake.ctx.sessionProjections.stateOf = () => tokenUsageState(buckets({ uncachedInputTokens: 1000 }))
  fake.emit('session/event', child, turnEnd(1, 50))
  assert.equal(records[0].record.baseline, 'unknown')
})

test('isFreshFork separates a fresh fork from a restored fork', () => {
  // Fresh fork: firstLifecycleSeq is the inherited cut, firstLiveSeq is past it.
  const fork = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID, boundary: 39, closers: 2 })
  assert.equal(isFreshFork(fork), true)

  // Restored fork: the two are equal, so it must NOT qualify.
  const restored = fakeRestoredForkSession(CHILD_ID, { parentSession: PARENT_ID })
  assert.equal(isFreshFork(restored), false)

  // Unseeded sessions are never fresh forks.
  assert.equal(isFreshFork(fakeSession(GOOD_ID)), false)
  assert.equal(isFreshFork(fakeSession(GOOD_ID, { seq: 300 })), false)

  // Missing or malformed fields cannot prove anything.
  assert.equal(isFreshFork({ id: 'x' }), false)
  assert.equal(isFreshFork(undefined), false)
  assert.equal(isFreshFork({ ...fork, firstLiveSeq: 'a' }), false)
  assert.equal(isFreshFork({ ...fork, firstLifecycleSeq: undefined }), false)
})

test('isFreshFork holds for a fork whose boundary is zero', () => {
  // boundary 0 means only one source event is inherited; the marker and closers
  // still push firstLiveSeq past it.
  const fork = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID, boundary: 0, closers: 0 })
  assert.equal(fork.inheritedEventCount, 1)
  assert.equal(fork.firstLiveSeq, 2)
  assert.equal(isFreshFork(fork), true)
})

test('a fork compaction inside the inherited prefix is not counted', () => {
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID })
  const h = harness({ session: child, totals: { uncachedInputTokens: 100 }, announce: true })
  h.emit('session/event', h.session, compactionSummary({ inputTokens: 500 }, 10))
  h.emit('session/event', h.session, compactionSummary({ inputTokens: 7 }, 45))
  h.emit('session/event', h.session, turnEnd(1, 50))
  const record = h.records[0].record
  assert.equal(record.compactionCalls, 1)
  assert.equal(record.compaction.uncachedInputTokens, 7)
})

test('a baseline taken after the parent usage is larger than the total never goes negative', () => {
  assert.deepEqual(subtractBuckets({ uncachedInputTokens: 10 }, { uncachedInputTokens: 50 }), zeroBuckets())
})

test('requests counts one assistant/message per reply', () => {
  const h = harness({ totals: { uncachedInputTokens: 10, outputTokens: 1 } })
  h.emit('session/event', h.session, assistantMessage(3))
  h.emit('session/event', h.session, assistantMessage(5))
  h.emit('session/event', h.session, turnEnd(1, 10))
  assert.equal(h.records[0].record.requests, 2)
})

test('a failed attempt logged as assistant/attempt is not counted as a request', () => {
  // The loop settles a failed attempt as `assistant/attempt` and retries
  // (asar:dsh-agent-loop/lib/index.js:1130-1146), so one reply stays one request.
  const h = harness({ totals: { uncachedInputTokens: 10, outputTokens: 1 } })
  h.emit('session/event', h.session, { type: 'assistant/attempt', seq: 3, data: { turn: 1, step: 0, stream: [] } })
  h.emit('session/event', h.session, { type: 'llm/retry', seq: 4, data: { turn: 1, step: 0, retry: 1 } })
  h.emit('session/event', h.session, { type: 'llm/retry-started', seq: 5, data: { turn: 1, step: 0, retry: 1 } })
  h.emit('session/event', h.session, assistantMessage(6))
  h.emit('session/event', h.session, turnEnd(1, 10))
  assert.equal(h.records[0].record.requests, 1, 'two attempts, one reply, one request')
})

test('requests accumulate across turns and are reported cumulatively', () => {
  const h = harness({ totals: { uncachedInputTokens: 10, outputTokens: 1 } })
  h.emit('session/event', h.session, assistantMessage(3))
  h.emit('session/event', h.session, turnEnd(1, 10))
  h.emit('session/event', h.session, assistantMessage(13))
  h.emit('session/event', h.session, assistantMessage(15))
  h.emit('session/event', h.session, turnEnd(2, 20))
  assert.deepEqual(h.records.map((entry) => entry.record.requests), [1, 3])
})

test('requests inside a fork prefix are not counted', () => {
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID, boundary: 39, closers: 2 })
  const h = harness({ session: child, totals: { uncachedInputTokens: 100 }, announce: true })
  // A parent event replayed below the inherited cut does not count.
  h.emit('session/event', h.session, assistantMessage(5))
  // A child event at or above the cut does.
  h.emit('session/event', h.session, assistantMessage(44))
  h.emit('session/event', h.session, turnEnd(1, 50))
  assert.equal(h.records[0].record.requests, 1)
})

test('a missing projection warns once and never throws', () => {
  const fake = createFakeCtx()
  fake.ctx.sessionProjections.stateOf = () => undefined
  const records = []
  mountMeter(fake.ctx, { enabled: true, home: 'C:/h', append: (entry) => records.push(entry) })
  const session = fakeSession(GOOD_ID)
  assert.doesNotThrow(() => fake.emit('session/event', session, turnEnd(1)))
  assert.doesNotThrow(() => fake.emit('session/event', session, turnEnd(2)))
  assert.equal(records.length, 0)
  assert.equal(fake.warnings.length, 1)
  assert.match(fake.warnings[0], /tokenUsage projection is unavailable/u)
})

test('a projection read that throws is contained', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 }, throwOnStateOf: true })
  assert.doesNotThrow(() => h.emit('session/event', h.session, turnEnd(1)))
  assert.equal(h.records.length, 0)
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /skipped one event/u)
})

test('a malformed projection state counts as missing, not as zero', () => {
  const fake = createFakeCtx()
  fake.ctx.sessionProjections.stateOf = () => ({ totals: { uncachedInputTokens: 'many' } })
  mountMeter(fake.ctx, { enabled: true, home: 'C:/h', append: () => {} })
  fake.emit('session/event', fakeSession(GOOD_ID), turnEnd(1))
  assert.match(fake.warnings[0], /unavailable/u)
})

test('an unsafe session id is refused and warns once', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 }, session: fakeSession('../escape') })
  h.emit('session/event', h.session, turnEnd(1))
  h.emit('session/event', h.session, turnEnd(2))
  assert.equal(h.records.length, 0)
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /unsafe id/u)
})

test('a session without an id is ignored silently', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 } })
  h.emit('session/event', {}, turnEnd(1))
  assert.equal(h.records.length, 0)
  assert.equal(h.warnings.length, 0)
})

test('an unrelated event writes nothing', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 } })
  h.emit('session/event', h.session, { type: 'step/end', seq: 3, data: { step: 0 } })
  assert.equal(h.records.length, 0)
})

test('the listener performs no synchronous I/O and never appends', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 } })
  let appended = 0
  h.session.append = () => { appended += 1 }
  // A synchronous append would throw here in the real Session
  // (`asar:dsh-session/lib/index.js:1567-1570`).
  assert.doesNotThrow(() => h.emit('session/event', h.session, turnEnd(1)))
  assert.equal(appended, 0)
  assert.equal(h.records.length, 1, 'the write was started, not awaited')
})

test('a ledger write failure warns instead of throwing', async () => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState(buckets({ uncachedInputTokens: 1 })) } })
  mountMeter(fake.ctx, {
    enabled: true,
    home: 'C:/fake-home',
    append: () => Promise.reject(new Error('disk full')),
  })
  fake.emit('session/event', fakeSession(GOOD_ID), turnEnd(1))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.warnings.length, 1)
  assert.match(fake.warnings[0], /ledger write failed/u)
})

test('the disposer removes every listener', () => {
  const fake = createFakeCtx({ projectionState: { tokenUsage: tokenUsageState(buckets({ uncachedInputTokens: 1 })) } })
  const records = []
  const dispose = mountMeter(fake.ctx, { enabled: true, home: 'C:/h', append: (entry) => records.push(entry) })
  assert.equal(fake.listenerCount('session/event'), 1)
  assert.equal(fake.listenerCount('session/created'), 1)
  assert.equal(fake.listenerCount('session/disposed'), 1)
  dispose()
  assert.equal(fake.listenerCount('session/event'), 0)
  assert.equal(fake.listenerCount('session/created'), 0)
  assert.equal(fake.listenerCount('session/disposed'), 0)
  fake.emit('session/event', fakeSession(GOOD_ID), turnEnd(1))
  assert.equal(records.length, 0)
})

test('a disposed session drops its state', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 } })
  h.emit('session/event', h.session, turnEnd(1))
  h.emit('session/disposed', h.session)
  h.emit('session/event', h.session, turnEnd(1))
  assert.equal(h.records.length, 2, 'a fresh session record starts from zero state again')
})

test('a turn with a non-numeric turn number is ignored', () => {
  const h = harness({ totals: { uncachedInputTokens: 1 } })
  for (const turn of ['1', -1, 1.5, null, undefined, Number.NaN]) {
    h.emit('session/event', h.session, { type: 'turn/end', seq: 1, data: { turn } })
  }
  assert.equal(h.records.length, 0)
})

test('usage bucket helpers default optional counters to zero', () => {
  assert.deepEqual(bucketsFromUsage({ inputTokens: 5, outputTokens: 6 }), {
    uncachedInputTokens: 5,
    outputTokens: 6,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
  assert.deepEqual(bucketsFromUsage(undefined), zeroBuckets())
  assert.deepEqual(bucketsFromUsage({ inputTokens: -3, outputTokens: Number.NaN }), zeroBuckets())
})

test('bucket addition is per key', () => {
  const sum = addBuckets(
    { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
  )
  assert.deepEqual(sum, { uncachedInputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 })
})

test('totalsOf rejects every shape that is not the documented projection state', () => {
  const good = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
  assert.deepEqual(totalsOf({ totals: good, last: null }), good)
  for (const bad of [undefined, null, 'x', 42, {}, { totals: null }, { totals: [] }]) {
    assert.equal(totalsOf(bad), undefined, JSON.stringify(bad))
  }
  const missingKey = { ...good }
  delete missingKey.outputTokens
  assert.equal(totalsOf({ totals: missingKey }), undefined)
})

test('totalsOf returns a copy', () => {
  const source = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
  const copy = totalsOf({ totals: source })
  copy.uncachedInputTokens = 99
  assert.equal(source.uncachedInputTokens, 1)
})

test('forkFacts tolerates a session without a header', () => {
  assert.deepEqual(forkFacts({ id: 'x' }), { isSeeded: false, parentSession: undefined, inheritedEventCount: 0 })
  assert.deepEqual(forkFacts(undefined), { isSeeded: false, parentSession: undefined, inheritedEventCount: 0 })
  assert.deepEqual(
    forkFacts({ id: 'x', header: { isSeeded: true, parentSession: 'p' }, inheritedEventCount: 7 }),
    { isSeeded: true, parentSession: 'p', inheritedEventCount: 7 },
  )
})

test('MeterState tracks compaction per session independently', () => {
  const state = new MeterState()
  const a = fakeSession('session-a')
  const b = fakeSession('session-b')
  state.noteCompaction(a, compactionSummary({ inputTokens: 10, outputTokens: 1 }))
  state.noteCompaction(b, compactionSummary({ inputTokens: 20, outputTokens: 2 }))
  assert.equal(state.claimTurn(a, 1, 10).compaction.uncachedInputTokens, 10)
  assert.equal(state.claimTurn(b, 1, 10).compaction.uncachedInputTokens, 20)
  assert.equal(state.hasTurn(a, 1, 10), true)
  assert.equal(state.hasTurn(a, 2, 20), false)
})

test('the record shape is stable', () => {
  const record = buildTurnRecord({
    sessionId: GOOD_ID,
    seq: 7,
    turn: 3,
    usage: zeroBuckets(),
    usageTotal: zeroBuckets(),
    compaction: zeroBuckets(),
    compactionCalls: 0,
    requests: 4,
    baseline: 'zero',
    isSeeded: false,
    parentSession: undefined,
    inheritedEventCount: 0,
    at: '2026-10-18T00:00:00.000Z',
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'at', 'baseline', 'compaction', 'compactionCalls', 'inheritedEventCount', 'isSeeded',
    'kind', 'requests', 'seq', 'sessionId', 'turn', 'usage', 'usageTotal', 'v',
  ])
  assert.equal('parentSession' in record, false, 'an absent parent is omitted, not written as undefined')
  for (const key of BUCKET_KEYS) assert.equal(record.usage[key], 0)
  assert.equal(record.requests, 4)
})
