import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createArchiver, sha256 } from '../lib/archive.js'
import { appendLedgerRecord } from '../lib/ledger.js'
import {
  alignToCharacterEnd,
  alignToCharacterStart,
  buildPlaceholder,
  createObservationHandler,
  DEFAULT_THRESHOLD_BYTES,
  defineRecallTool,
  hasReceipt,
  isValidObservationId,
  MAX_PAGE_BYTES,
  MAX_PAGE_LINES,
  NEVER_REPLACE,
  OBSERVATION_ID_PATTERN,
  observationId,
  readPage,
  RECALL_TOOL_NAME,
  recallText,
  RECEIPT_MARKERS,
  replaceableText,
  shouldReplace,
} from '../lib/observation.js'
import { createFakeCtx, createFakeTools } from './fake-ctx.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

/**
 * Read every page of one archived observation.
 *
 * A test helper, not production code: it proves that concatenating the chunks
 * reproduces the archived bytes exactly (`report.md` 3.6).
 *
 * @param {Buffer|string} content - the full content.
 * @returns {string} the concatenated text.
 */
function readAllPages(content) {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  const parts = []
  let offset = 0
  for (let guard = 0; guard < 1_000_000; guard += 1) {
    const page = readPage({ content: buffer, offset })
    parts.push(page.text)
    if (page.eof) return parts.join('')
    if (page.nextOffset <= offset) throw new Error(`obs_recall: paging stalled at offset ${String(offset)}`)
    offset = page.nextOffset
  }
  throw new Error('obs_recall: paging did not terminate')
}

/**
 * Build a result carrying one text block.
 * @param {string} text - the text.
 * @param {object} [extra] - extra result fields.
 * @returns {object} the result.
 */
function textResult(text, extra = {}) {
  return { isError: false, content: [{ type: 'text', text }], ...extra }
}

/**
 * An in-memory archiver implementing the observation-facing surface.
 *
 * It mirrors the real one: the store is content-addressed and holds no id
 * mapping. The id → key lookup comes from the ledger, so this fake keeps a
 * ledger array that `getByObservation` scans, exactly as
 * `findArchiveKeyForObservation` does.
 * @returns {object} the archiver.
 */
function memoryArchiver() {
  const store = new Map()
  const ledger = []
  return {
    store,
    ledger,
    put(content) {
      const bytes = Buffer.from(content, 'utf8')
      const digest = sha256(bytes)
      store.set(digest, bytes)
      return Promise.resolve({ digest, path: `/mem/${digest}.txt`, created: true, bytes: bytes.length })
    },
    putObservation(content) {
      return this.put(content)
    },
    /**
     * Record one ledger line, as the handler does.
     * @param {object} record - the line.
     * @returns {void}
     */
    record(record) {
      ledger.push(record)
    },
    get(digest) {
      return Promise.resolve(store.get(digest))
    },
    getByObservation(id) {
      for (let index = ledger.length - 1; index >= 0; index -= 1) {
        const record = ledger[index]
        if (record?.id === id && record.kind === 'observation') {
          return Promise.resolve(store.get(record.archiveKey))
        }
      }
      return Promise.resolve(undefined)
    },
    getText(digest) {
      const bytes = store.get(digest)
      return Promise.resolve(bytes === undefined ? undefined : bytes.toString('utf8'))
    },
    remove(digest) {
      return Promise.resolve(store.delete(digest))
    },
    digestOf(content) {
      return sha256(content)
    },
    pathOf(digest) {
      return `/mem/${digest}.txt`
    },
    digestOfObservation(id) {
      for (let index = ledger.length - 1; index >= 0; index -= 1) {
        const record = ledger[index]
        if (record?.id === id && record.kind === 'observation') return Promise.resolve(record.archiveKey)
      }
      return Promise.resolve(undefined)
    },
  }
}

/**
 * Run the handler with a fixed `next()` decision.
 * @param {object} options - the run inputs.
 * @param {object} options.exec - the execution context.
 * @param {object} options.result - the tool result.
 * @param {object} [options.decision] - what `next()` returns.
 * @param {object} [options.archiver] - the archiver.
 * @param {number} [options.thresholdBytes] - the threshold.
 * @param {Function} [options.warn] - the warning sink.
 * @param {Function} [options.record] - the ledger sink.
 * @returns {Promise<object>} the decision the handler returned.
 */
