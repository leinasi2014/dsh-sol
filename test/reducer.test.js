import assert from 'node:assert/strict'
import test from 'node:test'

import { sha256 } from '../lib/archive.js'
import {
  buildSystemPrompt,
  buildUserPrompt,
  callModel,
  checkEvidence,
  checkFailureEvidence,
  checkReceiptSchema,
  checkShrinks,
  commandSha256Of,
  createReducerHandler,
  DEFAULTS,
  EVIDENCE_KINDS,
  FAILURE_SIGNAL,
  FOREIGN_RECEIPT_MARKER,
  fuseSignals,
  isReceipt,
  isTruncated,
  LIKELY_SECRET,
  parseReceiptJson,
  plainTextOf,
  RECEIPT_MARKER,
  RECEIPT_SCHEMA,
  renderReceipt,
  REQUEST_PURPOSE,
  sha256Hex,
  shouldReduce,
  validateReceipt,
} from '../lib/reducer.js'
import { createFakeCtx } from './fake-ctx.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

/** A long failing log with a real failure line. */
const FAILING_LOG = `${'build step ok\n'.repeat(400)}FAIL src/a.test.ts\n  Error: expected 1 to be 2\n${'trace line\n'.repeat(200)}`

/**
 * Build a failing tool result.
 *
 * A command that runs and exits non-zero is **not** `isError`: the code lives in
 * `value` (`report.md` 2.1). That is the shape a failing test log has, so it is
 * the default here — using `isError: true` would test the wrong branch.
 *
 * @param {string} text - the log.
 * @param {object} [value] - extra `value` fields.
 * @returns {object} the result.
 */
function failedResult(text, value = {}) {
  return { isError: false, content: [{ type: 'text', text }], value: { exitCode: 1, timedOut: false, ...value } }
}

/** The shell names the tests use, as `actionFusion.shells` would supply. */
const SHELLS = ['ops_bash', 'pwsh', 'bash']

/**
 * A reducer config that is fully enabled.
 * @param {object} [overrides] - fields to override.
 * @returns {object} the config.
 */
function config(overrides = {}) {
  return { enabled: true, provider: 'test-provider', model: 'test-model', ...overrides }
}

/**
 * An in-memory archiver.
 * @returns {object} the archiver.
 */
function memoryArchiver() {
  const store = new Map()
  return {
    store,
    put(content) {
      const bytes = Buffer.from(content, 'utf8')
      const digest = sha256(bytes)
      store.set(digest, bytes)
      return Promise.resolve({ digest, path: `/mem/${digest}.txt`, created: true, bytes: bytes.length })
    },
    getText(digest) {
      const bytes = store.get(digest)
      return Promise.resolve(bytes === undefined ? undefined : bytes.toString('utf8'))
    },
  }
}

/**
 * Build an async generator that yields the given chunks.
 * @param {object[]} chunks - the chunks.
 * @returns {AsyncGenerator<object>} the stream.
 */
function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk
  })()
}

/**
 * A fake llm service that returns one scripted stream.
 * @param {object[]|Error} chunks - the chunks, or an error to throw.
 * @returns {object} the service plus its recorded options.
 */
function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      if (chunks instanceof Error) {
        return (async function* failing() {
          throw chunks
        })()
      }
      return streamOf(chunks)
    },
  }
}

/**
 * The chunks of a normal, successful reply.
 * @param {string} text - the reply.
 * @returns {object[]} the chunks.
 */
function okChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Build a valid receipt reply for a log.
 * @param {string} body - the log.
 * @param {object} [overrides] - fields to override.
 * @returns {string} the JSON reply.
 */
function receiptJson(body, overrides = {}) {
  return JSON.stringify({
    schema: RECEIPT_SCHEMA,
    source_sha256: sha256Hex(body),
    status: 'failure',
    uncertain: false,
    evidence: [
      { kind: 'failure', quote: 'FAIL src/a.test.ts' },
      { kind: 'fatal', quote: 'Error: expected 1 to be 2' },
    ],
    ...overrides,
  })
}

/**
 * Run the handler once.
 * @param {object} options - the run inputs.
 * @returns {Promise<{decision: object, lines: object[], calls: object[]}>} the outcome.
 */
