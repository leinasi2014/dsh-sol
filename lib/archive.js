/**
 * Content-addressed storage for replaced tool output.
 *
 * Objects live at `$DSH_HOME/dsh-sol/<sessionId>/objects/<sha256>.txt`
 * (`report.md` 3.4). The name is the content hash, so writing the same bytes
 * twice is idempotent, and an existing object is verified rather than
 * overwritten — a hash collision or a corrupted file is reported, never
 * silently accepted.
 *
 * Every path is built from a validated session id and a hex digest, so no
 * caller-supplied string ever reaches `join()` unchecked. Symbolic links are
 * refused outright: the archive must not be a way to read or overwrite a file
 * outside the plugin's own directory.
 *
 * @module dsh-sol/archive
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { isValidSessionId, ledgerPath, PLUGIN_DIR_NAME, resolveDshHome } from './ledger.js'

/** Subdirectory holding the archived objects. */
export const OBJECTS_DIR_NAME = 'objects'

/** File extension for one archived object. */
export const OBJECT_EXTENSION = '.txt'

/** Grammar of a content address: 64 lowercase hex characters. */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

/**
 * Hash bytes as lowercase hex sha256.
 * @param {string|Uint8Array} content - the bytes or text to hash.
 * @returns {string} the hex digest.
 */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Whether a string is a well-formed content address.
 * @param {unknown} digest - the candidate.
 * @returns {boolean} true when it is 64 lowercase hex characters.
 */
export function isValidDigest(digest) {
  return typeof digest === 'string' && DIGEST_PATTERN.test(digest)
}

/**
 * The objects directory for one session.
 * @param {string} home - the resolved Harness home.
 * @param {string} sessionId - the session id.
 * @returns {string} the absolute directory.
 * @throws {Error} when the id is not safe as a path segment.
 */
export function objectsDir(home, sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`dsh-sol archive: refusing unsafe session id ${JSON.stringify(sessionId)}`)
  }
  return join(home, PLUGIN_DIR_NAME, sessionId, OBJECTS_DIR_NAME)
}

/**
 * The path of one archived object.
 * @param {string} home - the resolved Harness home.
 * @param {string} sessionId - the session id.
 * @param {string} digest - the content address.
 * @returns {string} the absolute file path.
 * @throws {Error} for an unsafe id or a malformed digest.
 */
export function objectPath(home, sessionId, digest) {
  const dir = objectsDir(home, sessionId)
  if (!isValidDigest(digest)) {
    throw new Error(`dsh-sol archive: refusing malformed digest ${JSON.stringify(digest)}`)
  }
  return join(dir, `${digest}${OBJECT_EXTENSION}`)
}

/**
 * Archive one piece of content and return its address.
 *
 * The write uses `wx` (`O_CREAT | O_EXCL`), so two concurrent writers cannot
 * both create the same object: the loser sees `EEXIST` and verifies the bytes
 * already there instead of clobbering them.
 *
 * @param {object} options - the request.
 * @param {string} options.home - the resolved Harness home.
 * @param {string} options.sessionId - the session id.
 * @param {string|Uint8Array} options.content - the bytes to store.
 * @returns {Promise<{digest: string, path: string, created: boolean, bytes: number}>} the result.
 * @throws {Error} for an unsafe id, a filesystem failure, or a hash mismatch.
 */
export async function archiveContent({ home, sessionId, content }) {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  const digest = sha256(bytes)
  const path = objectPath(home, sessionId, digest)
  const dir = objectsDir(home, sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })

  let handle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(bytes)
    return { digest, path, created: true, bytes: bytes.length }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    // Another writer won the race, or the object is already there. Verify it
    // rather than trusting the name.
    const existing = await readArchived({ home, sessionId, digest })
    if (existing === undefined) {
      throw new Error(`dsh-sol archive: object ${digest} exists but cannot be read back`)
    }
    if (sha256(existing) !== digest) {
      throw new Error(
        `dsh-sol archive: object ${digest} exists but its content does not match its name`,
      )
    }
    return { digest, path, created: false, bytes: bytes.length }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Read one archived object back.
 *
 * A missing object returns `undefined`; anything else (including a symlink at
 * the object's path) throws, so a caller never mistakes an attack for absence.
 *
 * @param {object} options - the request.
 * @param {string} options.home - the resolved Harness home.
 * @param {string} options.sessionId - the session id.
 * @param {string} options.digest - the content address.
 * @returns {Promise<Buffer|undefined>} the bytes, or undefined when absent.
 * @throws {Error} for an unsafe id, a malformed digest, or a symlink.
 */
export async function readArchived({ home, sessionId, digest }) {
  const path = objectPath(home, sessionId, digest)
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`dsh-sol archive: refusing to follow a symbolic link at ${digest}`)
  }
  if (!stat.isFile()) {
    throw new Error(`dsh-sol archive: ${digest} is not a regular file`)
  }
  return readFile(path)
}

