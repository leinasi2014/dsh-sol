/**
 * QA probes for step 1 (骨架 + 计量). These do not modify the delivered
 * sources; they pin behaviour the delivery notes claim, using session shapes
 * the real DSH constructor actually produces.
 *
 * Step 1 was reworked on 2026-10-18 after the first review; the three probes
 * that pinned the old bugs are now inverted to assert the fixed behaviour.
 *
 * @module dsh-sol/test/qa-step1
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SHELLS, RESERVED_KEYS, resolveConfig } from '../lib/config.js'
import { isFreshFork, mountMeter } from '../lib/meter.js'
import {
  assistantMessage,
  compactionSummary,
  createFakeCtx,
  fakeForkSession,
  fakeRestoredForkSession,
  fakeSession,
  tokenUsageState,
  turnEnd,
} from './fake-ctx.js'

const CHILD_ID = 'session-qa-child-0001'
const PARENT_ID = 'session-qa-parent-0001'
const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

/**
 * Fill a partial bucket set.
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
 * Mount the meter with a projection whose totals the test can advance.
 * @param {object} session - the session to drive.
 * @param {object} totals - initial totals.
 * @param {boolean} [announce] - fire `session/created` first.
 * @returns {object} the harness.
 */
function harness(session, totals, announce = true) {
  const live = buckets(totals)
  const fake = createFakeCtx()
  const readProjection = fake.ctx.sessionProjections.stateOf.bind(fake.ctx.sessionProjections)
  fake.ctx.sessionProjections.stateOf = (session, key) => key === 'tokenUsage'
    ? tokenUsageState(live) : readProjection(session, key)
  const records = []
  mountMeter(fake.ctx, { enabled: true, home: 'C:/qa-home', append: (entry) => records.push(entry) })
  if (announce) fake.emit('session/created', session)
  return { ...fake, records, live }
}

// ---------------------------------------------------------------------------
// 1. fork baseline: the fixed behaviour, on both real session shapes
// ---------------------------------------------------------------------------

test('QA: a fresh fork captures a baseline and records only its own share', () => {
  // Real fork shape: firstLifecycleSeq === inheritedEventCount < firstLiveSeq === seq
  // (`asar:dsh-session/lib/index.js:1426`, `:927-936`, `:2014`).
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID, boundary: 39, closers: 2 })
  // inheritedEventCount = boundary + 1 = 40; the seed then carries the inherited
  // marker plus two open-turn closers, so the log length is 40 + 1 + 2 = 43.
  assert.equal(child.inheritedEventCount, 40)
  assert.equal(child.firstLifecycleSeq, 40)
  assert.equal(child.firstLiveSeq, 43)
  assert.equal(child.seq, 43)
  assert.equal(isFreshFork(child), true)

  const h = harness(child, { uncachedInputTokens: 1000, outputTokens: 100 })
  h.live.uncachedInputTokens = 1050
  h.live.outputTokens = 110
  h.emit('session/event', child, turnEnd(1, 50))
  const record = h.records[0].record
  assert.equal(record.baseline, 'fork', 'a fresh fork has an exact baseline')
  assert.equal(record.isSeeded, true)
  assert.equal(record.parentSession, PARENT_ID)
  assert.equal(record.inheritedEventCount, 40)
  assert.equal(record.usage.uncachedInputTokens, 50, 'only the child turns are billed to the child')
  assert.equal(record.usage.outputTokens, 10)
  assert.equal(record.usageTotal.uncachedInputTokens, 1050, 'the raw cumulative number is kept for auditing')
})

test('QA: a restored fork is unknown, never zero and never fork', () => {
  // The restore path seeds the constructor with the whole stored log, so
  // firstLifecycleSeq === firstLiveSeq and the fork signature does not hold.
  // Its projection holds the parent prefix AND the child's own pre-restart
  // history, so subtracting it would silently drop every earlier token.
  const restored = fakeRestoredForkSession(CHILD_ID, {
    parentSession: PARENT_ID, inheritedEventCount: 40, length: 300,
  })
  assert.equal(restored.firstLifecycleSeq, restored.firstLiveSeq)
  assert.equal(isFreshFork(restored), false)

  const h = harness(restored, { uncachedInputTokens: 9000, outputTokens: 900 })
  h.emit('session/event', restored, turnEnd(1, 310))
  const record = h.records[0].record
  assert.equal(record.baseline, 'unknown')
  assert.equal(record.isSeeded, true)
  assert.deepEqual(record.usage, buckets(), 'without an exact baseline, no delta is claimed')
  assert.equal(record.usageTotal.uncachedInputTokens, 9000)
})