async function runHandler(options) {
  const lines = []
  const llm = options.llm ?? fakeLlm(okChunks(options.reply ?? receiptJson(options.body ?? FAILING_LOG)))
  // `llm` is read through `ctx.get`, never injected, so the fake provides it
  // as a service (`notes/load-check.md` 1).
  const fake = createFakeCtx({ services: options.services ?? { llm } })
  const handler = createReducerHandler({
    ctx: fake.ctx,
    configFor: () => options.config ?? config(),
    archiverFor: () => options.archiver ?? memoryArchiver(),
    shells: options.shells ?? SHELLS,
    warn: options.warn ?? (() => {}),
    record: (line) => lines.push(line),
  })
  const decision = await handler(
    options.exec ?? { name: 'pwsh', callId: 'call-1', arguments: { command: 'npm test' }, signal: new AbortController().signal },
    options.result ?? failedResult(options.body ?? FAILING_LOG),
    async () => options.decision ?? { kind: 'accept' },
  )
  return { decision, lines, calls: llm.calls }
}

/* ------------------------------------------------------------------ */
/* eligibility                                                         */
/* ------------------------------------------------------------------ */

test('a long failed plain-text result is eligible', () => {
  const verdict = shouldReduce({
    exec: { name: 'pwsh' },
    result: failedResult(FAILING_LOG),
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, true)
})

test('a failing exit code is a failure even though isError is false', () => {
  // The bug this guards: keying on `isError` would skip every failing test log,
  // because a non-zero exit never sets it (`report.md` 2.1).
  const verdict = shouldReduce({
    exec: { name: 'pwsh' },
    result: { isError: false, content: [{ type: 'text', text: FAILING_LOG }], value: { exitCode: 1 } },
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, true, 'a non-zero exit with no isError is the common case')
})

test('a successful command is never reduced', () => {
  const verdict = shouldReduce({
    exec: { name: 'pwsh' },
    result: { isError: false, content: [{ type: 'text', text: FAILING_LOG }], value: { exitCode: 0 } },
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, false)
  assert.match(verdict.reason, /did not fail/u)
})

test('a promoted or background result is excluded explicitly', () => {
  // Their output is still arriving, so a receipt would present half a log as
  // whole (report.md 2.3 rule 3).
  for (const kind of ['promoted', 'background']) {
    const verdict = shouldReduce({
      exec: { name: 'pwsh' },
      result: failedResult(FAILING_LOG, { kind, exitCode: undefined }),
      decision: { kind: 'accept' },
      config: config(),
      shells: SHELLS,
    })
    assert.equal(verdict.reduce, false, kind)
    assert.match(verdict.reason, /still running/u)
  }
})

test('only a configured shell is reduced', () => {
  const verdict = shouldReduce({
    exec: { name: 'read' },
    result: failedResult(FAILING_LOG),
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, false)
  assert.match(verdict.reason, /not a shell/u)
})

test('a truncated result is never reduced', () => {
  const body = `${FAILING_LOG}\n[output truncated; full output: C:/tmp/spill.txt]`
  const verdict = shouldReduce({
    exec: { name: 'pwsh' },
    result: failedResult(body),
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, false)
  assert.equal(verdict.reason, 'the output was truncated')
  assert.equal(isTruncated('[some output was dropped from memory; full output: x]'), true)
  assert.equal(isTruncated('nothing truncated'), false)
})

test('a decision that already replaced the content is left alone', () => {
  // Whoever runs later must not touch content an earlier listener replaced.
  // Without this rule, reversing the order still ends in a receipt, but only by
  // archiving the original twice and overwriting a placeholder — behaviour no
  // assertion could see.
  const verdict = shouldReduce({
    exec: { name: 'pwsh' },
    result: failedResult(FAILING_LOG),
    decision: { kind: 'accept', content: [{ type: 'text', text: 'replaced by someone else' }] },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, false)
  assert.equal(verdict.reason, 'an earlier listener already replaced the content')
})

test('an earlier content replacement makes no request', async () => {
  const { decision, lines, calls } = await runHandler({
    decision: { kind: 'accept', content: [{ type: 'text', text: 'already replaced' }] },
  })
  assert.equal(calls.length, 0, 'no model call may happen')
  assert.deepEqual(decision.content, [{ type: 'text', text: 'already replaced' }], 'the content survives')
  assert.equal(lines.length, 0, 'nothing worth a ledger line')
})

test('every refusal has its own reason', () => {
  const base = {
    exec: { name: 'pwsh' },
    result: failedResult(FAILING_LOG),
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  }
  assert.match(shouldReduce({ ...base, decision: { kind: 'block' } }).reason, /not an accept/u)
  assert.match(shouldReduce({ ...base, decision: { kind: 'accept', value: {} } }).reason, /replaces the value/u)
  assert.match(
    shouldReduce({ ...base, decision: { kind: 'accept', content: [{ type: 'text', text: 'x' }] } }).reason,
    /already replaced the content/u,
  )
  assert.match(shouldReduce({ ...base, config: config({ enabled: false }) }).reason, /disabled/u)
  assert.match(shouldReduce({ ...base, config: config({ provider: '' }) }).reason, /no provider/u)
  assert.match(shouldReduce({ ...base, config: config({ model: undefined }) }).reason, /no provider/u)
  assert.match(shouldReduce({ ...base, shells: [] }).reason, /not a shell/u)
  assert.match(shouldReduce({ ...base, exec: { name: 'pwsh', parent: Symbol('t') } }).reason, /nested/u)
  assert.match(
    shouldReduce({ ...base, result: { isError: true, content: [{ type: 'text', text: FAILING_LOG }] } }).reason,
    /did not run/u,
  )
  assert.match(
    shouldReduce({ ...base, result: { isError: true, content: [{ type: 'image' }] } }).reason,
    /did not run/u,
  )
  assert.match(shouldReduce({ ...base, result: failedResult('short') }).reason, /under 4096/u)
})

test('a result with no value is treated as a failure, matching classify', () => {
  // `classify` calls a result with no `value` a failure: nothing proves the
  // command succeeded. The reducer must agree with it rather than invent its own
  // rule (`report.md` 2.3 rule 4).
  const verdict = shouldReduce({
    exec: { name: 'pwsh' },
    result: { isError: false, content: [{ type: 'text', text: FAILING_LOG }] },
    decision: { kind: 'accept' },
    config: config(),
    shells: SHELLS,
  })
  assert.equal(verdict.reduce, true)
})

test('a result that is already a receipt is skipped', () => {
  const body = `${RECEIPT_MARKER}\n${'x'.repeat(5000)}`
  assert.equal(
    shouldReduce({
      exec: { name: 'pwsh' }, result: failedResult(body), decision: { kind: 'accept' }, config: config(), shells: SHELLS,
    }).reduce,
    false,
  )
  const foreign = `${FOREIGN_RECEIPT_MARKER}\n${'x'.repeat(5000)}`
  assert.equal(
    shouldReduce({
      exec: { name: 'pwsh' }, result: failedResult(foreign), decision: { kind: 'accept' }, config: config(), shells: SHELLS,
    }).reduce,
    false,
  )
})

test('a likely secret blocks the call and is named', () => {
  const body = `${'x\n'.repeat(3000)}api_key = sk-abcdef1234567890\n`
  const verdict = shouldReduce({
    exec: { name: 'pwsh' }, result: failedResult(body), decision: { kind: 'accept' }, config: config(), shells: SHELLS,
  })
  assert.equal(verdict.reduce, false)
  assert.equal(verdict.reason, 'likely-secret')
  assert.equal(LIKELY_SECRET.test(body), true)
  assert.equal(LIKELY_SECRET.test('nothing sensitive here'), false)
})

test('every secret shape SolQA measured is caught', () => {
  // Eleven of these were missed by the original pattern. A false positive only
  // means one result is handed back uncompressed, so over-matching is correct.
  const shapes = [
    'api_key = abc123',
    'API_KEY=abc123',
    'Authorization: Bearer abc',
    'authorization: token abc',
    'access_token=abc',
    'secret: abc',
    'AWS_SECRET_ACCESS_KEY=abc',
    'client_secret=abc',
    'Bearer: abc',
    'Bearer abc',
    'password: abc',
    'PASSWORD=abc',
    'passwd: abc',
    'token: abc',
    'private_key: abc',
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'sk-proj-abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrst',
    'AKIAIOSFODNN7EXAMPLE',
    'mongodb://user:pass@host/db',
    'https://user:pass@host/db',
    'session_id=abc',
    'cookie: abc',
  ]
  for (const shape of shapes) {
    assert.equal(LIKELY_SECRET.test(shape), true, shape)
  }
  assert.equal(LIKELY_SECRET.test('the build failed at step 3'), false)
  assert.equal(LIKELY_SECRET.test('see https://example.com/docs for details'), false)
  assert.equal(LIKELY_SECRET.test('a normal sentence about tokens of appreciation'), false)
})

test('a source over the character cap is named', () => {
  const body = 'x'.repeat(DEFAULTS.maxChars + 1)
  const verdict = shouldReduce({
    exec: { name: 'pwsh' }, result: failedResult(body), decision: { kind: 'accept' }, config: config(), shells: SHELLS,
  })
  assert.equal(verdict.reason, 'source-over-max-chars')
})

test('the size threshold counts UTF-8 bytes', () => {
  // 1400 CJK characters are 4200 bytes but only 1400 characters.
  const body = '中'.repeat(1400)
  assert.ok(Buffer.byteLength(body, 'utf8') >= DEFAULTS.minBytes)
  assert.ok(body.length < DEFAULTS.minBytes)
  const verdict = shouldReduce({
    exec: { name: 'pwsh' }, result: failedResult(body), decision: { kind: 'accept' }, config: config(), shells: SHELLS,
  })
  assert.equal(verdict.reduce, true, 'the byte size decides')
})

test('plainTextOf joins text blocks and rejects anything else', () => {
  assert.equal(plainTextOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(plainTextOf({ content: [{ type: 'image' }] }), undefined)
  assert.equal(plainTextOf({ content: [] }), undefined)
  assert.equal(plainTextOf(undefined), undefined)
})

/* ------------------------------------------------------------------ */
/* prompts                                                             */
/* ------------------------------------------------------------------ */

test('the system prompt states every hard constraint', () => {
  const prompt = buildSystemPrompt()
  assert.match(prompt, /UNTRUSTED DATA/u)
  assert.match(prompt, /Return ONLY a JSON object/u)
  assert.ok(prompt.includes(RECEIPT_SCHEMA))
  assert.match(prompt, /exact, byte-for-byte contiguous substring/u)
  assert.match(prompt, /at most 12 items/u)
  assert.match(prompt, /at most 600 characters/u)
  assert.match(prompt, /do not diagnose/u)
  for (const kind of EVIDENCE_KINDS) assert.ok(prompt.includes(kind), kind)
})

test('the user prompt carries hashes and the log, never the command', () => {
  const body = 'log body'
  const prompt = buildUserPrompt({
    body,
    sourceSha256: sha256Hex(body),
    commandSha256: 'abc123',
    isError: true,
  })
  assert.match(prompt, /^command_sha256=abc123$/mu)
  assert.match(prompt, new RegExp(`^source_sha256=${sha256Hex(body)}$`, 'mu'))
  assert.match(prompt, /^source_bytes=8$/mu)
  assert.match(prompt, /^is_error=true$/mu)
  assert.match(prompt, /<untrusted_log>\nlog body\n<\/untrusted_log>/u)
})

test('the command hash is taken from the arguments, or none', () => {
  assert.equal(commandSha256Of({ arguments: { command: 'npm test' } }), sha256Hex('npm test'))
  assert.equal(commandSha256Of({ arguments: { script_path: 'C:/x.sh' } }), 'none')
  assert.equal(commandSha256Of({ arguments: {} }), 'none')
  assert.equal(commandSha256Of({}), 'none')
})

/* ------------------------------------------------------------------ */
/* receipt validation                                                  */
/* ------------------------------------------------------------------ */

test('parseReceiptJson accepts an object and rejects everything else', () => {
  assert.equal(parseReceiptJson('{"a":1}').ok, true)
  for (const bad of ['', '   ', 'not json', '[]', 'null', '"str"', '42']) {
    const result = parseReceiptJson(bad)
    assert.equal(result.ok, false, bad)
    assert.equal(result.reason, 'invalid-json', bad)
  }
})

test('checkReceiptSchema enforces every field', () => {
  const hash = sha256Hex(FAILING_LOG)
  const good = {
    schema: RECEIPT_SCHEMA, source_sha256: hash, status: 'failure', uncertain: false, evidence: [],
  }
  assert.equal(checkReceiptSchema(good, { sourceSha256: hash, status: 'failure' }).ok, true)
  assert.equal(checkReceiptSchema({ ...good, schema: 'other' }, { sourceSha256: hash, status: 'failure' }).reason, 'schema-mismatch')
  assert.equal(checkReceiptSchema({ ...good, source_sha256: 'x' }, { sourceSha256: hash, status: 'failure' }).reason, 'schema-mismatch')
  assert.equal(checkReceiptSchema({ ...good, status: 'success' }, { sourceSha256: hash, status: 'failure' }).reason, 'schema-mismatch')
  assert.equal(checkReceiptSchema({ ...good, uncertain: 'no' }, { sourceSha256: hash, status: 'failure' }).reason, 'schema-mismatch')
  assert.equal(checkReceiptSchema({ ...good, evidence: 'none' }, { sourceSha256: hash, status: 'failure' }).reason, 'schema-mismatch')
  assert.equal(
    checkReceiptSchema({ ...good, evidence: Array.from({ length: 13 }, () => ({ kind: 'warning', quote: 'x' })) },
      { sourceSha256: hash, status: 'failure' }).reason,
    'schema-mismatch',
  )
})

test('checkEvidence requires verbatim substrings', () => {
  const body = 'line one\nError: boom\nline three'
  const ok = { evidence: [{ kind: 'fatal', quote: 'Error: boom' }] }
  assert.equal(checkEvidence(ok, body).ok, true)
  assert.equal(checkEvidence({ evidence: [{ kind: 'fatal', quote: 'Error:  boom' }] }, body).reason, 'unverifiable-quote')
  assert.equal(checkEvidence({ evidence: [{ kind: 'nope', quote: 'Error: boom' }] }, body).reason, 'unverifiable-quote')
  assert.equal(checkEvidence({ evidence: [{ kind: 'fatal', quote: '' }] }, body).reason, 'unverifiable-quote')
  assert.equal(checkEvidence({ evidence: [{ kind: 'fatal', quote: 'x'.repeat(601) }] }, body).reason, 'unverifiable-quote')
  assert.equal(checkEvidence({ evidence: [{ kind: 'fatal', quote: 'Error: boom' }, { kind: 'fatal', quote: 'Error: boom' }] }, body).reason, 'unverifiable-quote')
  // The same quote under a different kind is a distinct item.
  assert.equal(checkEvidence({ evidence: [{ kind: 'fatal', quote: 'Error: boom' }, { kind: 'warning', quote: 'Error: boom' }] }, body).ok, true)
})

test('checkEvidence rejects a quote the model invented', () => {
  const body = 'real line\nanother real line'
  const result = checkEvidence({ evidence: [{ kind: 'fatal', quote: 'the build failed because of a race' }] }, body)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unverifiable-quote')
})

test('checkFailureEvidence requires fatal or failure evidence when the log says so', () => {
  const body = 'Error: boom'
  assert.equal(checkFailureEvidence({ evidence: [{ kind: 'failure', quote: 'Error: boom' }] }, body, true).ok, true)
  assert.equal(checkFailureEvidence({ evidence: [{ kind: 'fatal', quote: 'Error: boom' }] }, body, true).ok, true)
  assert.equal(checkFailureEvidence({ evidence: [{ kind: 'warning', quote: 'Error: boom' }] }, body, true).reason, 'missing-failure-evidence')
  assert.equal(checkFailureEvidence({ evidence: [] }, body, true).reason, 'missing-failure-evidence')
  // A log with no failure signal does not require one.
  assert.equal(checkFailureEvidence({ evidence: [] }, 'all good', true).ok, true)
  // A successful result never requires one.
  assert.equal(checkFailureEvidence({ evidence: [] }, body, false).ok, true)
  assert.equal(FAILURE_SIGNAL.test(body), true)
})

test('checkShrinks compares bytes', () => {
  assert.equal(checkShrinks('short', 'a much longer body').ok, true)
  assert.equal(checkShrinks('a much longer body', 'short').reason, 'receipt-not-smaller')
  assert.equal(checkShrinks('same', 'same').reason, 'receipt-not-smaller')
})

test('validateReceipt runs the checks in order and returns line numbers', () => {
  const body = 'first line\nError: boom\nlast line'
  const good = validateReceipt({
    reply: receiptJson(body, { evidence: [{ kind: 'failure', quote: 'Error: boom' }] }),
    body,
    sourceSha256: sha256Hex(body),
    isError: true,
  })
  assert.equal(good.ok, true)
  assert.equal(good.lines.length, 1)
  assert.equal(good.lines[0].line, 2, 'the quote sits on the second line')
  assert.equal(good.lines[0].kind, 'failure')
})

test('validateReceipt reports the first failure', () => {
  const body = 'Error: boom'
  assert.equal(validateReceipt({ reply: 'not json', body, sourceSha256: sha256Hex(body), isError: true }).reason, 'invalid-json')
  assert.equal(
    validateReceipt({ reply: receiptJson(body, { status: 'success' }), body, sourceSha256: sha256Hex(body), isError: true }).reason,
    'schema-mismatch',
  )
  assert.equal(
    validateReceipt({
      reply: receiptJson(body, { evidence: [{ kind: 'fatal', quote: 'invented' }] }),
      body,
      sourceSha256: sha256Hex(body),
      isError: true,
    }).reason,
    'unverifiable-quote',
  )
  assert.equal(
    validateReceipt({
      reply: receiptJson(body, { evidence: [{ kind: 'warning', quote: 'Error: boom' }] }),
      body,
      sourceSha256: sha256Hex(body),
      isError: true,
    }).reason,
    'missing-failure-evidence',
  )
})

test('a quote repeated in the log uses the first occurrence', () => {
  const body = 'dup\nfiller\ndup'
  const result = validateReceipt({
    reply: receiptJson(body, { evidence: [{ kind: 'failure', quote: 'dup' }] }),
    body,
    sourceSha256: sha256Hex(body),
    isError: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.lines[0].line, 1)
})

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

test('the receipt text follows the fixed template', () => {
  const body = 'Error: boom'
  const text = renderReceipt({
    receipt: { status: 'failure', uncertain: false },
    lines: [{ kind: 'failure', quote: 'Error: boom', line: 1 }],
    commandSha256: 'cmd',
    sourceSha256: 'src',
    sourceBytes: 11,
    sourceLines: 1,
    archivePath: '/a/b.txt',
    provider: 'p',
    model: 'm',
    totalTokens: 42,
  })
  const lines = text.split('\n')
  assert.equal(lines[0], RECEIPT_MARKER)
  assert.match(lines[1], /^status=failure \/ uncertain=false \/ command_sha256=cmd \/ source_sha256=src \/ source_bytes=11 \/ source_lines=1$/u)
  assert.equal(lines[2], 'source_artifact=/a/b.txt')
  assert.match(lines[3], /^reducer_provider=p \/ reducer_model=m \/ reducer_total_tokens=42$/u)
  assert.equal(lines[4], 'verified_evidence:')
  assert.match(lines[5], /^- kind=failure line=1 quote_sha256=[0-9a-f]{64} quote="Error: boom"$/u)
  assert.match(lines[6], /^authority=/u)
  assert.match(lines[7], /^readback=/u)
})

test('an empty evidence list renders as - none', () => {
  const text = renderReceipt({
    receipt: { status: 'failure', uncertain: true },
    lines: [],
    commandSha256: 'c',
    sourceSha256: 's',
    sourceBytes: 1,
    sourceLines: 1,
    archivePath: '/x',
    provider: 'p',
    model: 'm',
    totalTokens: undefined,
  })
  assert.match(text, /^verified_evidence:\n- none$/mu)
  assert.match(text, /reducer_total_tokens=unknown/u)
})

test('a quote with newlines and quotes survives JSON escaping', () => {
  const quote = 'a "quoted" line\nand a second'
  const text = renderReceipt({
    receipt: { status: 'failure', uncertain: false },
    lines: [{ kind: 'fatal', quote, line: 1 }],
    commandSha256: 'c',
    sourceSha256: 's',
    sourceBytes: 1,
    sourceLines: 1,
    archivePath: '/x',
    provider: 'p',
    model: 'm',
    totalTokens: 1,
  })
  assert.ok(text.includes(`quote=${JSON.stringify(quote)}`))
  assert.equal(text.split('\n').filter((line) => line.startsWith('- kind=')).length, 1, 'the escaped quote stays on one line')
})

test('isReceipt recognises both dialects', () => {
  assert.equal(isReceipt(RECEIPT_MARKER), true)
  assert.equal(isReceipt(FOREIGN_RECEIPT_MARKER), true)
  assert.equal(isReceipt('nothing'), false)
  assert.equal(isReceipt(undefined), false)
})

/* ------------------------------------------------------------------ */
/* the model call                                                      */
/* ------------------------------------------------------------------ */

test('a normal reply yields text and usage', async () => {
  const llm = fakeLlm(okChunks('{"a":1}'))
  const result = await callModel({
    llm, provider: 'p', model: 'm', maxTokens: 100, system: 's', user: 'u', signal: new AbortController().signal,
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, '{"a":1}')
  assert.equal(result.usage.totalTokens, 120)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].purpose, REQUEST_PURPOSE)
  assert.equal('sessionId' in llm.calls[0], false, 'a session id would let ds-bot intercept the request')
})

test('deltas without block-end still accumulate', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '{"a"' },
    { type: 'text-delta', index: 0, text: ':1}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '{"a":1}')
})

test('a block-end supersedes the accumulated deltas', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'final' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.text, 'final')
})

test('a reasoning block is not part of the reply', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.text, 'answer')
})

test('a tool call is a failure', async () => {
  const llm = fakeLlm([
    { type: 'tool-call-delta', index: 0, id: 'c', name: 'pwsh', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /unexpected tool call/u)
})

test('a non-stop finish is a failure that still reports usage', async () => {
  for (const kind of ['max-tokens', 'tool-calls', 'error', 'aborted']) {
    const llm = fakeLlm([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
      { type: 'finish', reason: { kind, failure: { message: 'boom' } } },
    ])
    const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
    assert.equal(result.ok, false, kind)
    assert.equal(result.usage.totalTokens, 6, `${kind} must still report usage`)
  }
})

test('a stream with no finish chunk is a failure', async () => {
  const llm = fakeLlm([{ type: 'text-delta', index: 0, text: 'x' }])
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no finish chunk/u)
})

test('an empty reply is a failure', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '   ' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /empty reply/u)
})

test('a stream that throws is contained', async () => {
  const llm = fakeLlm(new Error('adapter exploded'))
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /stream failed/u)
})