async function run(options) {
  const archiver = options.archiver ?? memoryArchiver()
  const handler = createObservationHandler({
    archiverFor: () => archiver,
    thresholdBytes: options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES,
    warn: options.warn ?? (() => {}),
    // The default sink writes to the fake ledger, which is what the lookup reads.
    record: options.record ?? ((line) => archiver.record?.(line)),
  })
  const decision = options.decision ?? { kind: 'accept' }
  return handler(
    options.exec ?? { name: 'pwsh', callId: 'call-1' },
    options.result ?? textResult('x'),
    async () => decision,
  )
}

/* ------------------------------------------------------------------ */
/* identity                                                            */
/* ------------------------------------------------------------------ */

test('an observation id is obs_ plus 24 lowercase hex', () => {
  const id = observationId({ toolName: 'pwsh', callId: 'call-1', contentHash: sha256('x') })
  assert.match(id, OBSERVATION_ID_PATTERN)
  assert.equal(isValidObservationId(id), true)
  assert.equal(id.length, 4 + 24)
})

test('the same call yields the same id, a different call a different one', () => {
  const base = { toolName: 'pwsh', contentHash: sha256('same bytes') }
  assert.equal(
    observationId({ ...base, callId: 'call-1' }),
    observationId({ ...base, callId: 'call-1' }),
  )
  assert.notEqual(
    observationId({ ...base, callId: 'call-1' }),
    observationId({ ...base, callId: 'call-2' }),
    'the same bytes in two calls must not share an id',
  )
  assert.notEqual(
    observationId({ toolName: 'bash', callId: 'call-1', contentHash: sha256('same bytes') }),
    observationId({ toolName: 'pwsh', callId: 'call-1', contentHash: sha256('same bytes') }),
    'the tool name separates ids too',
  )
})

test('isValidObservationId rejects everything else', () => {
  for (const bad of [
    '',
    'obs_',
    'obs_short',
    `obs_${'A'.repeat(24)}`,
    `obs_${'g'.repeat(24)}`,
    `obs_${'a'.repeat(23)}`,
    `obs_${'a'.repeat(25)}`,
    'xobs_aaaaaaaaaaaaaaaaaaaaaaaa',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isValidObservationId(bad), false, JSON.stringify(bad))
  }
})

/* ------------------------------------------------------------------ */
/* placeholder                                                         */
/* ------------------------------------------------------------------ */

test('the placeholder follows the fixed template', () => {
  // Long enough that head and tail do not cover the whole text.
  const content = `first line\n${'m'.repeat(4000)}\nlast line\n`
  const id = 'obs_0123456789abcdef01234567'
  const text = buildPlaceholder({ id, content, toolName: 'pwsh' })
  const lines = text.split('\n')
  assert.equal(lines[0], '[large tool result replaced; the original is archived and readable]')
  assert.equal(lines[1], `id: ${id}`)
  assert.equal(lines[2], 'tool: pwsh')
  assert.equal(lines[3], `original_bytes: ${Buffer.byteLength(content, 'utf8')}`)
  assert.equal(lines[4], 'original_lines: 3')
  assert.equal(lines[5], `estimated_tokens: ${Math.ceil(Buffer.byteLength(content, 'utf8') / 4)}`)
  assert.match(lines[6], /^retrieve: call obs_recall with \{"id":"obs_[0-9a-f]{24}","offset":0\}; /u)

  // Locate the two section markers rather than assuming fixed line numbers: a
  // head that ends with a newline contributes an extra empty line.
  const headMarker = lines.indexOf('[first complete lines, up to 512 bytes]')
  const tailMarker = lines.indexOf('[middle omitted; last complete lines, up to 512 bytes]')
  assert.ok(headMarker > 0, 'the head marker is present')
  assert.ok(tailMarker > headMarker, 'the tail marker follows the head marker')

  const head = lines.slice(headMarker + 1, tailMarker).join('\n')
  const tailEnd = lines.findIndex((line, index) => index > tailMarker && /^\[\d+ original bytes omitted\]$/u.test(line))
  assert.ok(tailEnd > tailMarker, 'the omitted-bytes line closes the placeholder')
  const tail = lines.slice(tailMarker + 1, tailEnd).join('\n')

  assert.equal(head.trimEnd(), 'first line', 'the head holds the first complete line')
  assert.equal(tail.trim(), 'last line', 'the tail holds the last complete line')
  assert.match(lines[tailEnd], /^\[\d+ original bytes omitted\]$/u)
})

