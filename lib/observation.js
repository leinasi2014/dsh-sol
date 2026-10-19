/**
 * ObservationPack: replace a large tool result with a stable handle that can be
 * read back page by page.
 *
 * The replacement happens in `tools/post-execute`, so the placeholder is what
 * the session log records and what every later request carries
 * (`report.md` 2.2, `notes/step3-facts.md` 1). The full text goes to the
 * content-addressed archive first, so nothing is lost.
 *
 * Two identities are involved and they are deliberately different
 * (`notes/step34-spec.md` 2.2):
 *
 * - the **archive key** is the plain content hash, so identical bytes are stored
 *   once no matter how many times they appear;
 * - the **observation id** mixes the tool name and call id in, so the same bytes
 *   seen in two different calls get two ids the model cannot confuse.
 *
 * The placeholder is a pure function of `(toolName, callId, content)`: no
 * timestamp, no counter, no randomness. The same result replaced twice produces
 * byte-identical text, which is what keeps the request prefix stable.
 *
 * Paging is byte-oriented and never splits a UTF-8 character, so concatenating
 * the pages reproduces the original bytes exactly (`report.md` 3.6).
 *
 * @module dsh-sol/observation
 */

import { createHash } from 'node:crypto'

/** Default threshold: 10 KiB, matching SoL-Pi (`report.md` 2.2). */
export const DEFAULT_THRESHOLD_BYTES = 10 * 1024

/** The header lines of a page reserve this much of the page budget. */
export const PAGE_HEADER_BYTES = 512

/** Largest chunk a single `obs_recall` call returns, in bytes. */
export const MAX_PAGE_BYTES = 16 * 1024 - PAGE_HEADER_BYTES

/** Largest chunk a single `obs_recall` call returns, in lines. */
export const MAX_PAGE_LINES = 398

/** Bytes of complete lines kept at each end of the placeholder. */
export const PREVIEW_BYTES = 512

/** The tool name the model uses to read a handle back. */
export const RECALL_TOOL_NAME = 'obs_recall'

/** Grammar of an observation id: `obs_` plus 24 lowercase hex characters. */
export const OBSERVATION_ID_PATTERN = /^obs_[0-9a-f]{24}$/u

/**
 * Tools whose results are never replaced.
 *
 * `read` and `obs_recall` would loop or double-archive; the two Fusion tools are
 * excluded because their text mixes the edit report with the command output, and
 * replacing it would hide which half is which (`report.md` 2.2).
 */
export const NEVER_REPLACE = Object.freeze([
  'read',
  RECALL_TOOL_NAME,
  'edit_then_run',
  'write_then_run',
])

/**
 * The receipt marker Reducer writes, plus the one SoL-Pi writes.
 *
 * A result carrying one is never replaced: the receipt is already a compressed
 * summary whose evidence must stay intact. The SoL-Pi entry is the **whole**
 * marker, not the `sol_pi_` prefix: a result that merely mentions the project
 * name would otherwise be skipped for no reason.
 */
export const RECEIPT_MARKERS = Object.freeze(['dsh-sol_evidence_receipt_v1', 'sol_pi_evidence_receipt_v1'])

/**
 * Derive the observation id for one occurrence.
 *
 * `toolName\0callId\0contentHash` keeps the id stable for a given call while
 * separating identical content seen in different calls
 * (`notes/step34-spec.md` 2.2).
 *
 * @param {object} input - the identity inputs.
 * @param {string} input.toolName - the tool that produced the result.
 * @param {string} input.callId - the call id.
 * @param {string} input.contentHash - the content's sha256.
 * @returns {string} the observation id.
 */