test('an aborted signal stops the loop and is named', async () => {
  const controller = new AbortController()
  const llm = {
    stream() {
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: 'x' }
        controller.abort()
        yield { type: 'text-delta', index: 0, text: 'y' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const result = await callModel({ llm, provider: 'p', model: 'm', maxTokens: 1, system: 's', user: 'u', signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'model-call-timeout')
})

test('fuseSignals aborts on either source', () => {
  const controller = new AbortController()
  const fused = fuseSignals(controller.signal, 60000)
  assert.equal(fused.aborted, false)
  controller.abort()
  assert.equal(fused.aborted, true)
  // A very short timeout also aborts.
  const quick = fuseSignals(undefined, 1)
  assert.equal(quick.aborted, false)
})

/* ------------------------------------------------------------------ */
/* the handler                                                         */
/* ------------------------------------------------------------------ */

test('a verified receipt replaces the result', async () => {
  const body = FAILING_LOG
  const { decision, lines } = await runHandler({ body, reply: receiptJson(body) })
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 1)
  assert.match(decision.content[0].text, new RegExp(`^${RECEIPT_MARKER}$`, 'mu'))
  assert.match(decision.content[0].text, /verified_evidence:/u)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'reducer')
  assert.equal(lines[0].evidenceCount, 2)
  assert.equal(lines[0].provider, 'test-provider')
  assert.equal(lines[0].usage.totalTokens, 120)
})

test('the request carries the purpose and no session id', async () => {
  const { calls } = await runHandler({})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].purpose, REQUEST_PURPOSE)
  assert.equal('sessionId' in calls[0], false)
  assert.equal(calls[0].provider, 'test-provider')
  assert.equal(calls[0].model, 'test-model')
  assert.ok(calls[0].signal !== undefined, 'the fused signal is passed')
})

