/**
 * The append-only measurement ledger.
 *
 * One JSON object per line under `$DSH_HOME/dsh-sol/<sessionId>/ledger.jsonl`
 * (`report.md` 3.4). The session id is validated against a strict pattern
 * before it is ever joined into a path, so a hostile or malformed id can never
 * escape the plugin directory (`report.md` 3.4, `notes/solpi.md`).
 *
 * `$DSH_HOME` resolution mirrors `@deepseek-ai/dsh-home-paths` without
 * importing it: explicit override, then `$DSH_HOME` when non-blank, then
 * `~/.dsh` (`asar:dsh-home-paths/lib/index.js` resolveDshHome/resolveRoot).
 *
 * @module dsh-sol/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory this plugin owns under the Harness home. */
export const PLUGIN_DIR_NAME = 'dsh-sol'

/** Ledger file name inside a session directory. */
export const LEDGER_FILE_NAME = 'ledger.jsonl'

/**
 * Grammar of an acceptable session id: a leading and trailing alphanumeric,
 * then letters, digits, dot, underscore, or hyphen in between, at most 128
 * characters. Rejects separators, `..`, absolute paths, drive letters, empty
 * strings, and a trailing dot — Windows strips trailing dots from a directory
 * name, so `a.` and `a` would otherwise share one directory. Real ids look
 * like `session-1bc7e121-212d-463c-ba02-53fb7b5169f3`
 * (`asar:dsh-agent-loop/lib/index.js` `brandString(\`${id}-session-${randomUUID()}\`)`).
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u

/**
 * Windows device names that name a device in every directory, so a directory
 * with one of these names cannot be created.
 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * Whether an id is safe to use as a single path segment.
 * @param {unknown} id - the candidate id.
 * @returns {boolean} true when the id matches the grammar and is not a device name.
 */
export function isValidSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return false
  const stem = id.split('.')[0].toUpperCase()
  return !WINDOWS_RESERVED.has(stem)
}

/**
 * Expand the tilde prefixes the Harness accepts.
 * @param {string} path - a configured path.
 * @returns {string} the expanded path.
 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the Harness home.
 * @param {string|undefined} configured - explicit override from the row config.
 * @param {Record<string, string|undefined>} env - environment to read.
 * @returns {string} the absolute Harness home.
 */
export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandHome(configured))
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(expandHome(fromEnv))
  return join(homedir(), '.dsh')
}

/**
 * The directory holding one session's plugin data.
 * @param {string} home - the resolved Harness home.
 * @param {string} sessionId - the session id.
 * @returns {string} the absolute directory.
 * @throws {Error} when the id is not safe as a path segment.
 */
export function sessionDir(home, sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`dsh-sol ledger: refusing unsafe session id ${JSON.stringify(sessionId)}`)
  }
  return join(home, PLUGIN_DIR_NAME, sessionId)
}

/**
 * The ledger file path for one session.
 * @param {string} home - the resolved Harness home.
 * @param {string} sessionId - the session id.
 * @returns {string} the absolute file path.
 */
export function ledgerPath(home, sessionId) {
  return join(sessionDir(home, sessionId), LEDGER_FILE_NAME)
}

/**
 * Append one record as a JSON line, creating the session directory first.
 *
 * Directory and file modes only bind on Unix; on Windows the user profile ACL
 * is what protects `$DSH_HOME` (`report.md` 3.4).
 *
 * @param {object} options - the write request.
 * @param {string} options.home - the resolved Harness home.
 * @param {string} options.sessionId - the session id.
 * @param {Record<string, unknown>} options.record - the record to append.
 * @returns {Promise<void>} settles when the line is written.
 * @throws {Error} for an unsafe session id or a filesystem failure.
 */
export async function appendLedgerRecord({ home, sessionId, record }) {
  const dir = sessionDir(home, sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await appendFile(join(dir, LEDGER_FILE_NAME), `${JSON.stringify(record)}\n`, { mode: 0o600 })
}