test('the placeholder never claims a "first 2 requests" behaviour', () => {
  const text = buildPlaceholder({ id: 'obs_0123456789abcdef01234567', content: 'x'.repeat(20000), toolName: 'pwsh' })
  assert.doesNotMatch(text, /first 2/u)
  assert.doesNotMatch(text, /provider requests/u)
})

test('the same inputs yield a byte-identical placeholder', () => {
  const content = 'z'.repeat(DEFAULT_THRESHOLD_BYTES + 10)
  const id = 'obs_0123456789abcdef01234567'
  const first = buildPlaceholder({ id, content, toolName: 'pwsh' })
  const second = buildPlaceholder({ id, content, toolName: 'pwsh' })
  assert.equal(first, second)
  // No timestamp, counter, or randomness may leak in.
  assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/u)
})

test('the placeholder keeps only complete lines at each end', () => {
  const content = `${'a'.repeat(100)}\n${'b'.repeat(50000)}\n${'c'.repeat(100)}\n`
  const text = buildPlaceholder({ id: 'obs_0123456789abcdef01234567', content, toolName: 'pwsh' })
  const body = text.split('\n')
  const head = body[8]
  const tail = body[10]
  assert.ok(Buffer.byteLength(head, 'utf8') <= 512, 'the head preview fits its budget')
  assert.ok(Buffer.byteLength(tail, 'utf8') <= 512, 'the tail preview fits its budget')
  assert.ok(head.endsWith('a'.repeat(100)) || head.length === 0 || !head.includes('b'), 'the head is whole lines')
})

test('a placeholder preview does not split a character', () => {
  const content = `${'中'.repeat(400)}\n`
  const text = buildPlaceholder({ id: 'obs_0123456789abcdef01234567', content })
  assert.doesNotMatch(text, /\uFFFD/u)
})

/* ------------------------------------------------------------------ */
/* replacement decision                                                */
/* ------------------------------------------------------------------ */

test('a large plain-text result is replaced by a stable placeholder', async () => {
  const archiver = memoryArchiver()
  const big = 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 100)
  const decision = await run({ result: textResult(big), archiver })
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 1)
  const text = decision.content[0].text
  assert.match(text, /^\[large tool result replaced; the original is archived and readable\]/u)
  const id = /^id: (obs_[0-9a-f]{24})$/mu.exec(text)[1]
  const stored = await archiver.getByObservation(id)
  assert.ok(Buffer.isBuffer(stored))
  assert.equal(stored.toString('utf8'), big)
})

test('the same content twice yields the same placeholder', async () => {
  const big = 'y'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const first = await run({ result: textResult(big) })
  const second = await run({ result: textResult(big) })
  assert.deepEqual(first, second, 'the placeholder must be a pure function of the call and content')
})

test('a small result is left alone', async () => {
  const decision = await run({ result: textResult('tiny') })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal('content' in decision, false)
})

test('a result exactly at the threshold is replaced, one byte under is not', async () => {
  const exact = 'a'.repeat(DEFAULT_THRESHOLD_BYTES)
  const under = 'a'.repeat(DEFAULT_THRESHOLD_BYTES - 1)
  assert.equal('content' in await run({ result: textResult(exact) }), true)
  assert.equal('content' in await run({ result: textResult(under) }), false)
})

test('the threshold counts UTF-8 bytes, not characters', async () => {
  const count = Math.ceil(DEFAULT_THRESHOLD_BYTES / 3) + 1
  const cjk = '中'.repeat(count)
  assert.ok(Buffer.byteLength(cjk, 'utf8') >= DEFAULT_THRESHOLD_BYTES)
  assert.ok(cjk.length < DEFAULT_THRESHOLD_BYTES, 'the character count alone is below the threshold')
  assert.equal('content' in await run({ result: textResult(cjk) }), true)
})