test('QA: a seeded session never announced is unknown', () => {
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID })
  const h = harness(child, { uncachedInputTokens: 1000 }, false)
  h.emit('session/event', child, turnEnd(1, 50))
  const record = h.records[0].record
  assert.equal(record.baseline, 'unknown')
  assert.deepEqual(record.usage, buckets())
})

test('QA: an unseeded session is always zero-baselined, new or restored', () => {
  const fresh = fakeSession(GOOD_ID)
  assert.equal(isFreshFork(fresh), false, 'unseeded is not a fork')
  const h1 = harness(fresh, { uncachedInputTokens: 7 })
  h1.emit('session/event', fresh, turnEnd(1, 10))
  assert.equal(h1.records[0].record.baseline, 'zero')
  assert.equal(h1.records[0].record.usage.uncachedInputTokens, 7)

  const restored = fakeSession(GOOD_ID, { seq: 300 })
  const h2 = harness(restored, { uncachedInputTokens: 42 })
  h2.emit('session/event', restored, turnEnd(1, 310))
  assert.equal(h2.records[0].record.baseline, 'zero', 'a restored unseeded log is all its own')
  assert.equal(h2.records[0].record.usage.uncachedInputTokens, 42)
})

test('QA: isFreshFork refuses sessions missing the two public fields', () => {
  assert.equal(isFreshFork({ id: 'x' }), false)
  assert.equal(isFreshFork({ id: 'x', header: { isSeeded: true } }), false)
  assert.equal(isFreshFork({
    id: 'x', header: { isSeeded: true }, inheritedEventCount: 5, firstLiveSeq: 7,
  }), false, 'a missing firstLifecycleSeq cannot prove the fork signature')
  assert.equal(isFreshFork({
    id: 'x', header: { isSeeded: false }, inheritedEventCount: 0, firstLifecycleSeq: 0, firstLiveSeq: 0,
  }), false, 'unseeded is never a fork')
})

// ---------------------------------------------------------------------------
// 2. requests
// ---------------------------------------------------------------------------

test('QA: requests counts assistant/message only, and only the session own events', () => {
  const child = fakeForkSession(CHILD_ID, { parentSession: PARENT_ID, boundary: 39, closers: 2 })
  const h = harness(child, { uncachedInputTokens: 100 })
  // Inside the inherited prefix: the parent's requests, not the child's.
  h.emit('session/event', child, assistantMessage(10, 1))
  h.emit('session/event', child, assistantMessage(20, 1))
  // Own events.
  h.emit('session/event', child, assistantMessage(45, 1))
  h.emit('session/event', child, assistantMessage(46, 1))
  // A failed attempt is not a completed request.
  h.emit('session/event', child, { type: 'assistant/attempt', seq: 47, data: { turn: 1, step: 0 } })
  h.emit('session/event', child, turnEnd(1, 50))
  assert.equal(h.records[0].record.requests, 2)
})

test('QA: a retried request contributes exactly one request', () => {
  const session = fakeSession(GOOD_ID)
  const h = harness(session, { uncachedInputTokens: 10 })
  // The failed attempt settles as assistant/attempt, then the retry succeeds.
  h.emit('session/event', session, { type: 'assistant/attempt', seq: 1, data: { turn: 1, step: 0 } })
  h.emit('session/event', session, { type: 'llm/retry-started', seq: 2, data: { turn: 1, step: 0 } })
  h.emit('session/event', session, assistantMessage(3, 1))
  h.emit('session/event', session, turnEnd(1, 4))
  assert.equal(h.records[0].record.requests, 1, 'the failed attempt is not a completed request')
})

test('QA: requests accumulates across turns and resets with the session', () => {
  const session = fakeSession(GOOD_ID)
  const h = harness(session, { uncachedInputTokens: 1 })
  h.emit('session/event', session, assistantMessage(1, 1))
  h.emit('session/event', session, turnEnd(1, 2))
  h.emit('session/event', session, assistantMessage(3, 2))
  h.emit('session/event', session, assistantMessage(4, 2))
  h.emit('session/event', session, turnEnd(2, 5))
  assert.deepEqual(h.records.map((entry) => entry.record.requests), [1, 3])
  h.emit('session/disposed', session)
  const again = harness(session, { uncachedInputTokens: 1 })
  again.emit('session/event', session, turnEnd(3, 6))
  assert.equal(again.records[0].record.requests, 0, 'a fresh state starts from zero')
})

// ---------------------------------------------------------------------------
// 3. config: reserved keys, defaults, and the all-off row
// ---------------------------------------------------------------------------

