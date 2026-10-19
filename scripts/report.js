#!/usr/bin/env node
/**
 * Offline A/B report over the measurement ledger.
 *
 * Reads every `<home>/dsh-sol/<sessionId>/ledger.jsonl` and prints one summary
 * per group plus a per-session table, so an A/B run can be compared without
 * loading the Harness (`report.md` 3.6).
 *
 * Usage:
 *   node scripts/report.js [--home <dir>] [--group <name>=<sessionIdPrefix>,...] [--json]
 *
 * The last turn's cumulative totals are the session total, because the ledger
 * records cumulative buckets per turn (`lib/meter.js`).
 *
 * @module dsh-sol/scripts/report
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidSessionId, PLUGIN_DIR_NAME, resolveDshHome } from '../lib/ledger.js'
import { BUCKET_KEYS } from '../lib/meter.js'

/**
 * Parse `--key value` pairs.
 * @param {string[]} argv - process arguments after the script name.
 * @returns {{home: string|undefined, groups: Array<{name: string, prefix: string}>, json: boolean}} the options.
 */
export function parseArgs(argv) {
  const options = { home: undefined, groups: [], json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--home') {
      options.home = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--group') {
      const value = argv[index + 1] ?? ''
      index += 1
      for (const entry of value.split(',')) {
        const [name, prefix] = entry.split('=')
        if (name && prefix) options.groups.push({ name, prefix })
      }
    }
  }
  return options
}

/**
 * Read and parse one ledger file.
 * @param {string} file - the absolute path.
 * @returns {Promise<object[]>} the parsed records, skipping malformed lines.
 */
export async function readLedger(file) {
  const text = await readFile(file, 'utf8')
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn final line from a crash is not a reason to fail the report.
    }
  }
  return records
}

/**
 * Fold one session's records into its final cumulative totals.
 *
 * Lines are deduplicated by `seq` — the `turn/end` sequence number — because
 * the same committed event can be observed by more than one plugin instance
 * when the row is inserted per agent preset, and a replayed turn must not be
 * counted twice. Records written before the seq field existed fall back to the
 * turn number as the key.
 *
 * @param {string} sessionId - the session id.
 * @param {object[]} records - the session's ledger records.
 * @returns {object} the session summary.
 */
export function summarizeSession(sessionId, records) {
  const byKey = new Map()
  for (const record of records) {
    if (record?.kind !== 'turn' || typeof record.turn !== 'number') continue
    const key = typeof record.seq === 'number' ? `seq:${record.seq}` : `turn:${record.turn}`
    const existing = byKey.get(key)
    // A duplicate is kept once; prefer the line that carries more information.
    if (existing === undefined || (existing.baseline === 'unknown' && record.baseline !== 'unknown')) {
      byKey.set(key, record)
    }
  }
  const turns = [...byKey.values()].sort((left, right) => left.turn - right.turn)
  const last = turns.at(-1)
  const usage = last?.usage ?? {}
  const compaction = last?.compaction ?? {}
  const summary = {
    sessionId,
    turns: turns.length,
    duplicates: records.filter((record) => record?.kind === 'turn').length - turns.length,
    usage: {},
    compaction: {},
    compactionCalls: last?.compactionCalls ?? 0,
    requests: last?.requests ?? 0,
    baseline: last?.baseline ?? 'zero',
    isSeeded: last?.isSeeded === true,
  }
  if (typeof last?.parentSession === 'string') summary.parentSession = last.parentSession
  for (const key of BUCKET_KEYS) {
    summary.usage[key] = usage[key] ?? 0
    summary.compaction[key] = compaction[key] ?? 0
  }
  summary.totalTokens = BUCKET_KEYS.reduce((sum, key) => sum + summary.usage[key], 0)
  summary.compactionTokens = BUCKET_KEYS.reduce((sum, key) => sum + summary.compaction[key], 0)
  return summary
}

/**
 * Group sessions by an id prefix, with an ungrouped bucket for the rest.
 * Sessions whose baseline could not be established are collected separately,
 * because their totals include a parent prefix this plugin never measured.
 * @param {object[]} sessions - the session summaries.
 * @param {Array<{name: string, prefix: string}>} groups - the declared groups.
 * @returns {Map<string, object[]>} group name to its sessions.
 */
export function groupSessions(sessions, groups) {
  const grouped = new Map()
  for (const group of groups) grouped.set(group.name, [])
  const rest = []
  const unknown = []
  for (const session of sessions) {
    if (session.baseline === 'unknown') {
      unknown.push(session)
      continue
    }
    const match = groups.find((group) => session.sessionId.startsWith(group.prefix))
    if (match) grouped.get(match.name).push(session)
    else rest.push(session)
  }
  if (rest.length > 0) grouped.set('(ungrouped)', rest)
  if (unknown.length > 0) grouped.set('(baseline unknown)', unknown)
  return grouped
}

/**
 * Average one bucket across sessions.
 * @param {object[]} sessions - the sessions in the group.
 * @param {string} field - `usage`, `compaction`, or a scalar field name.
 * @param {string} [bucket] - the bucket inside `usage`/`compaction`.
 * @returns {number} the mean, or 0 for an empty group.
 */