test('an error result is never replaced', async () => {
  const big = 'e'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const decision = await run({ result: { isError: true, content: [{ type: 'text', text: big }] } })
  assert.equal('content' in decision, false)
})

test('a nested call is never replaced', async () => {
  const big = 'n'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const decision = await run({ exec: { name: 'pwsh', callId: 'c', parent: Symbol('t') }, result: textResult(big) })
  assert.equal('content' in decision, false)
})

test('read, obs_recall and the two Fusion tools are never replaced', async () => {
  const big = 'r'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  for (const name of NEVER_REPLACE) {
    const decision = await run({ exec: { name, callId: 'c' }, result: textResult(big) })
    assert.equal('content' in decision, false, name)
  }
  assert.deepEqual([...NEVER_REPLACE], ['read', RECALL_TOOL_NAME, 'edit_then_run', 'write_then_run'])
})

test('a result carrying a reducer receipt is never replaced', async () => {
  const big = 'q'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  for (const marker of RECEIPT_MARKERS) {
    const decision = await run({ result: textResult(`${marker}\n${big}`) })
    assert.equal('content' in decision, false, marker)
  }
  assert.deepEqual([...RECEIPT_MARKERS], ['dsh-sol_evidence_receipt_v1', 'sol_pi_evidence_receipt_v1'])
  assert.equal(hasReceipt('nothing here'), false)
  assert.equal(hasReceipt('dsh-sol_evidence_receipt_v1 ...'), true)
  assert.equal(hasReceipt('sol_pi_evidence_receipt_v1 ...'), true)
  // The bare project name must not disable replacement (simplicity audit 4.2).
  assert.equal(hasReceipt('see sol_pi_ for details'), false)
})

test('a receipt an earlier step produced is left alone', async () => {
  // The handler judges `decision.content`, not the raw result: a Reducer running
  // before it replaces the content with a receipt, and replacing that receipt
  // with a placeholder would throw away the evidence it carries.
  const big = 'r'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const receipt = `${RECEIPT_MARKERS[0]}\nstatus=failure\n${big}`
  const decision = await run({
    result: textResult(big),
    decision: { kind: 'accept', content: [{ type: 'text', text: receipt }] },
  })
  assert.deepEqual(decision.content, [{ type: 'text', text: receipt }], 'the receipt survives verbatim')
})

test('a large replacement by an earlier step is still replaced', async () => {
  // The content, not the result, is what the model sees: a big body introduced by
  // an earlier step must be handled the same way as a big tool result.
  const big = 's'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const decision = await run({
    result: textResult('small'),
    decision: { kind: 'accept', content: [{ type: 'text', text: big }] },
  })
  assert.equal('content' in decision, true)
  assert.match(decision.content[0].text, /large tool result replaced/u)
})

test('a result containing an image is never replaced', async () => {
  const decision = await run({
    result: {
      isError: false,
      content: [{ type: 'text', text: 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1) }, { type: 'image' }],
    },
  })
  assert.equal('content' in decision, false)
})

test('a non-accept decision is passed through untouched', async () => {
  const big = 'b'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  for (const kind of ['block', 'deny', 'ask']) {
    assert.deepEqual(await run({ result: textResult(big), decision: { kind } }), { kind })
  }
})

test('a decision that already carries a value is passed through', async () => {
  const big = 'v'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const original = { kind: 'accept', value: { kept: true } }
  assert.deepEqual(await run({ result: textResult(big), decision: original }), original)
})

test('additionalContexts survive the replacement', async () => {
  const big = 'c'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const contexts = [{ role: 'user', content: [{ type: 'text', text: 'reminder' }] }]
  const decision = await run({ result: textResult(big), decision: { kind: 'accept', additionalContexts: contexts } })
  assert.equal('content' in decision, true)
  assert.deepEqual(decision.additionalContexts, contexts)
})