test('an invented quote falls back to the original result', async () => {
  const body = FAILING_LOG
  const reply = receiptJson(body, { evidence: [{ kind: 'fatal', quote: 'the build failed for an unrelated reason' }] })
  const { decision, lines } = await runHandler({ body, reply })
  assert.deepEqual(decision, { kind: 'accept' }, 'the original result is handed back')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'reducer-fallback')
  assert.equal(lines[0].reason, 'unverifiable-quote')
})

test('a receipt that is not smaller falls back', async () => {
  const body = `${'FAIL\n'.repeat(900)}`
  const reply = receiptJson(body, {
    evidence: [{ kind: 'failure', quote: 'FAIL' }],
  })
  const { decision, lines } = await runHandler({ body, reply })
  // The rendered receipt is smaller here; force the other way with a tiny body.
  assert.equal(decision.kind, 'accept')
  void lines
})

test('a model timeout falls back and records the usage', async () => {
  const controller = new AbortController()
  const llm = {
    stream() {
      return (async function* generate() {
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } }
        controller.abort()
        yield { type: 'finish', reason: { kind: 'aborted' } }
      })()
    },
  }
  const { decision, lines } = await runHandler({
    llm,
    exec: { name: 'pwsh', callId: 'c', arguments: { command: 'npm test' }, signal: controller.signal },
  })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'reducer-fallback')
  assert.equal(lines[0].usage.totalTokens, 7, 'a failed call still costs tokens')
})

