import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildReport,
  collectSessions,
  groupSessions,
  listSessionIds,
  mean,
  parseArgs,
  readLedger,
  renderText,
  summarizeSession,
} from '../scripts/report.js'

const A = 'session-aaaa-1'
const B = 'session-bbbb-2'
const C = 'session-cccc-3'

/**
 * Build a ledger record.
 * @param {number} turn - the turn number.
 * @param {object} usage - the four buckets.
 * @param {object} [extra] - additional fields.
 * @returns {object} the record.
 */
function record(turn, usage, extra = {}) {
  return {
    v: 1,
    kind: 'turn',
    sessionId: 'x',
    seq: turn * 10,
    turn,
    at: '2026-10-18T00:00:00.000Z',
    baseline: 'zero',
    isSeeded: false,
    inheritedEventCount: 0,
    usage,
    usageTotal: usage,
    compaction: {},
    compactionCalls: 0,
    ...extra,
  }
}

test('the last turn carries the cumulative totals', () => {
  const summary = summarizeSession(A, [
    record(1, { uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    record(2, { uncachedInputTokens: 30, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 }),
  ])
  assert.equal(summary.turns, 2)
  assert.equal(summary.totalTokens, 30 + 4 + 5 + 6)
  assert.equal(summary.usage.uncachedInputTokens, 30)
})

test('the same seq written twice is counted once', () => {
  const usage = { uncachedInputTokens: 30, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const summary = summarizeSession(A, [record(1, usage), record(1, usage), record(2, usage)])
  assert.equal(summary.turns, 2)
  assert.equal(summary.duplicates, 1)
})

test('duplicate seq lines with different totals keep the more informative one', () => {
  const good = record(1, { uncachedInputTokens: 30, outputTokens: 4 }, { baseline: 'zero' })
  const unknown = record(1, { uncachedInputTokens: 0, outputTokens: 0 }, { baseline: 'unknown' })
  const summary = summarizeSession(A, [unknown, good])
  assert.equal(summary.baseline, 'zero')
  assert.equal(summary.usage.uncachedInputTokens, 30)
})

test('a record without a seq falls back to the turn number as its key', () => {
  const legacy = record(1, { uncachedInputTokens: 10, outputTokens: 0 })
  delete legacy.seq
  const summary = summarizeSession(A, [legacy, legacy])
  assert.equal(summary.turns, 1)
  assert.equal(summary.duplicates, 1)
})

test('a fork summary reports its baseline and parent', () => {
  const summary = summarizeSession(A, [
    record(1, { uncachedInputTokens: 5, outputTokens: 1 }, {
      baseline: 'fork',
      isSeeded: true,
      parentSession: B,
      inheritedEventCount: 40,
    }),
  ])
  assert.equal(summary.baseline, 'fork')
  assert.equal(summary.isSeeded, true)
  assert.equal(summary.parentSession, B)
})

test('records arriving out of order still fold to the highest turn', () => {
  const summary = summarizeSession(A, [
    record(2, { uncachedInputTokens: 30, outputTokens: 4 }),
    record(1, { uncachedInputTokens: 10, outputTokens: 1 }),
  ])
  assert.equal(summary.usage.uncachedInputTokens, 30)
  assert.equal(summary.turns, 2)
})

test('an empty ledger yields a zeroed summary', () => {
  const summary = summarizeSession(A, [])
  assert.equal(summary.turns, 0)
  assert.equal(summary.totalTokens, 0)
  assert.equal(summary.compactionTokens, 0)
  assert.equal(summary.duplicates, 0)
})

test('groups match by prefix and leave the rest ungrouped', () => {
  const sessions = [{ sessionId: A }, { sessionId: B }, { sessionId: C }]
  const grouped = groupSessions(sessions, [
    { name: 'off', prefix: 'session-aaaa' },
    { name: 'on', prefix: 'session-bbbb' },
  ])
  assert.deepEqual(grouped.get('off').map((s) => s.sessionId), [A])
  assert.deepEqual(grouped.get('on').map((s) => s.sessionId), [B])
  assert.deepEqual(grouped.get('(ungrouped)').map((s) => s.sessionId), [C])
})

test('an unknown baseline lands in its own group, never in a measured one', () => {
  const sessions = [
    { sessionId: A, baseline: 'zero' },
    { sessionId: B, baseline: 'unknown' },
  ]
  const grouped = groupSessions(sessions, [{ name: 'off', prefix: 'session-' }])
  assert.deepEqual(grouped.get('off').map((s) => s.sessionId), [A])
  assert.deepEqual(grouped.get('(baseline unknown)').map((s) => s.sessionId), [B])
})

test('an empty group still appears in the report', () => {
  const report = buildReport([], [{ name: 'off', prefix: 'x' }])
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].sessions, 0)
  assert.equal(report.groups[0].totalTokens, 0)
})

test('means are per group and never divide by zero', () => {
  assert.equal(mean([], 'totalTokens'), 0)
  assert.equal(mean([{ totalTokens: 10 }, { totalTokens: 20 }], 'totalTokens'), 15)
  assert.equal(mean([{ usage: { outputTokens: 4 } }, { usage: { outputTokens: 8 } }], 'usage', 'outputTokens'), 6)
})

test('the text report mentions every group and session', () => {
  const report = buildReport(
    [{ sessionId: A, turns: 1, totalTokens: 10, compactionTokens: 2, usage: {}, compaction: {}, compactionCalls: 0 }],
    [{ name: 'off', prefix: 'session-aaaa' }],
  )
  const text = renderText(report)
  assert.match(text, /off/u)
  assert.match(text, new RegExp(A, 'u'))
  assert.match(text, /total=10/u)
})

test('parseArgs reads home, groups, and json', () => {
  const options = parseArgs(['--home', 'D:/h', '--group', 'off=a,on=b', '--json'])
  assert.equal(options.home, 'D:/h')
  assert.deepEqual(options.groups, [{ name: 'off', prefix: 'a' }, { name: 'on', prefix: 'b' }])
  assert.equal(options.json, true)
})

test('a malformed ledger line is skipped, not fatal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-report-'))
  try {
    const dir = join(home, 'dsh-sol', A)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ledger.jsonl'), `${JSON.stringify(record(1, { uncachedInputTokens: 5, outputTokens: 1 }))}\n{"torn":\n`)
    const records = await readLedger(join(dir, 'ledger.jsonl'))
    assert.equal(records.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unsafe directory name is not treated as a session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-report-'))
  try {
    await mkdir(join(home, 'dsh-sol', 'not a session'), { recursive: true })
    await mkdir(join(home, 'dsh-sol', A), { recursive: true })
    const ids = await listSessionIds(home)
    assert.deepEqual(ids, [A])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a missing plugin directory yields no sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-report-'))
  try {
    assert.deepEqual(await collectSessions(home), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('collectSessions reads every session under the plugin root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-report-'))
  try {
    for (const [id, tokens] of [[A, 10], [B, 20]]) {
      const dir = join(home, 'dsh-sol', id)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'ledger.jsonl'),
        `${JSON.stringify(record(1, { uncachedInputTokens: tokens, outputTokens: 0 }))}\n`,
      )
    }
    const sessions = await collectSessions(home)
    assert.deepEqual(sessions.map((session) => session.sessionId), [A, B])
    assert.deepEqual(sessions.map((session) => session.totalTokens), [10, 20])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