/**
 * Find the archive key an observation id was recorded under.
 *
 * The mapping lives in the session's ledger, not in a side file: every
 * replacement writes a `kind: "observation"` line carrying both the id and the
 * archive key (`report.md` 3.4). A side index would need a read-modify-write
 * that can drop an entry when two replacements finish together, and a
 * half-written file would read as empty and lose the evidence — the ledger is
 * append-only, so neither can happen.
 *
 * Lines are scanned from the end so the newest record wins, and a torn or
 * unparsable line is skipped rather than failing the lookup: a crash can leave
 * a partial last line, and that must not hide every earlier object.
 *
 * @param {object} options - the request.
 * @param {string} options.home - the resolved Harness home.
 * @param {string} options.sessionId - the session id.
 * @param {string} options.id - the observation id.
 * @returns {Promise<string|undefined>} the archive key, or undefined when unknown.
 */
export async function findArchiveKeyForObservation({ home, sessionId, id }) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  let text
  try {
    text = await readFile(ledgerPath(home, sessionId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.id !== id) continue
    if (record.kind !== 'observation') continue
    if (isValidDigest(record.archiveKey)) return record.archiveKey
  }
  return undefined
}

/**
 * Build an archiver bound to one home and one session.
 *
 * The bound form is what the mechanisms use: it captures the resolved home once
 * and refuses a session id it cannot safely address.
 *
 * @param {object} options - the binding.
 * @param {string} options.home - an explicit home override, or undefined for the default.
 * @param {string} options.sessionId - the session id.
 * @returns {object} the archiver.
 */
export function createArchiver({ home, sessionId }) {
  const resolvedHome = resolveDshHome(home)
  return {
    /**
     * Archive content and return its address.
     * @param {string|Uint8Array} content - the bytes.
     * @returns {Promise<{digest: string, path: string, created: boolean, bytes: number}>} the result.
     */
    put: (content) => archiveContent({ home: resolvedHome, sessionId, content }),
    /**
     * Read the object at an address.
     * @param {string} digest - the address.
     * @returns {Promise<Buffer|undefined>} the bytes.
     */
    get: (digest) => readArchived({ home: resolvedHome, sessionId, digest }),
    /**
     * The address of some content, without storing it.
     * @param {string|Uint8Array} content - the bytes.
     * @returns {string} the hex digest.
     */
    digestOf: (content) => sha256(content),
    /**
     * The path of an object.
     * @param {string} digest - the address.
     * @returns {string} the absolute path.
     */
    pathOf: (digest) => objectPath(resolvedHome, sessionId, digest),
    /**
     * Archive content for one observation.
     *
     * Only the bytes are stored: the id → key mapping is written by the caller
     * as a ledger line **before** the placeholder is returned, so a replacement
     * the model can see always has a ledger record behind it
     * (`report.md` 3.4). The store stays content-addressed, so identical bytes
     * seen in two calls are written once and get two ids.
     *
     * @param {string|Uint8Array} content - the bytes.
     * @returns {Promise<{digest: string, path: string, created: boolean, bytes: number}>} the store result.
     */
    putObservation(content) {
      return archiveContent({ home: resolvedHome, sessionId, content })
    },
    /**
     * Read the bytes an observation id names.
     * @param {string} id - the observation id.
     * @returns {Promise<Buffer|undefined>} the bytes, or undefined when unknown.
     */
    async getByObservation(id) {
      const digest = await findArchiveKeyForObservation({ home: resolvedHome, sessionId, id })
      if (digest === undefined) return undefined
      return readArchived({ home: resolvedHome, sessionId, digest })
    },
    /**
     * The content address an observation id names, when known.
     * @param {string} id - the observation id.
     * @returns {Promise<string|undefined>} the digest.
     */
    digestOfObservation(id) {
      return findArchiveKeyForObservation({ home: resolvedHome, sessionId, id })
    },
  }
}