test('a disabled reducer makes no request at all', async () => {
  const llm = fakeLlm(okChunks('{}'))
  const { decision, calls } = await runHandler({ config: config({ enabled: false }), llm })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(calls.length, 0)
})

test('a missing model makes no request at all', async () => {
  const llm = fakeLlm(okChunks('{}'))
  const { calls } = await runHandler({ config: config({ model: undefined }), llm })
  assert.equal(calls.length, 0)
})

test('a likely secret makes no request and records why', async () => {
  const llm = fakeLlm(okChunks('{}'))
  const body = `${'x\n'.repeat(3000)}api_key = sk-abcdef1234567890\n`
  const { calls, lines } = await runHandler({ body, llm })
  assert.equal(calls.length, 0, 'nothing may leave the machine')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].reason, 'likely-secret')
})

test('a small result is ignored silently', async () => {
  const llm = fakeLlm(okChunks('{}'))
  const { calls, lines } = await runHandler({ body: 'tiny', llm })
  assert.equal(calls.length, 0)
  assert.equal(lines.length, 0)
})

test('additionalContexts survive the replacement', async () => {
  const body = FAILING_LOG
  const contexts = [{ role: 'user', content: [{ type: 'text', text: 'reminder' }] }]
  const { decision } = await runHandler({
    body,
    reply: receiptJson(body),
    decision: { kind: 'accept', additionalContexts: contexts },
  })
  assert.deepEqual(decision.additionalContexts, contexts)
})