test('a replacement records one ledger line with the saving', async () => {
  const big = 'l'.repeat(DEFAULT_THRESHOLD_BYTES + 500)
  const lines = []
  await run({ result: textResult(big), record: (line) => lines.push(line) })
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.equal(line.kind, 'observation')
  assert.match(line.id, OBSERVATION_ID_PATTERN)
  assert.equal(line.tool, 'pwsh')
  assert.equal(line.callId, 'call-1')
  assert.equal(line.originalBytes, Buffer.byteLength(big, 'utf8'))
  assert.ok(line.placeholderBytes > 0)
  assert.equal(line.omittedBytes, line.originalBytes - line.placeholderBytes)
  assert.equal(typeof line.archiveKey, 'string')
  assert.match(line.archiveKey, /^[0-9a-f]{64}$/u)
})

test('a ledger failure keeps the original result', async () => {
  // The ledger line is the only record of which archive key an id names, so a
  // placeholder whose line was never written would be unreadable: the original
  // must be handed back instead (report.md 3.4).
  const big = 'k'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const warnings = []
  const decision = await run({
    result: textResult(big),
    record: () => {
      throw new Error('ledger is full')
    },
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(decision, { kind: 'accept' }, 'the original result is handed back')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /kept the original result/u)
})

test('an async ledger write is awaited before the placeholder is returned', async () => {
  // A fire-and-forget write would let the model see a placeholder whose lookup
  // is not on disk yet.
  const big = 'w'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  let settled = false
  const archiver = memoryArchiver()
  const decision = await run({
    result: textResult(big),
    archiver,
    record: async (line) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      archiver.record(line)
      settled = true
    },
  })
  assert.equal(settled, true, 'the write finished before the handler returned')
  assert.equal('content' in decision, true)
  const id = /^id: (obs_[0-9a-f]{24})$/mu.exec(decision.content[0].text)[1]
  assert.ok((await archiver.getByObservation(id)) !== undefined, 'the lookup resolves right away')
})

test('an async ledger write that rejects also keeps the original', async () => {
  const big = 'v'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const decision = await run({
    result: textResult(big),
    record: async () => {
      throw new Error('disk gone')
    },
  })
  assert.deepEqual(decision, { kind: 'accept' })
})

test('an archive failure keeps the original decision', async () => {
  const big = 'f'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  const warnings = []
  const archiver = {
    digestOf: sha256,
    putObservation: () => Promise.reject(new Error('disk full')),
  }
  const decision = await run({ result: textResult(big), archiver, warn: (message) => warnings.push(message) })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /kept the original result/u)
})

test('a throwing next() is not swallowed', async () => {
  const handler = createObservationHandler({ archiverFor: () => memoryArchiver() })
  await assert.rejects(
    () => handler({ name: 'pwsh' }, textResult('x'), async () => { throw new Error('inner failed') }),
    /inner failed/u,
  )
})

test('shouldReplace explains every refusal', () => {
  const big = 'z'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  assert.match(shouldReplace({ exec: { name: 'pwsh' }, result: { isError: true } }).reason, /error/u)
  assert.match(shouldReplace({ exec: { name: 'pwsh', parent: Symbol('t') }, result: textResult(big) }).reason, /nested/u)
  assert.match(shouldReplace({ exec: { name: 'read' }, result: textResult(big) }).reason, /never replaced/u)
  assert.match(shouldReplace({ exec: { name: 'pwsh' }, result: textResult('small') }).reason, /under/u)
  assert.match(shouldReplace({ exec: { name: 'pwsh' }, result: { isError: false, content: [{ type: 'image' }] } }).reason, /not plain text/u)
  assert.match(shouldReplace({ exec: { name: 'pwsh' }, result: textResult(`dsh-sol_evidence_receipt_v1\n${big}`) }).reason, /receipt/u)
  assert.equal(shouldReplace({ exec: { name: 'pwsh' }, result: textResult(big) }).replace, true)
})

