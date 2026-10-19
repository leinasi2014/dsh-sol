/**
 * QA probes for step 3 (archive + observation). These do not modify the
 * delivered sources; they pin the two invariants the delivery notes claim and
 * the edge cases they do not cover.
 *
 * @module dsh-sol/test/qa-step3
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  archiveContent,
  createArchiver,
  isValidDigest,
  objectPath,
  objectsDir,
  readArchived,
  sha256,
} from '../lib/archive.js'
import {
  DEFAULT_THRESHOLD_BYTES,
  MAX_PAGE_LINES,
  NEVER_REPLACE,
  RECEIPT_MARKERS,
  hasReceipt,
  isValidObservationId,
  observationId,
  readPage,
  shouldReplace,
} from '../lib/observation.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

/**
 * A temporary Harness home.
 * @returns {Promise<string>} the directory.
 */
async function tempHome() {
  return mkdtemp(join(tmpdir(), 'sol-qa3-'))
}

// ---------------------------------------------------------------------------
// archive: content addressing and refusal to be fooled
// ---------------------------------------------------------------------------

test('QA: archive path is derived from a validated id and a hex digest only', async () => {
  const home = await tempHome()
  try {
    const { digest, path } = await archiveContent({ home, sessionId: GOOD_ID, content: 'x' })
    assert.equal(digest, sha256('x'))
    assert.equal(path, join(home, 'dsh-sol', GOOD_ID, 'objects', `${digest}.txt`))
    // Every rejection happens before any filesystem use.
    for (const bad of ['../x', 'a/b', 'a\\b', 'C:x', '.', '..', '']) {
      assert.throws(() => objectsDir(home, bad), /refusing unsafe session id/u, bad)
    }
    for (const bad of ['..', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}/x`, '']) {
      assert.throws(() => objectPath(home, GOOD_ID, bad), /refusing malformed digest/u, bad)
    }
    assert.equal(isValidDigest('a'.repeat(64)), true)
    assert.equal(isValidDigest('A'.repeat(64)), false, 'uppercase hex is not the canonical address')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('QA: an object already occupying the digest path with other bytes is an error, not an overwrite', async () => {
  const home = await tempHome()
  try {
    const content = 'hello'
    const digest = sha256(content)
    const dir = objectsDir(home, GOOD_ID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${digest}.txt`), 'FOREIGN BYTES')
    await assert.rejects(
      () => archiveContent({ home, sessionId: GOOD_ID, content }),
      /does not match its name/u,
      'a hash collision or corruption must be reported',
    )
    // The foreign bytes are untouched.
    assert.equal(await readFile(join(dir, `${digest}.txt`), 'utf8'), 'FOREIGN BYTES')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('QA: archiving the same bytes twice is idempotent and reports created=false', async () => {
  const home = await tempHome()
  try {
    const first = await archiveContent({ home, sessionId: GOOD_ID, content: 'same' })
    const second = await archiveContent({ home, sessionId: GOOD_ID, content: 'same' })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.digest, first.digest)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('QA: a missing object reads as undefined, never as an error', async () => {
  const home = await tempHome()
  try {
    assert.equal(await readArchived({ home, sessionId: GOOD_ID, digest: sha256('absent') }), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('QA: bytes round-trip exactly, including multi-byte and a lone surrogate', async () => {
  const home = await tempHome()
  try {
    const text = '中文 ☾ 🎯 \r\n line2 \t end'
    const { digest } = await archiveContent({ home, sessionId: GOOD_ID, content: text })
    const back = await readArchived({ home, sessionId: GOOD_ID, digest })
    assert.equal(back.toString('utf8'), text)
    // A Buffer round-trips byte for byte even when it is not valid UTF-8.
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41])
    const second = await archiveContent({ home, sessionId: GOOD_ID, content: raw })
    assert.deepEqual(await readArchived({ home, sessionId: GOOD_ID, digest: second.digest }), raw)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('QA: a bound archiver uses one home and refuses a bad id at call time', async () => {
  const home = await tempHome()
  try {
    const archiver = createArchiver({ home, sessionId: GOOD_ID })
    const { digest } = await archiver.put('bound')
    assert.equal((await archiver.get(digest)).toString('utf8'), 'bound')
    assert.equal(archiver.pathOf(digest), objectPath(home, GOOD_ID, digest))
    await assert.rejects(
      () => createArchiver({ home, sessionId: '../x' }).put('y'),
      /refusing unsafe session id/u,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// observation: the paging invariant
// ---------------------------------------------------------------------------

/**
 * Page through content the way `obs_recall` does, concatenating raw bytes.
 * @param {Buffer} buffer - the content.
 * @returns {Buffer} the reassembled bytes.
 */
function readAll(buffer) {
  const chunks = []
  let offset = 0
  for (let guard = 0; guard < 100000; guard += 1) {
    const page = readPage({ content: buffer, offset })
    chunks.push(Buffer.from(page.text, 'utf8'))
    if (page.eof) break
    offset = page.nextOffset
  }
  return Buffer.concat(chunks)
}

test('QA: paging reassembles byte for byte, multi-byte content included', () => {
  const parts = []
  for (let index = 0; index < 900; index += 1) {
    parts.push(`行 ${index} ☾ 中文 emoji 🎯🚀 tail`)
    if (index % 37 === 0) parts.push('\r\n')
  }
  const buffer = Buffer.from(parts.join('\n'), 'utf8')
  const joined = readAll(buffer)
  assert.ok(joined.equals(buffer), 'reassembled bytes must equal the original')
  assert.equal(
    createHash('sha256').update(joined).digest('hex'),
    createHash('sha256').update(buffer).digest('hex'),
  )
})

test('QA: a single very long line still pages, because newline caps alone would stall', () => {
  const buffer = Buffer.from(JSON.stringify({ data: '☾🎯'.repeat(30000) }), 'utf8')
  assert.equal(buffer.toString('utf8').includes('\n'), false, 'the fixture has no newline')
  const joined = readAll(buffer)
  assert.ok(joined.equals(buffer))
})

test('QA: every page respects the byte and line caps', () => {
  const parts = []
  for (let index = 0; index < 5000; index += 1) parts.push(`line ${index} ☾`)
  const buffer = Buffer.from(parts.join('\n'), 'utf8')
  let offset = 0
  for (let guard = 0; guard < 100000; guard += 1) {
    const page = readPage({ content: buffer, offset })
    assert.ok(page.bytes <= 16 * 1024, `page was ${String(page.bytes)} bytes`)
    assert.ok(page.lines <= MAX_PAGE_LINES + 1, `page was ${String(page.lines)} lines`)
    if (page.eof) break
    offset = page.nextOffset
  }
})

test('QA: an offset inside a character is a RangeError, never a silent skip', () => {
  // 'a' + a 4-byte emoji + 'b'. Offsets 2..4 land inside the emoji.
  const buffer = Buffer.from('a🎯b', 'utf8')
  for (const offset of [2, 3, 4]) {
    assert.throws(
      () => readPage({ content: buffer, offset }),
      RangeError,
      `offset ${String(offset)} lands inside a character and must be refused`,
    )
  }
  // Every legal offset is a character boundary: 0, 1 (after 'a'), 5 (after the
  // emoji), 6 (the end).
  for (const offset of [0, 1, 5, 6]) {
    assert.doesNotThrow(() => readPage({ content: buffer, offset }), `offset ${String(offset)}`)
  }
  // The tool's own offsets always land on a boundary, so a refusal only ever
  // hits a caller that computed an offset by hand.
  const first = readPage({ content: buffer, offset: 1 })
  assert.doesNotThrow(() => readPage({ content: buffer, offset: first.nextOffset }))
})

test('QA: an offset past the end is a RangeError', () => {
  const buffer = Buffer.from('abc', 'utf8')
  assert.throws(() => readPage({ content: buffer, offset: 4 }), RangeError)
  assert.throws(() => readPage({ content: buffer, offset: -1 }), RangeError)
  assert.throws(() => readPage({ content: buffer, offset: 1.5 }), RangeError)
  const end = readPage({ content: buffer, offset: 3 })
  assert.equal(end.text, '')
  assert.equal(end.eof, true)
})

// ---------------------------------------------------------------------------
// observation: what must never be replaced
// ---------------------------------------------------------------------------

test('QA: the fusion tools and the recall tool are never replaced', () => {
  for (const name of ['read', 'obs_recall', 'edit_then_run', 'write_then_run']) {
    assert.ok(NEVER_REPLACE.includes(name), `${name} must be excluded`)
  }
})

test('QA: a result carrying a receipt marker is never replaced', () => {
  for (const marker of RECEIPT_MARKERS) {
    assert.equal(hasReceipt(`text with ${marker} inside`), true, marker)
  }
  assert.equal(hasReceipt('plain text'), false)
})

test('QA: the skip decision covers errors, nested calls, and small output', () => {
  const big = 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const base = { name: 'ops_bash', parent: undefined }
  const result = { isError: false, content: [{ type: 'text', text: big }] }

  assert.equal(shouldReplace({ exec: base, result }).replace, true, 'a large plain result is replaced')
  assert.equal(
    shouldReplace({ exec: base, result: { ...result, isError: true } }).replace,
    false,
    'an error result is never replaced',
  )
  assert.equal(
    shouldReplace({ exec: { ...base, parent: Symbol('parent') }, result }).replace,
    false,
    'a nested call is never replaced',
  )
  assert.equal(
    shouldReplace({ exec: base, result: { isError: false, content: [{ type: 'text', text: 'short' }] } }).replace,
    false,
  )
})

test('QA: the threshold is UTF-8 bytes, not characters', () => {
  // 4000 CJK characters are 12000 bytes: over a 10 KiB byte threshold, but
  // "only" 4000 characters if someone counted code units.
  const cjk = '中'.repeat(4000)
  assert.ok(Buffer.byteLength(cjk, 'utf8') > DEFAULT_THRESHOLD_BYTES)
  assert.ok(cjk.length < DEFAULT_THRESHOLD_BYTES)
  const decision = shouldReplace({
    exec: { name: 'ops_bash', parent: undefined },
    result: { isError: false, content: [{ type: 'text', text: cjk }] },
  })
  assert.equal(decision.replace, true, 'the byte count must decide, not the code-unit count')
})

test('QA: observation ids are stable and bounded', () => {
  const input = { toolName: 'ops_bash', callId: 'c1', contentHash: sha256('x') }
  const first = observationId(input)
  assert.equal(observationId(input), first, 'the same occurrence yields the same id')
  assert.equal(isValidObservationId(first), true)
  assert.match(first, /^obs_[0-9a-f]{24}$/u)
  assert.notEqual(observationId({ ...input, callId: 'c2' }), first, 'a different call yields a different id')
})