export function observationId({ toolName, callId, contentHash }) {
  const seed = `${String(toolName)}\u0000${String(callId)}\u0000${String(contentHash)}`
  return `obs_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

/**
 * Whether a string is a well-formed observation id.
 * @param {unknown} id - the candidate.
 * @returns {boolean} true when it matches `obs_` plus 24 lowercase hex.
 */
export function isValidObservationId(id) {
  return typeof id === 'string' && OBSERVATION_ID_PATTERN.test(id)
}

/**
 * Whether a UTF-8 continuation byte starts at this index.
 * @param {Buffer} buffer - the bytes.
 * @param {number} index - the index to test.
 * @returns {boolean} true when `buffer[index]` is a continuation byte.
 */
function isContinuation(buffer, index) {
  if (index < 0 || index >= buffer.length) return false
  return (buffer[index] & 0b1100_0000) === 0b1000_0000
}

/**
 * Move an index backwards to the start of a UTF-8 character.
 * @param {Buffer} buffer - the bytes.
 * @param {number} index - the candidate index.
 * @returns {number} the adjusted index.
 */
export function alignToCharacterStart(buffer, index) {
  let cursor = Math.max(0, Math.min(index, buffer.length))
  while (cursor > 0 && isContinuation(buffer, cursor)) cursor -= 1
  return cursor
}

/**
 * Move an index forwards to the start of the next UTF-8 character.
 * @param {Buffer} buffer - the bytes.
 * @param {number} index - the candidate index.
 * @returns {number} the adjusted index.
 */
export function alignToCharacterEnd(buffer, index) {
  let cursor = Math.max(0, Math.min(index, buffer.length))
  while (cursor < buffer.length && isContinuation(buffer, cursor)) cursor += 1
  return cursor
}

/**
 * Count the newlines in a byte range.
 * @param {Buffer} buffer - the bytes.
 * @param {number} start - inclusive start.
 * @param {number} end - exclusive end.
 * @returns {number} the count.
 */
function countNewlines(buffer, start, end) {
  let count = 0
  for (let index = start; index < end; index += 1) {
    if (buffer[index] === 0x0a) count += 1
  }
  return count
}

/**
 * Find the end of the chunk starting at `start`, respecting both caps.
 *
 * The byte cap is checked first, then the line cap; the result is moved back to a
 * UTF-8 character boundary so a character is never split
 * (`notes/step34-spec.md` 2.4 steps 4-6).
 *
 * @param {Buffer} buffer - the bytes.
 * @param {number} start - the chunk start.
 * @param {number} maxBytes - the byte cap.
 * @param {number} maxLines - the line cap.
 * @returns {number} the exclusive chunk end.
 */
function chunkEnd(buffer, start, maxBytes, maxLines) {
  const hardEnd = alignToCharacterStart(buffer, Math.min(start + maxBytes, buffer.length))
  if (hardEnd <= start) return start
  if (maxLines <= 0) return hardEnd
  const newlines = countNewlines(buffer, start, hardEnd)
  if (newlines < maxLines) return hardEnd
  let seen = 0
  for (let index = start; index < hardEnd; index += 1) {
    if (buffer[index] === 0x0a) {
      seen += 1
      if (seen === maxLines) return index + 1
    }
  }
  return hardEnd
}

/**
 * Read one chunk of an archived observation.
 *
 * `offset` is a byte offset. The chunk ends at whichever cap is hit first, moved
 * back to a character boundary.
 *
 * An offset that lands in the middle of a UTF-8 character is **refused**, not
 * rounded. Rounding forward would silently drop the character it skipped, which
 * breaks the invariant that concatenating every chunk reproduces the original
 * byte for byte. The only offsets this tool produces are its own `nextOffset`
 * values, so a misaligned offset means the caller made one up.
 *
 * @param {object} input - the request.
 * @param {Buffer|string} input.content - the full archived content.
 * @param {number} [input.offset] - the byte offset to start at.
 * @returns {{text: string, offset: number, bytes: number, lines: number, nextOffset: number, eof: boolean}} the chunk.
 * @throws {RangeError} when the offset is outside the content or not on a character boundary.
 */
export function readPage({ content, offset = 0 }) {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  const total = buffer.length
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) {
    throw new RangeError(`offset ${String(offset)} is beyond the end of observation (${String(total)} bytes)`)
  }
  if (offset < total && offset > 0 && isContinuation(buffer, offset)) {
    throw new RangeError(
      `offset ${String(offset)} is inside a multi-byte character; `
      + 'use the next_offset returned by the previous call',
    )
  }
  const start = offset
  if (start >= total) {
    return { text: '', offset: start, bytes: 0, lines: 0, nextOffset: total, eof: true }
  }
  const end = chunkEnd(buffer, start, MAX_PAGE_BYTES, MAX_PAGE_LINES)
  const slice = buffer.subarray(start, end)
  return {
    text: slice.toString('utf8'),
    offset: start,
    bytes: slice.length,
    lines: countNewlines(buffer, start, end),
    nextOffset: end,
    eof: end >= total,
  }
}

/**
 * Count the lines in some bytes.
 * @param {Buffer} buffer - the bytes.
 * @returns {number} the line count, counting a trailing partial line.
 */
function countLines(buffer) {
  if (buffer.length === 0) return 0
  const newlines = countNewlines(buffer, 0, buffer.length)
  return buffer[buffer.length - 1] === 0x0a ? newlines : newlines + 1
}

/**
 * Take the longest run of complete lines from the start that fits a budget.
 * @param {Buffer} buffer - the bytes.
 * @param {number} budget - the byte budget.
 * @returns {Buffer} the head preview.
 */
function headCompleteLines(buffer, budget) {
  const limit = alignToCharacterStart(buffer, Math.min(budget, buffer.length))
  if (limit >= buffer.length) return buffer
  // Walk back to the last newline at or before the limit.
  let end = limit
  while (end > 0 && buffer[end - 1] !== 0x0a) end -= 1
  if (end === 0) return buffer.subarray(0, limit)
  return buffer.subarray(0, end)
}

/**
 * Take the longest run of complete lines from the end that fits a budget.
 * @param {Buffer} buffer - the bytes.
 * @param {number} budget - the byte budget.
 * @returns {Buffer} the tail preview.
 */
function tailCompleteLines(buffer, budget) {
  const floor = alignToCharacterEnd(buffer, Math.max(0, buffer.length - budget))
  if (floor <= 0) return buffer
  let start = floor
  while (start < buffer.length && buffer[start - 1] !== 0x0a) start += 1
  if (start >= buffer.length) return buffer.subarray(floor)
  return buffer.subarray(start)
}

/**
 * Build the stable placeholder for one archived observation.
 *
 * The template is fixed (`notes/step34-spec.md` 2.2): only the `{{}}` values
 * change, and every value is derived from the call, so the same result replaced
 * twice yields byte-identical text.
 *
 * @param {object} input - the placeholder inputs.
 * @param {string} input.id - the observation id.
 * @param {Buffer|string} input.content - the full content.
 * @param {string} input.toolName - the tool that produced the result.
 * @param {number} [input.previewBytes] - the head and tail preview budget.
 * @returns {string} the placeholder text.
 */
export function buildPlaceholder({ id, content, toolName, previewBytes = PREVIEW_BYTES }) {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  const head = headCompleteLines(buffer, previewBytes)
  const tail = tailCompleteLines(buffer, previewBytes)
  const lines = countLines(buffer)
  const estimatedTokens = Math.ceil(buffer.length / 4)
  const omittedBytes = Math.max(0, buffer.length - head.length - tail.length)
  return [
    '[large tool result replaced; the original is archived and readable]',
    `id: ${id}`,
    `tool: ${String(toolName)}`,
    `original_bytes: ${String(buffer.length)}`,
    `original_lines: ${String(lines)}`,
    `estimated_tokens: ${String(estimatedTokens)}`,
    `retrieve: call ${RECALL_TOOL_NAME} with {"id":"${id}","offset":0}; continue with the returned next_offset`,
    '[first complete lines, up to 512 bytes]',
    head.toString('utf8'),
    '[middle omitted; last complete lines, up to 512 bytes]',
    tail.toString('utf8'),
    `[${String(omittedBytes)} original bytes omitted]`,
  ].join('\n')
}

/**
 * The text of a tool result, when it is replaceable.
 *
 * Only plain text qualifies: images are not text, so a byte page over them would
 * be meaningless (`report.md` 2.2).
 *
 * @param {object} result - the tool result.
 * @returns {string|undefined} the joined text, or undefined when not replaceable.
 */
export function replaceableText(result) {
  if (result === null || typeof result !== 'object') return undefined
  if (result.isError === true) return undefined
  const content = result.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') return undefined
    if (block.type !== 'text') return undefined
    if (typeof block.text !== 'string') return undefined
    parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Whether the text carries a Reducer receipt.
 * @param {string} text - the result text.
 * @returns {boolean} true when a receipt marker is present.
 */
export function hasReceipt(text) {
  if (typeof text !== 'string') return false
  return RECEIPT_MARKERS.some((marker) => text.includes(marker))
}

/**
 * Decide whether one result should be replaced.
 * @param {object} input - the decision inputs.
 * @param {object} input.exec - the execution context.
 * @param {object} input.result - the tool result.
 * @param {number} input.thresholdBytes - the size above which replacement happens.
 * @returns {{replace: boolean, reason: string, text?: string}} the decision.
 */
export function shouldReplace({ exec, result, thresholdBytes = DEFAULT_THRESHOLD_BYTES }) {
  if (result?.isError === true) return { replace: false, reason: 'the result is an error' }
  if (exec?.parent !== undefined) return { replace: false, reason: 'the call is nested' }
  const name = typeof exec?.name === 'string' ? exec.name : ''
  if (NEVER_REPLACE.includes(name)) return { replace: false, reason: `the ${name} tool is never replaced` }
  const text = replaceableText(result)
  if (text === undefined) return { replace: false, reason: 'the result is not plain text' }
  if (hasReceipt(text)) return { replace: false, reason: 'the result carries a reducer receipt' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes < thresholdBytes) return { replace: false, reason: `the result is under ${String(thresholdBytes)} bytes` }
  return { replace: true, reason: 'the result is large enough', text }
}

/**
 * Build the post-execute handler.
 *
 * A waterfall listener: it returns `next()`'s decision when it replaces nothing,
 * and preserves `additionalContexts` when it does, or it would swallow another
 * plugin's reminder (`notes/step3-facts.md` 2). Any failure returns the decision
 * untouched (`report.md` 3.7 rule 3).
 *
 * @param {object} options - the handler inputs.
 * @param {Function} options.archiverFor - returns the archiver for one execution.
 * @param {number} [options.thresholdBytes] - the replacement threshold.
 * @param {Function} [options.warn] - a warning sink.
 * @param {Function} [options.record] - a ledger sink, called once per replacement.
 * @returns {Function} the waterfall listener.
 */
export function createObservationHandler({
  archiverFor,
  thresholdBytes = DEFAULT_THRESHOLD_BYTES,
  warn = () => {},
  record = () => {},
}) {
  /**
   * @param {object} exec - the execution context.
   * @param {object} result - the tool result.
   * @param {Function} next - the next listener.
   * @returns {Promise<object>} the decision.
   */
  return async function observationPostExecute(exec, result, next) {
    const decision = await next()
    try {
      if (decision?.kind !== 'accept') return decision
      if (decision.value !== undefined) return decision
      // Judge what the model is about to see, not the raw tool result. An
      // earlier step in the chain (the Reducer) may already have replaced the
      // content with a receipt; looking at `result` would replace that receipt
      // with a placeholder and lose the evidence the receipt carries
      // (`report.md` 2.2: a receipt is never replaced).
      const current = decision.content === undefined ? result : { ...result, content: decision.content }
      const verdict = shouldReplace({ exec, result: current, thresholdBytes })
      if (!verdict.replace) return decision

      const archiver = archiverFor(exec)
      const contentHash = archiver.digestOf(verdict.text)
      const id = observationId({
        toolName: exec?.name,
        callId: exec?.callId,
        contentHash,
      })
      const stored = await archiver.putObservation(verdict.text)
      const placeholder = buildPlaceholder({ id, content: verdict.text, toolName: exec?.name })
      const originalBytes = Buffer.byteLength(verdict.text, 'utf8')

      // The ledger line is the only record of which archive key an id names, so
      // it must be durable before the model can see the placeholder: a
      // placeholder whose lookup was never written is a lost result. The write
      // is awaited for that reason, and a failed write keeps the original
      // untouched (`report.md` 3.4).
      await record({
        kind: 'observation',
        sessionId: exec?.agent?.session?.header?.id,
        id,
        tool: exec?.name,
        callId: exec?.callId,
        originalBytes,
        originalLines: countLines(Buffer.from(verdict.text, 'utf8')),
        placeholderBytes: Buffer.byteLength(placeholder, 'utf8'),
        omittedBytes: originalBytes - Buffer.byteLength(placeholder, 'utf8'),
        archiveKey: stored.digest,
        requestSeq: exec?.agent?.session?.seq,
      })

      return {
        kind: 'accept',
        content: [{ type: 'text', text: placeholder }],
        ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
      }
    } catch (error) {
      warn(`dsh-sol observation: kept the original result: ${String(error?.message ?? error)}`)
      return decision
    }
  }
}

/** The output schema of `obs_recall`, restricted to the supported keyword subset. */
export const RECALL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['text', 'id', 'offset', 'bytes', 'lines', 'nextOffset', 'eof'],
  properties: {
    text: { type: 'string' },
    id: { type: 'string' },
    offset: { type: 'integer' },
    bytes: { type: 'integer' },
    lines: { type: 'integer' },
    nextOffset: { type: 'integer' },
    eof: { type: 'boolean' },
  },
})

/**
 * Compose the text `obs_recall` returns for one chunk.
 * @param {object} input - the chunk.
 * @param {string} input.id - the observation id.
 * @param {number} input.offset - the chunk's start.
 * @param {number} input.bytes - the chunk size.
 * @param {number} input.lines - the chunk's line count.
 * @param {number} input.nextOffset - where the next chunk starts.
 * @param {boolean} input.eof - whether this is the end.
 * @param {string} input.chunk - the chunk text.
 * @returns {string} the text.
 */
export function recallText({ id, offset, bytes, lines, nextOffset, eof, chunk }) {
  const tail = eof
    ? `[chunk_bytes=${String(bytes)} chunk_lines=${String(lines)}; end of observation]`
    : `[chunk_bytes=${String(bytes)} chunk_lines=${String(lines)}; use next_offset to continue]`
  return [
    `[obs_recall id=${id} offset=${String(offset)} next_offset=${String(nextOffset)} eof=${String(eof)}]`,
    tail,
    chunk,
  ].join('\n')
}

/**
 * Build the `obs_recall` tool definition.
 *
 * Registered as a plain object (`report.md` 3.2), so the arguments are validated
 * here. It takes only `id` and `offset`: the page size is fixed, so there is one
 * fewer thing for the model to get wrong (`notes/step34-spec.md` 2.3).
 *
 * @param {object} options - the definition inputs.
 * @param {Function} options.archiverFor - returns the archiver for one execution.
 * @param {Function} [options.record] - a ledger sink for recall lines.
 * @returns {object} the definition for `ctx.tools.register`.
 */
export function defineRecallTool({ archiverFor, record = () => {} }) {
  return {
    name: RECALL_TOOL_NAME,
    description: 'Read back an archived large tool result by byte offset. '
      + 'Call with the id from a "[large tool result replaced" placeholder. '
      + 'Continue with next_offset until eof is true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Observation id, e.g. obs_0123456789abcdef01234567.' },
        offset: { type: 'integer', description: 'Byte offset to start at. Defaults to 0.' },
      },
    },
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    /**
     * Read one chunk.
     * @param {object} args - the model's arguments.
     * @param {object} exec - the execution context.
     * @returns {Promise<object>} the chunk value.
     */
    async execute(args, exec) {
      const unknown = Object.keys(args ?? {}).filter((key) => !['id', 'offset'].includes(key))
      if (unknown.length > 0) {
        throw new Error(
          `unknown argument ${unknown.map((key) => JSON.stringify(key)).join(', ')}; `
          + 'accepted arguments are "id", "offset"',
        )
      }
      const id = args?.id
      if (!isValidObservationId(id)) {
        throw new Error('invalid observation id: expected obs_ followed by 24 hex characters')
      }
      const offset = args?.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error(`invalid offset: expected a non-negative integer, got ${JSON.stringify(args?.offset)}`)
      }

      const archiver = archiverFor(exec)
      const content = await archiver.getByObservation(id)
      if (content === undefined) {
        throw new Error(
          `unknown observation id ${id}: it may belong to another session or have been cleaned up`,
        )
      }
      const page = readPage({ content, offset })
      const text = recallText({ ...page, id, chunk: page.text })
      try {
        // Awaited, like the replacement's line: a fire-and-forget write would
        // leave the read unrecorded when the process ends right after, and the
        // audit trail is the whole point of this line.
        await record({
          kind: 'observation-recall',
          sessionId: exec?.agent?.session?.header?.id,
          id,
          offset: page.offset,
          bytes: page.bytes,
          eof: page.eof,
        })
      } catch {
        // A ledger failure must not break the read.
      }
      return {
        text,
        id,
        offset: page.offset,
        bytes: page.bytes,
        lines: page.lines,
        nextOffset: page.nextOffset,
        eof: page.eof,
      }
    },
  }
}

/**
 * Mount ObservationPack on a context.
 *
 * Unused by `index.js`, which composes the post-execute handler itself so the
 * plugin registers exactly one listener. Kept only as a convenience would invite
 * a second registration of the same handler, so it is deliberately absent
 * (simplicity audit).
 */