test('replaceableText joins text blocks and rejects mixed content', () => {
  assert.equal(replaceableText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(replaceableText({ content: [{ type: 'image' }] }), undefined)
  assert.equal(replaceableText({ content: [] }), undefined)
  assert.equal(replaceableText({ isError: true, content: [{ type: 'text', text: 'x' }] }), undefined)
  assert.equal(replaceableText(undefined), undefined)
})

/* ------------------------------------------------------------------ */
/* paging                                                              */
/* ------------------------------------------------------------------ */

test('a chunk is at most the byte budget', () => {
  const content = 'a'.repeat(MAX_PAGE_BYTES * 3)
  const page = readPage({ content })
  assert.ok(page.bytes <= MAX_PAGE_BYTES, `chunk was ${String(page.bytes)} bytes`)
  assert.equal(page.eof, false)
  assert.equal(page.nextOffset, page.bytes)
})

test('a chunk is at most the line budget', () => {
  const content = 'a\n'.repeat(MAX_PAGE_LINES * 2)
  const page = readPage({ content })
  assert.ok(page.lines <= MAX_PAGE_LINES, `chunk had ${String(page.lines)} lines`)
  assert.equal(page.eof, false)
})

test('the last chunk reports eof at the content length', () => {
  const content = 'a'.repeat(1000)
  const page = readPage({ content, offset: 900 })
  assert.equal(page.eof, true)
  assert.equal(page.nextOffset, 1000)
  assert.equal(page.bytes, 100)
})

test('an offset at the end yields an empty eof chunk', () => {
  const page = readPage({ content: 'abc', offset: 3 })
  assert.equal(page.text, '')
  assert.equal(page.eof, true)
  assert.equal(page.bytes, 0)
})

test('an out-of-range offset is refused', () => {
  assert.throws(() => readPage({ content: 'abc', offset: 4 }), RangeError)
  assert.throws(() => readPage({ content: 'abc', offset: -1 }), RangeError)
  assert.throws(() => readPage({ content: 'abc', offset: 1.5 }), RangeError)
})

test('an offset inside a multi-byte character is refused, not rounded', () => {
  // '中' is three bytes. Offsets 1 and 2 are inside it; rounding forward would
  // silently drop the character and break the byte-exact paging invariant.
  const content = '中中中'
  for (const offset of [1, 2, 4, 5, 7, 8]) {
    assert.throws(() => readPage({ content, offset }), RangeError, `offset ${String(offset)}`)
  }
  // Every character boundary is accepted.
  for (const offset of [0, 3, 6, 9]) {
    assert.doesNotThrow(() => readPage({ content, offset }), `offset ${String(offset)}`)
  }
})

test('a misaligned offset never silently loses bytes', () => {
  const content = '中中中'
  const whole = readPage({ content, offset: 0 }).text
  assert.equal(whole, content)
  // Asking for a misaligned offset is an error rather than a shorter answer.
  assert.throws(() => readPage({ content, offset: 1 }), RangeError)
})

test('a chunk never splits a multi-byte character', () => {
  const content = '中'.repeat(20000)
  const page = readPage({ content })
  assert.equal(page.bytes % 3, 0, 'the chunk length is a whole number of characters')
  assert.doesNotMatch(page.text, /\uFFFD/u)
})

test('concatenating every chunk reproduces the original bytes exactly', () => {
  const content = `${'中文 emoji 🎉 and ascii\n'.repeat(2000)}`
  assert.equal(readAllPages(content), content)
  assert.equal(sha256(readAllPages(content)), sha256(content))
})

test('paging is byte-exact for a single long line with no newlines', () => {
  const content = 'x'.repeat(MAX_PAGE_BYTES * 2 + 7)
  assert.equal(readAllPages(content), content)
})

test('alignToCharacterStart and alignToCharacterEnd agree at a boundary', () => {
  const buffer = Buffer.from('中', 'utf8')
  assert.equal(alignToCharacterStart(buffer, 1), 0)
  assert.equal(alignToCharacterStart(buffer, 2), 0)
  assert.equal(alignToCharacterStart(buffer, 3), 3)
  assert.equal(alignToCharacterEnd(buffer, 1), 3)
  assert.equal(alignToCharacterEnd(buffer, 0), 0)
  assert.equal(alignToCharacterEnd(buffer, 3), 3)
})

test('the recall text states offset, next_offset and eof', () => {
  const text = recallText({ id: 'obs_0123456789abcdef01234567', offset: 0, bytes: 10, lines: 2, nextOffset: 10, eof: false, chunk: 'abc' })
  const lines = text.split('\n')
  assert.equal(lines[0], '[obs_recall id=obs_0123456789abcdef01234567 offset=0 next_offset=10 eof=false]')
  assert.equal(lines[1], '[chunk_bytes=10 chunk_lines=2; use next_offset to continue]')
  assert.equal(lines[2], 'abc')
  const end = recallText({ id: 'obs_0123456789abcdef01234567', offset: 10, bytes: 5, lines: 1, nextOffset: 15, eof: true, chunk: 'de' })
  assert.match(end, /end of observation/u)
})

/* ------------------------------------------------------------------ */
/* obs_recall                                                          */
/* ------------------------------------------------------------------ */

test('obs_recall reads a chunk back', async () => {
  const archiver = memoryArchiver()
  const content = 'p'.repeat(MAX_PAGE_BYTES + 100)
  const id = observationId({ toolName: 'pwsh', callId: 'c', contentHash: sha256(content) })
  await archiver.put(content)
  archiver.record({ kind: 'observation', id, archiveKey: sha256(content) })
  const tool = defineRecallTool({ archiverFor: () => archiver })
  const value = await tool.execute({ id }, { name: RECALL_TOOL_NAME })
  assert.equal(value.eof, false)
  assert.equal(value.bytes, MAX_PAGE_BYTES)
  assert.equal(value.nextOffset, MAX_PAGE_BYTES)
  assert.match(value.text, /use next_offset to continue/u)
})

test('obs_recall chunks concatenate back to the original', async () => {
  const archiver = memoryArchiver()
  const content = `${'行内容 with ascii\n'.repeat(3000)}`
  const id = observationId({ toolName: 'pwsh', callId: 'c', contentHash: sha256(content) })
  await archiver.put(content)
  archiver.record({ kind: 'observation', id, archiveKey: sha256(content) })
  const tool = defineRecallTool({ archiverFor: () => archiver })
  const parts = []
  let offset = 0
  for (let guard = 0; guard < 1000; guard += 1) {
    const value = await tool.execute({ id, offset }, { name: RECALL_TOOL_NAME })
    // Strip the two header lines from each chunk.
    parts.push(value.text.split('\n').slice(2).join('\n'))
    if (value.eof) break
    offset = value.nextOffset
  }
  assert.equal(parts.join(''), content)
})

test('obs_recall refuses an unknown id', async () => {
  const archiver = memoryArchiver()
  const tool = defineRecallTool({ archiverFor: () => archiver })
  await assert.rejects(() => tool.execute({ id: `obs_${'a'.repeat(24)}` }, {}), /unknown observation id/u)
})

test('obs_recall refuses a malformed id', async () => {
  const archiver = memoryArchiver()
  const tool = defineRecallTool({ archiverFor: () => archiver })
  for (const id of ['', 'obs_short', 'x', undefined]) {
    await assert.rejects(() => tool.execute({ id }, {}), /invalid observation id/u, String(id))
  }
})

test('obs_recall refuses undeclared arguments', async () => {
  const archiver = memoryArchiver()
  const tool = defineRecallTool({ archiverFor: () => archiver })
  await assert.rejects(
    () => tool.execute({ id: `obs_${'a'.repeat(24)}`, limit: 100 }, {}),
    /unknown argument/u,
  )
})

test('obs_recall validates the offset', async () => {
  const archiver = memoryArchiver()
  const tool = defineRecallTool({ archiverFor: () => archiver })
  for (const offset of [-1, 1.5, '10']) {
    await assert.rejects(
      () => tool.execute({ id: `obs_${'a'.repeat(24)}`, offset }, {}),
      /invalid offset/u,
      String(offset),
    )
  }
})

test('obs_recall records a recall ledger line', async () => {
  const archiver = memoryArchiver()
  const content = 'r'.repeat(100)
  const id = observationId({ toolName: 'pwsh', callId: 'c', contentHash: sha256(content) })
  await archiver.put(content)
  archiver.record({ kind: 'observation', id, archiveKey: sha256(content) })
  const lines = []
  const tool = defineRecallTool({ archiverFor: () => archiver, record: (line) => lines.push(line) })
  await tool.execute({ id }, {})
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'observation-recall')
  assert.equal(lines[0].id, id)
  assert.equal(lines[0].eof, true)
})