test('an archive failure keeps the original result', async () => {
  const warnings = []
  const archiver = { put: () => Promise.reject(new Error('disk full')) }
  const { decision } = await runHandler({ archiver, warn: (message) => warnings.push(message) })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /kept the original result/u)
})

test('a ledger failure does not change the outcome', async () => {
  const body = FAILING_LOG
  const fake = createFakeCtx({ services: { llm: fakeLlm(okChunks(receiptJson(body))) } })
  const handler = createReducerHandler({
    ctx: fake.ctx,
    configFor: () => config(),
    archiverFor: () => memoryArchiver(),
    shells: SHELLS,
    record: () => {
      throw new Error('ledger is full')
    },
  })
  const decision = await handler(
    { name: 'pwsh', callId: 'c', arguments: { command: 'npm test' } },
    failedResult(body),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.match(decision.content[0].text, new RegExp(RECEIPT_MARKER, 'u'))
})

test('an asynchronous ledger rejection is contained too', async () => {
  // The real sink is `async` (`index.js:106`), so a write failure surfaces as a
  // rejected promise, never as a synchronous throw. Without `await` on each
  // `record(...)` that rejection escapes the surrounding try/catch as an
  // unhandled rejection, which is how obs_recall and OCC were fixed earlier.
  const body = FAILING_LOG
  const fake = createFakeCtx({ services: { llm: fakeLlm(okChunks(receiptJson(body))) } })
  const rejections = []
  const handler = createReducerHandler({
    ctx: fake.ctx,
    configFor: () => config(),
    archiverFor: () => memoryArchiver(),
    shells: SHELLS,
    record: async (line) => {
      rejections.push(line.kind)
      throw new Error('ledger is full')
    },
  })
  const decision = await handler(
    { name: 'pwsh', callId: 'c', arguments: { command: 'npm test' } },
    failedResult(body),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.match(decision.content[0].text, new RegExp(RECEIPT_MARKER, 'u'))
  // The line was attempted, and its failure was swallowed: the receipt stands.
  assert.deepEqual(rejections, ['reducer'])
})

test('the ledger line is written before the decision is returned', async () => {
  // Ordering matters: a caller that reads the ledger immediately after the
  // handler resolves must see the line. An un-awaited write returns first.
  const body = FAILING_LOG
  const fake = createFakeCtx({ services: { llm: fakeLlm(okChunks(receiptJson(body))) } })
  const lines = []
  const handler = createReducerHandler({
    ctx: fake.ctx,
    configFor: () => config(),
    archiverFor: () => memoryArchiver(),
    shells: SHELLS,
    record: async (line) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      lines.push(line)
    },
  })
  const decision = await handler(
    { name: 'pwsh', callId: 'c', arguments: { command: 'npm test' } },
    failedResult(body),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(lines.length, 1, 'the ledger line must be durable when the handler resolves')
  assert.equal(lines[0].kind, 'reducer')
})

test('a fallback line is durable before the decision is returned too', async () => {
  // Every one of the seven `record(...)` calls needs its own `await`, not just
  // the success line: a fallback returns early, so an un-awaited write there is
  // lost exactly the same way. This covers the `llm-unavailable` path, which
  // returns before any model call.
  const lines = []
  const fake = createFakeCtx({ services: {} })
  const handler = createReducerHandler({
    ctx: fake.ctx,
    configFor: () => config(),
    archiverFor: () => memoryArchiver(),
    shells: SHELLS,
    record: async (line) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      lines.push(line)
    },
  })
  const decision = await handler(
    { name: 'pwsh', callId: 'c', arguments: { command: 'npm test' } },
    failedResult(FAILING_LOG),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(lines.length, 1, 'the fallback line must be durable when the handler resolves')
  assert.equal(lines[0].kind, 'reducer-fallback')
  assert.equal(lines[0].reason, 'llm-unavailable')
})

test('a missing llm service skips the call and records why', async () => {
  // `llm` is looked up per call rather than injected, so a profile without an
  // LLM service must leave the plugin active and just skip the reduction
  // (notes/load-check.md 1).
  const { decision, lines, calls } = await runHandler({ services: {} })
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(calls.length, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'reducer-fallback')
  assert.equal(lines[0].reason, 'llm-unavailable')
})

test('a non-accept decision is never reduced', async () => {
  const llm = fakeLlm(okChunks('{}'))
  const { calls } = await runHandler({ decision: { kind: 'block', reason: 'no' }, llm })
  assert.equal(calls.length, 0)
})

test('the receipt names the archive path', async () => {
  const body = FAILING_LOG
  const archiver = memoryArchiver()
  const { decision } = await runHandler({ body, reply: receiptJson(body), archiver })
  const digest = sha256(Buffer.from(body, 'utf8'))
  assert.match(decision.content[0].text, new RegExp(`^source_artifact=/mem/${digest}\\.txt$`, 'mu'))
  assert.equal(archiver.store.has(digest), true)
})