test('QA: every documented mechanism is mounted, so no key is reserved any more', () => {
  // Steps 1-5 are all wired: a reserved key would mean a documented switch
  // nobody reads, which is exactly what the refusal was there to prevent.
  assert.deepEqual([...RESERVED_KEYS], [], 'all five mechanisms are mounted')
  for (const key of ['meter', 'actionFusion', 'observationPack', 'reducer', 'occ']) {
    assert.doesNotThrow(
      () => resolveConfig({ [key]: { enabled: false } }),
      `${key} must be an accepted section`,
    )
  }
  // A genuine typo still says "unknown".
  assert.throws(() => resolveConfig({ metar: { enabled: true } }), /unknown key/u)
  // A mounted section and a typo in one object only complain about the typo.
  assert.throws(
    () => resolveConfig({ occ: {}, metar: {} }),
    /unknown key/u,
  )
  assert.doesNotThrow(() => resolveConfig({ occ: {}, reducer: {}, observationPack: {} }))
})

test('QA: the meter section still rejects keys it does not read', () => {
  assert.throws(() => resolveConfig({ meter: { enabled: true, thresholdBytes: 10240 } }), /unknown key/u)
  assert.throws(() => resolveConfig({ meter: { enabled: 'yes' } }), /must be a boolean/u)
  // Assert the meter section alone: other mechanisms mount over time, so the
  // whole resolved object is not a stable shape (step 2 added `actionFusion`).
  assert.deepEqual(resolveConfig({}).meter, { enabled: false, home: undefined })
})

test('QA: DEFAULT_SHELLS keeps ops_bash first and bash last', () => {
  assert.deepEqual([...DEFAULT_SHELLS], ['ops_bash', 'pwsh', 'bash'])
  // The list is the only place a shell is named; it is frozen so a mechanism
  // cannot mutate the shared default.
  assert.equal(Object.isFrozen(DEFAULT_SHELLS), true)
})

// ---------------------------------------------------------------------------
// 4. manifest and display resources
// ---------------------------------------------------------------------------

test('QA: the manifest declares the format version, the bundle, and the engine range', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh?.manifestVersion, 1, 'report.md 3.2 requires dsh.manifestVersion:1')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.engines?.dsh, '>=0.2.1-rc.2 <0.3.0')
  assert.equal(manifest.private, true)
})

test('QA: exports and files both cover every shipped resource', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  for (const entry of ['index.js', 'lib', 'scripts', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `files must list ${entry}`)
  }
})

test('QA: both locales carry a human title and a description that is not the package name', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const locale of ['en', 'zh']) {
    const text = await readFile(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    assert.equal(typeof parsed.meta?.title, 'string')
    assert.equal(typeof parsed.meta?.description, 'string')
    assert.notEqual(parsed.meta.title, 'dsh-sol', `${locale} title must not be the package name`)
    assert.ok(parsed.meta.title.length > 0)
    assert.ok(parsed.meta.description.length > 10, `${locale} description must say what it does`)
  }
})

test('QA: the icon is an in-package SVG under the size limit', async () => {
  const { readFile } = await import('node:fs/promises')
  const svg = await readFile(new URL('../icon.svg', import.meta.url), 'utf8')
  assert.ok(svg.includes('<svg'), 'must be an SVG')
  assert.ok(/viewBox=/.test(svg), 'must be scalable')
  assert.ok(Buffer.byteLength(svg) <= 256 * 1024, 'the host caps icons at 256 KiB')
  assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, '')), 'no external references')
})

// ---------------------------------------------------------------------------
// 5. the report script
// ---------------------------------------------------------------------------

test('QA: the report labels the turns column as a per-session average', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../scripts/report.js', import.meta.url), 'utf8')
  assert.ok(/turnsPerSession/.test(source), 'the summary field must say it is per session')
  assert.ok(!/turns:\s*mean\(/u.test(source), 'a bare `turns` mean reads like a total')
})

test('QA: usage and requests use different denominators, and the report says so', async () => {
  // step2-facts.md:326-330 — `requests` counts only attempts that produced a
  // reply, while `usage` may also carry a failed attempt's tokens. So
  // usage/requests is an upper bound when retries are frequent. The report must
  // not present it as an absolute per-request cost.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../scripts/report.js', import.meta.url), 'utf8')
  assert.ok(
    /assistant\/message/.test(source),
    'the report must state which events `requests` counts',
  )
  assert.ok(
    /reqs|requests/u.test(source),
    'the column must be labelled',
  )
})