test('obs_recall is a plain definition with the supported schema subset', () => {
  const tool = defineRecallTool({ archiverFor: () => memoryArchiver() })
  assert.equal(tool.name, RECALL_TOOL_NAME)
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['id'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['id', 'offset'])
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'oneOf']
  for (const key of Object.keys(tool.parameters)) assert.ok(supported.includes(key), key)
  for (const key of Object.keys(tool.output.schema)) assert.ok(supported.includes(key), key)
})

test('the recall tool never replaces its own result', () => {
  assert.ok(NEVER_REPLACE.includes(RECALL_TOOL_NAME))
  const big = 'q'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
  assert.equal(shouldReplace({ exec: { name: RECALL_TOOL_NAME }, result: textResult(big) }).replace, false)
})

/* ------------------------------------------------------------------ */
/* end to end with the real archive                                    */
/* ------------------------------------------------------------------ */

test('a real archive round-trips through the handler and obs_recall', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-obs-'))
  try {
    const archiver = createArchiver({ home, sessionId: GOOD_ID })
    const content = `${'真实内容 with 🎉\n'.repeat(2000)}`
    // The real lookup reads the ledger, so the handler must write real lines.
    const handler = createObservationHandler({
      archiverFor: () => archiver,
      record: (line) => appendLedgerRecord({ home, sessionId: GOOD_ID, record: line }),
    })
    const decision = await handler(
      { name: 'pwsh', callId: 'call-e2e' },
      textResult(content),
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.kind, 'accept')

    const id = /^id: (obs_[0-9a-f]{24})$/mu.exec(decision.content[0].text)[1]
    assert.equal((await archiver.getByObservation(id)).toString('utf8'), content, 'the archive holds the exact bytes')

    const tool = defineRecallTool({ archiverFor: () => archiver })
    const parts = []
    let offset = 0
    for (let guard = 0; guard < 10000; guard += 1) {
      const value = await tool.execute({ id, offset }, { name: RECALL_TOOL_NAME })
      parts.push(value.text.split('\n').slice(2).join('\n'))
      if (value.eof) break
      offset = value.nextOffset
    }
    assert.equal(parts.join(''), content, 'paging reproduces the original exactly')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('two calls over the same bytes get two ids but one stored object', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-obs-'))
  try {
    const archiver = createArchiver({ home, sessionId: GOOD_ID })
    const content = 's'.repeat(DEFAULT_THRESHOLD_BYTES + 1)
    const handler = createObservationHandler({
      archiverFor: () => archiver,
      record: (line) => appendLedgerRecord({ home, sessionId: GOOD_ID, record: line }),
    })
    const first = await handler({ name: 'pwsh', callId: 'call-1' }, textResult(content), async () => ({ kind: 'accept' }))
    const second = await handler({ name: 'pwsh', callId: 'call-2' }, textResult(content), async () => ({ kind: 'accept' }))
    const idA = /^id: (obs_[0-9a-f]{24})$/mu.exec(first.content[0].text)[1]
    const idB = /^id: (obs_[0-9a-f]{24})$/mu.exec(second.content[0].text)[1]
    assert.notEqual(idA, idB, 'different calls must get different ids')
    const digestA = await archiver.digestOfObservation(idA)
    const digestB = await archiver.digestOfObservation(idB)
    assert.equal(digestA, digestB, 'the same bytes are stored once')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */
/* the two pieces index.js composes                                    */
/* ------------------------------------------------------------------ */

test('the handler and the tool are separately registrable, which is what index.js does', () => {
  // `mountObservation` was removed: it registered its own listener, and the
  // plugin must register exactly one post-execute listener for all mechanisms.
  const fake = createFakeCtx()
  const archiver = memoryArchiver()
  const disposeListener = fake.ctx.on(
    'tools/post-execute',
    createObservationHandler({ archiverFor: () => archiver }),
  )
  const disposeTool = fake.ctx.tools.register(defineRecallTool({ archiverFor: () => archiver }))
  assert.equal(fake.listenerCount('tools/post-execute'), 1)
  assert.deepEqual(fake.fakeTools.registered.map((definition) => definition.name), [RECALL_TOOL_NAME])
  disposeTool()
  disposeListener()
  assert.equal(fake.listenerCount('tools/post-execute'), 0)
  assert.equal(fake.fakeTools.registered.length, 0)
})