export function mean(sessions, field, bucket) {
  if (sessions.length === 0) return 0
  const sum = sessions.reduce((total, session) => {
    const value = bucket === undefined ? session[field] : session[field]?.[bucket]
    return total + (typeof value === 'number' ? value : 0)
  }, 0)
  return sum / sessions.length
}

/**
 * Build the whole report.
 * @param {object[]} sessions - the session summaries.
 * @param {Array<{name: string, prefix: string}>} groups - the declared groups.
 * @returns {object} the report.
 */
export function buildReport(sessions, groups) {
  const grouped = groupSessions(sessions, groups)
  const groupRows = []
  for (const [name, members] of grouped) {
    groupRows.push({
      name,
      sessions: members.length,
      turnsPerSession: mean(members, 'turns'),
      requests: mean(members, 'requests'),
      totalTokens: mean(members, 'totalTokens'),
      compactionTokens: mean(members, 'compactionTokens'),
      duplicates: members.reduce((sum, session) => sum + (session.duplicates ?? 0), 0),
      uncachedInputTokens: mean(members, 'usage', 'uncachedInputTokens'),
      cacheReadTokens: mean(members, 'usage', 'cacheReadTokens'),
      cacheWriteTokens: mean(members, 'usage', 'cacheWriteTokens'),
      outputTokens: mean(members, 'usage', 'outputTokens'),
    })
  }
  const duplicates = sessions.reduce((sum, session) => sum + (session.duplicates ?? 0), 0)
  return { groups: groupRows, sessions, duplicates }
}

/**
 * Format a number with thousands separators.
 * @param {number} value - the number.
 * @returns {string} the formatted number.
 */
function num(value) {
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Render the report as plain text.
 *
 * Every group figure is a per-session mean, not a total: a session that ran
 * twice as long must not outweigh two short ones. The header says so, and the
 * per-session block below carries the raw counts.
 *
 * @param {object} report - the report from {@link buildReport}.
 * @returns {string} the text.
 */
export function renderText(report) {
  const lines = []
  lines.push('per-session means (not totals):')
  lines.push('group          sessions  reqs  turns  total      compaction  uncachedIn  cacheRead  cacheWrite  output')
  for (const row of report.groups) {
    lines.push(
      `${row.name.padEnd(14)} ${String(row.sessions).padStart(8)}  ${String(Math.round(row.requests)).padStart(4)}  `
      + `${String(Math.round(row.turnsPerSession)).padStart(5)}  ${num(row.totalTokens).padStart(9)}  `
      + `${num(row.compactionTokens).padStart(10)}  `
      + `${num(row.uncachedInputTokens).padStart(10)}  ${num(row.cacheReadTokens).padStart(9)}  `
      + `${num(row.cacheWriteTokens).padStart(10)}  ${num(row.outputTokens).padStart(6)}`,
    )
  }
  if (report.sessions.length > 0) {
    lines.push('')
    lines.push('per session:')
    for (const session of report.sessions) {
      const flags = []
      if (session.isSeeded) flags.push(`forked${session.parentSession ? ` from ${session.parentSession}` : ''}`)
      if (session.baseline === 'unknown') flags.push('baseline unknown: includes an unmeasured parent prefix')
      if (session.duplicates > 0) flags.push(`${session.duplicates} duplicate line(s) ignored`)
      const suffix = flags.length > 0 ? `  [${flags.join('; ')}]` : ''
      lines.push(
        `  ${session.sessionId}  turns=${session.turns}  requests=${session.requests}  `
        + `total=${num(session.totalTokens)}  compaction=${num(session.compactionTokens)}${suffix}`,
      )
    }
  }
  if (report.duplicates > 0) {
    lines.push('')
    lines.push(`note: ${report.duplicates} duplicate ledger line(s) were counted once, by (sessionId, seq).`)
  }
  lines.push('')
  lines.push('note: "reqs" counts assistant/message events, i.e. requests that produced a reply.')
  lines.push('      A failed attempt that was retried logs assistant/attempt instead and is not counted,')
  lines.push('      while its token spend may still be in "total" — so total/reqs overstates cost per reply.')
  return `${lines.join('\n')}\n`
}

/**
 * List every session directory under the plugin root.
 * @param {string} home - the resolved Harness home.
 * @returns {Promise<string[]>} the session ids, sorted.
 */
export async function listSessionIds(home) {
  const root = join(home, PLUGIN_DIR_NAME)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Read every ledger under the plugin root.
 * @param {string} home - the resolved Harness home.
 * @returns {Promise<object[]>} the session summaries.
 */
export async function collectSessions(home) {
  const ids = await listSessionIds(home)
  const sessions = []
  for (const sessionId of ids) {
    let records
    try {
      records = await readLedger(join(home, PLUGIN_DIR_NAME, sessionId, 'ledger.jsonl'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (records.length === 0) continue
    sessions.push(summarizeSession(sessionId, records))
  }
  return sessions
}

/* c8 ignore start -- CLI entry */
const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href

if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const home = resolveDshHome(options.home)
  const sessions = await collectSessions(home)
  const report = buildReport(sessions, options.groups)
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report))
}
/* c8 ignore stop */
