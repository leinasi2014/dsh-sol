/**
 * Action Fusion: run a verification command in the same call as the edit.
 *
 * Registers `edit_then_run` and `write_then_run` as **plain definitions** —
 * not `defineTool` — because this plugin imports no `@deepseek-ai/*` package
 * (`report.md` 3.2). The cost is explicit: `ctx.tools.register` validates only
 * `output.schema` and `render` (`asar:dsh-tools/lib/index.js:2974-2982`), so the
 * model's arguments reach `execute` verbatim and this module validates them
 * itself, refusing undeclared keys instead of dropping them in silence — the
 * same trade dsh-ops makes (`dsh-ops:lib/shells.js:800-831`).
 *
 * Both steps run through nested `ctx.tools.execute({ ..., parent: exec.token })`
 * so they pass the same pre-execute approval, guards, sandbox policy and
 * timeouts as a direct model call (`report.md` 2.1). Nothing here calls
 * `ctx.shell`: that would use the deployment's default sandbox rather than the
 * session's, and would not ask for approval
 * (`asar:dsh-pwsh-sandbox/lib/index.js:140-148`).
 *
 * **Result shape.** A plain definition's body returns a *value* that must match
 * its own `output.schema`; the pipeline then calls `output.render(args, value)`
 * and that text is what the model sees
 * (`asar:dsh-tools/lib/index.js:3637-3666`). So this module never hands the
 * inner edit result back as an object: it renders the inner text into its own
 * `text` field, which is what makes the edit's output survive verbatim.
 *
 * @module dsh-sol/fusion
 */

import { readFile } from 'node:fs/promises'

/** Tool name for the edit variant. */
export const EDIT_TOOL_NAME = 'edit_then_run'

/** Tool name for the write variant. */
export const WRITE_TOOL_NAME = 'write_then_run'

/** Argument names `then_run` accepts. `script_path` is deliberately absent. */
export const THEN_RUN_KEYS = Object.freeze(['command', 'timeout'])

/** Argument names `edit` accepts. The escalation pair is never forwarded. */
export const EDIT_KEYS = Object.freeze(['file_path', 'old_string', 'new_string', 'replace_all'])

/** Argument names `write` accepts. The escalation pair is never forwarded. */
export const WRITE_KEYS = Object.freeze(['file_path', 'content'])

/**
 * The four outcome markers.
 *
 * `skipped` is decided before any shell call; {@link classify} never returns it.
 */
export const MARKERS = Object.freeze({
  succeeded: 'succeeded',
  failed: 'failed',
  notRun: 'not_run',
  skipped: 'skipped',
})

/**
 * Error raised for arguments this tool refuses.
 *
 * Distinct from a Fusion malfunction so the two can be reported differently: a
 * bad argument means the model must fix the call, and nothing has run yet.
 */
export class FusionArgsError extends Error {
  /**
   * @param {string} message - what is wrong and what is accepted.
   */
  constructor(message) {
    super(message)
    this.name = 'FusionArgsError'
  }
}

/**
 * Reject arguments this tool does not declare.
 *
 * Mirrors `dsh-ops:lib/shells.js:821-831`: the plain-definition registration
 * path performs no argument validation, so reading known fields with `args?.x`
 * would silently ignore anything else and report success.
 *
 * @param {unknown} args - the model's arguments.
 * @param {readonly string[]} known - accepted names.
 * @param {string} where - the dotted path used in the message.
 * @returns {Record<string, unknown>} the argument object.
 * @throws {FusionArgsError} when the value is not an object or carries an undeclared key.
 */
export function assertKnownArguments(args, known, where) {
  if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new FusionArgsError(`invalid ${where}: expected an object, got ${JSON.stringify(args)}`)
  }
  const unknown = Object.keys(args).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    const names = unknown.map((key) => JSON.stringify(key)).join(', ')
    throw new FusionArgsError(
      `invalid ${where}: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${names}; `
      + `this tool accepts ${known.join(', ')}`,
    )
  }
  return /** @type {Record<string, unknown>} */ (args)
}

/**
 * Read a required string.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {string} key - the field name.
 * @param {string} where - the dotted path used in the message.
 * @param {boolean} [allowEmpty] - whether an empty string is valid.
 * @returns {string} the value.
 */
function requiredString(args, key, where, allowEmpty = false) {
  const value = args[key]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new FusionArgsError(
      `invalid ${where}.${key}: expected a ${allowEmpty ? '' : 'non-empty '}string, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * Read an optional boolean.
 * @param {Record<string, unknown>} args - the arguments.
 * @param {string} key - the field name.
 * @param {string} where - the dotted path used in the message.
 * @returns {boolean|undefined} the value.
 */
function optionalBoolean(args, key, where) {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new FusionArgsError(`invalid ${where}.${key}: expected a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate the `then_run` object.
 *
 * Only `{command, timeout}` is accepted. `script_path` is refused on purpose:
 * `ops_bash` rejects a call carrying both `command` and `script_path`
 * (`dsh-ops:lib/shells.js:1032-1034`), so accepting it here would let this tool
 * build a call the shell always refuses.
 *
 * @param {unknown} raw - the raw `then_run` value.
 * @returns {{command: string, timeout: number|undefined}} the validated request.
 * @throws {FusionArgsError} for a malformed value.
 */
export function parseThenRun(raw) {
  const args = assertKnownArguments(raw, THEN_RUN_KEYS, 'then_run')
  const command = requiredString(args, 'command', 'then_run')
  if (command.trim().length === 0) {
    throw new FusionArgsError('invalid then_run.command: expected a non-empty string')
  }
  const timeout = args.timeout
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new FusionArgsError(
        `invalid then_run.timeout: expected a positive finite number of milliseconds, got ${JSON.stringify(timeout)}`,
      )
    }
  }
  return { command, timeout: timeout === undefined ? undefined : Number(timeout) }
}

/**
 * Validate the `edit` arguments and split them off from `then_run`.
 * @param {unknown} raw - the model's arguments.
 * @returns {{inner: Record<string, unknown>, thenRun: {command: string, timeout: number|undefined}}} the parts.
 * @throws {FusionArgsError} for a malformed call.
 */
export function parseEditArgs(raw) {
  const args = assertKnownArguments(raw, [...EDIT_KEYS, 'then_run'], 'arguments')
  const replaceAll = optionalBoolean(args, 'replace_all', 'arguments')
  return {
    inner: {
      file_path: requiredString(args, 'file_path', 'arguments'),
      old_string: requiredString(args, 'old_string', 'arguments'),
      new_string: requiredString(args, 'new_string', 'arguments', true),
      ...replaceAll === undefined ? {} : { replace_all: replaceAll },
    },
    thenRun: parseThenRun(args.then_run),
  }
}

/**
 * Validate the `write` arguments and split them off from `then_run`.
 * @param {unknown} raw - the model's arguments.
 * @returns {{inner: Record<string, unknown>, thenRun: {command: string, timeout: number|undefined}}} the parts.
 * @throws {FusionArgsError} for a malformed call.
 */
export function parseWriteArgs(raw) {
  const args = assertKnownArguments(raw, [...WRITE_KEYS, 'then_run'], 'arguments')
  return {
    inner: {
      file_path: requiredString(args, 'file_path', 'arguments'),
      content: requiredString(args, 'content', 'arguments', true),
    },
    thenRun: parseThenRun(args.then_run),
  }
}

/**
 * Classify one nested shell result.
 *
 * The input is the **complete** materialized result from `ctx.tools.execute`
 * (`{isError, content, value?, error?}`), never the bare `value`
 * (`report.md` 2.1).
 *
 * Order matters and is load-bearing:
 *
 * 1. `isError` — the command did not run. Non-zero exits never set it
 *    (`asar:dsh-tool-pwsh/lib/index.js:132-136`).
 * 2. `kind` `"promoted"` / `"background"` — still running. These results carry
 *    no `exitCode` and no `timedOut` (`:503-535`), so testing the exit code first
 *    would call them a success.
 * 3. `timedOut` — the command was killed by its deadline. This is checked
 *    **before** `error`, because a shell that timed out while preparing may also
 *    report a spawn error; the deadline is the more specific fact.
 * 4. `value.error` — the shell could not even start the process. `ops_bash`
 *    returns `{error, timedOut, timeoutMs, stdout, stderr}` with **no**
 *    `exitCode` on a spawn failure (`dsh-ops/lib/shells.js:1098-1105`), so
 *    testing the exit code first would call it a success — the worst direction
 *    to be wrong in, because the model would believe the command ran.
 * 5. `value.signal` — killed by a signal before it could exit. `ops_bash` omits
 *    `exitCode` when the process had none and reports `signal` instead
 *    (`dsh-ops/lib/shells.js:1091-1092`), so without this branch a killed
 *    process would read as success for the same reason a spawn failure did.
 * 6. `exitCode === 0` — success, and only that. A clean exit really does carry
 *    `exitCode: 0`: `ops_bash` writes the key whenever the subprocess reported
 *    a number (`dsh-ops/lib/shells.js:1091`), the subprocess service resolves a
 *    plain numeric code from the child's `exit` event
 *    (`asar:dsh-subprocess-local/lib/index.js:480-495`), and both `pwsh` and
 *    `bash` always emit the key (`asar:dsh-tool-pwsh/lib/index.js:268-279`,
 *    `asar:dsh-tool-bash/lib/index.js:296-307`). A key is omitted only for an
 *    *unknown* exit fact — killed by a signal, or never spawned
 *    (`dsh-ops/CHANGELOG.md:255`) — which steps 4 and 5 already caught.
 *    So "no exit code" is never read as success: that reading is what made the
 *    live bug possible (`notes/live-load-2b.md`).
 * 7. Anything else — failure. A `null` exit code only appears for a killed or
 *    timed-out run, which steps 3 and 5 already caught.
 *
 * The order is the one written into `report.md` 2.1; only `isError` is checked
 * before `kind` here, because a result with `isError` set never carries a usable
 * `value`.
 *
 * The rule across all of them: a success must be **proved** by an exit code.
 * "No evidence" is never read as success — that is exactly the shape that
 * produced the live bug.
 *
 * @param {object|undefined} result - the nested call's result.
 * @returns {'not_run'|'succeeded'|'failed'} the classification.
 */
export function classify(result) {
  if (result === null || typeof result !== 'object') return MARKERS.failed
  if (result.isError === true) return MARKERS.notRun
  const value = result.value
  if (value === null || typeof value !== 'object') {
    // No value means nothing proves the command succeeded.
    return MARKERS.failed
  }
  if (value.kind === 'promoted' || value.kind === 'background') return MARKERS.failed
  if (value.timedOut === true) return MARKERS.failed
  if (spawnErrorOf(result) !== undefined) return MARKERS.notRun
  if (value.signal !== undefined && value.signal !== null) return MARKERS.failed
  if (value.exitCode === 0) return MARKERS.succeeded
  return MARKERS.failed
}

/**
 * The shell's own failure text for a result that never started a process.
 *
 * `ops_bash` puts a ready-made message in `value.error`
 * (`dsh-ops/lib/shells.js:1166-1175`); passing it through verbatim is better
 * than inventing a reason, because it already names the missing executable and
 * the remedy.
 *
 * @param {object|undefined} result - the nested call's result.
 * @returns {string|undefined} the message, when there is one.
 */
export function spawnErrorOf(result) {
  const value = result?.value
  const error = value?.error
  if (typeof error === 'string' && error.length > 0) return error
  return undefined
}

/**
 * Build the marker text for one outcome.
 * @param {string} classification - one of the `MARKERS` values.
 * @param {string} [detail] - a short reason, appended when present.
 * @returns {string} the marker line.
 */
export function thenRunMarker(classification, detail) {
  const base = `[then_run:${classification}]`
  return typeof detail === 'string' && detail.length > 0 ? `${base} ${detail}` : base
}

/**
 * The text blocks of a nested result, joined.
 *
 * The shell's own `content` already carries truncation notices and spill paths
 * (`asar:dsh-tool-pwsh/lib/index.js:141-144`, `dsh-ops:lib/shells.js:844-847`),
 * so it is passed through verbatim rather than rebuilt — rebuilding would
 * duplicate the notice.
 *
 * @param {object} result - a nested call result.
 * @returns {string} the joined text.
 */
export function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * The short reason appended to a marker, when there is one.
 * @param {object} result - the nested shell result.
 * @param {string} classification - the output of {@link classify}.
 * @returns {string|undefined} the reason.
 */
export function reasonOf(result, classification) {
  if (classification === MARKERS.notRun) {
    // The shell's own message first: on a spawn failure `ops_bash` puts the
    // missing executable and the remedy in `value.error`, and the outer
    // `result.error` only says the tool failed.
    const spawnError = spawnErrorOf(result)
    if (spawnError !== undefined) return spawnError
    const message = result?.error?.message
    if (typeof message === 'string' && message.length > 0) return message
    return 'the command did not run'
  }
  if (classification === MARKERS.failed) {
    const value = result?.value
    if (value?.kind === 'promoted' || value?.kind === 'background') return 'the command is still running'
    if (value?.timedOut === true) return `timed out after ${String(value.timeoutMs)}ms`
    if (value?.signal !== undefined && value?.signal !== null) return `killed by signal: ${String(value.signal)}`
    if (value?.exitCode !== undefined) return `exit code: ${String(value.exitCode)}`
  }
  return undefined
}

/**
 * Whether one output schema describes a result {@link classify} can read.
 *
 * `classify` reads `result.value` as an object: `exitCode`, `signal`,
 * `timedOut`, `kind`, `error`. A shell whose value is a string cannot be read
 * that way, and would be classified `failed` on success (`notes/load-check.md`,
 * the persistent-shell row). Probing before use is `report.md` 3.7 rule 1.
 *
 * A schema counts as readable when every shape it admits is an object. Both
 * real forms qualify:
 * - a plain object schema — `ops_bash`
 *   (`dsh-ops/lib/shells.js:890-891`, `type: 'object'`);
 * - a `oneOf` of object schemas — the built-in `pwsh` and `bash`
 *   (`asar:dsh-tool-pwsh/lib/index.js:503-508`,
 *   `asar:dsh-tool-bash/lib/index.js:530-535`), whose top level carries **no**
 *   `type` at all, so a bare `schema.type === 'object'` test would wrongly
 *   reject them.
 *
 * A string-valued shell declares `type: 'string'`
 * (`asar:dsh-tool-pwsh-persistent/lib/index.js:350`,
 * `asar:dsh-tool-bash-persistent/lib/index.js:345`) and is rejected.
 *
 * @param {unknown} schema - the definition's `output.schema`.
 * @returns {boolean} whether `classify` can read this shell's value.
 */
export function readsObjectValue(schema) {
  if (schema === null || typeof schema !== 'object') return false
  if (schema.type === 'object') return true
  // `oneOf` / `anyOf`: every admitted shape must be an object, otherwise some
  // result of this shell could be unreadable.
  for (const key of ['oneOf', 'anyOf']) {
    const branches = schema[key]
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.every((branch) => readsObjectValue(branch))
    }
  }
  return false
}

/**
 * Pick the first registered shell from the configured order.
 *
 * `scope` must be the calling agent: `ops_bash` is registered on the agent
 * scope, and `get(name)` without a scope reads the global view and returns
 * `undefined` (`asar:dsh-tools/lib/index.js:3092`,
 * `dsh-ops:lib/session-shells.js:72,87-91`). The lookup happens on every call
 * and is never cached, because the tool can be withdrawn when the session's
 * permission changes (`dsh-ops:lib/session-shells.js:18-25,108`).
 *
 * A definition is accepted only when its output schema is one {@link classify}
 * can read (`readsObjectValue`). `get` returns the definition exactly as it was
 * registered — `register` validates it and hands the same object to the layer
 * (`asar:dsh-tools/lib/index.js:2974-2982`,
 * `asar:dsh-scope/lib/index.js:27-31`), and `get` returns that same reference
 * (`asar:dsh-tools/lib/index.js:3091-3093`) — so `output.schema` is available
 * here without a second lookup.
 *
 * @param {object} tools - the `ctx.tools` service.
 * @param {readonly string[]} shells - the configured candidate names, in order.
 * @param {unknown} scope - the calling agent.
 * @returns {{name: string, definition: object}|undefined} the chosen shell.
 */
export function pickShell(tools, shells, scope) {
  for (const name of shells) {
    const definition = tools.get(name, scope)
    if (definition === undefined || definition === null) continue
    if (!readsObjectValue(definition.output?.schema)) continue
    return { name, definition }
  }
  return undefined
}

/**
 * Build the arguments for one shell.
 *
 * The two shells declare different schemas: `pwsh` requires a non-empty
 * `description` (`asar:dsh-tool-pwsh/lib/index.js:469-473,251`), while
 * `ops_bash` accepts `command` alone and refuses a call carrying both `command`
 * and `script_path` (`dsh-ops:lib/shells.js:1027-1034`). `script_path` is never
 * sent, so that conflict cannot arise.
 *
 * @param {string} name - the shell tool name.
 * @param {{command: string, timeout: number|undefined}} thenRun - the validated request.
 * @param {string} filePath - the file that was just modified, used for the description.
 * @returns {Record<string, unknown>} the arguments.
 */
export function shellArguments(name, thenRun, filePath) {
  const args = { command: thenRun.command }
  if (thenRun.timeout !== undefined) args.timeoutMs = thenRun.timeout
  if (name === 'pwsh') {
    // pwsh validates description as a non-empty string before it runs anything.
    return { description: `Verify after editing ${filePath}`, ...args }
  }
  return args
}

/**
 * Build a nested execution input.
 *
 * The shape follows the PTC sub-dispatch example
 * (`asar:dsh-tools/lib/index.js:1368-1377`): a fresh `callId`, the outer
 * `rootCallId`, the calling agent, and `parent: exec.token` so the registry
 * treats this as a nested call rather than a direct model call.
 *
 * The signal is always present. The registry reads `callerSignal.aborted`
 * directly (`asar:dsh-tools/lib/index.js:3372-3377`), so passing `undefined`
 * when the outer call had none would throw a `TypeError` instead of running the
 * command. A fresh controller's signal is never aborted, which is exactly the
 * semantics of "the caller had no cancellation".
 *
 * @param {object} outer - the outer execution context.
 * @param {string} name - the tool to call.
 * @param {Record<string, unknown>} args - its arguments.
 * @param {number} index - 1 for the first step, 2 for the second.
 * @returns {object} the input for `ctx.tools.execute`.
 */
export function nestedExecution(outer, name, args, index) {
  return {
    callId: `${String(outer?.callId ?? 'sol')}:sol:${index}`,
    rootCallId: outer?.rootCallId ?? outer?.callId,
    name,
    arguments: args,
    ...outer?.agent === undefined ? {} : { agent: outer.agent },
    parent: outer?.token,
    signal: outer?.signal ?? new AbortController().signal,
  }
}

/**
 * Whether the file on disk still matches what the edit wrote.
 *
 * A mismatch means something changed the file after the edit, so the command
 * would verify the wrong content. A read failure is **not** a mismatch: the path
 * may be unreadable from the host (sandbox, remote execution world), and
 * refusing to verify on that basis would break the common case.
 *
 * @param {string} path - the file path the edit reported.
 * @param {unknown} after - the content the edit reported writing.
 * @param {Function} [read] - the reader, injectable for tests.
 * @returns {Promise<'unchanged'|'changed'|'unreadable'>} the verdict.
 */
export async function verifyUnchanged(path, after, read = readFile) {
  if (typeof path !== 'string' || path.length === 0) return 'unreadable'
  if (typeof after !== 'string') return 'unreadable'
  try {
    const current = await read(path, 'utf8')
    return current === after ? 'unchanged' : 'changed'
  } catch {
    return 'unreadable'
  }
}

/**
 * Build the fusion value that satisfies {@link OUTPUT_SCHEMA}.
 * @param {object} input - the fields.
 * @param {string} input.marker - the outcome marker.
 * @param {string} input.text - the complete model-facing text.
 * @param {string} [input.path] - the modified file.
 * @param {string} [input.shell] - the shell tool used.
 * @param {string} [input.command] - the command that ran.
 * @param {string} [input.jobId] - a background job id, when one exists.
 * @param {number} [input.exitCode] - the exit code, when one exists.
 * @returns {object} the value.
 */
export function fusionValue({ marker, text, path, shell, command, jobId, exitCode }) {
  return {
    marker,
    text,
    ...typeof path === 'string' ? { path } : {},
    ...typeof shell === 'string' ? { shell } : {},
    ...typeof command === 'string' ? { command } : {},
    ...typeof jobId === 'string' ? { jobId } : {},
    ...typeof exitCode === 'number' ? { exitCode } : {},
  }
}

/**
 * Compose the model-facing text for one completed call.
 * @param {string} editText - the inner edit result's text, verbatim.
 * @param {string[]} lines - the fusion lines to append.
 * @returns {string} the text.
 */
export function composeText(editText, lines) {
  const parts = []
  if (typeof editText === 'string' && editText.length > 0) parts.push(editText)
  for (const line of lines) {
    if (typeof line === 'string' && line.length > 0) parts.push(line)
  }
  return parts.join('\n')
}

/** The `then_run` parameter schema, shared by both variants. */
export const THEN_RUN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', description: 'Verification command to run after the file is written.' },
    timeout: { type: 'number', description: 'Timeout in milliseconds; passed to the shell as timeoutMs.' },
  },
})

/** The value schema both variants declare. */
export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['marker', 'text'],
  properties: {
    marker: {
      type: 'string',
      enum: [MARKERS.succeeded, MARKERS.failed, MARKERS.notRun, MARKERS.skipped],
    },
    text: { type: 'string' },
    path: { type: 'string' },
    shell: { type: 'string' },
    command: { type: 'string' },
    jobId: { type: 'string' },
    exitCode: { type: 'integer' },
  },
})

/**
 * Build the plain tool definition for one variant.
 *
 * Registered through `ctx.tools.register`, so the definition must supply
 * `name`, `description`, `parameters` (model-facing JSON Schema) and
 * `output.render` (`asar:dsh-tools/lib/index.js:2974-2982`). The schema uses
 * only the supported subset: `type`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`.
 *
 * @param {object} options - the definition inputs.
 * @param {string} options.name - the tool name.
 * @param {'edit'|'write'} options.variant - which file tool it wraps.
 * @param {object} options.ctx - the plugin context.
 * @param {() => readonly string[]} options.shells - the shell candidates, read per call.
 * @param {Function} [options.read] - file reader, injectable for tests.
 * @returns {object} the definition for `ctx.tools.register`.
 */
export function defineFusionTool({ name, variant, ctx, shells, read = readFile }) {
  const isEdit = variant === 'edit'
  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: isEdit
      ? ['file_path', 'old_string', 'new_string', 'then_run']
      : ['file_path', 'content', 'then_run'],
    properties: isEdit
      ? {
        file_path: { type: 'string', description: 'Path to edit, resolved by the filesystem backend.' },
        old_string: { type: 'string', description: 'Literal text to replace.' },
        new_string: { type: 'string', description: 'Literal replacement text; an empty string deletes the match.' },
        replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false.' },
        then_run: THEN_RUN_SCHEMA,
      }
      : {
        file_path: { type: 'string', description: 'Path to write, resolved by the filesystem backend.' },
        content: { type: 'string', description: 'Full UTF-8 text content to write.' },
        then_run: THEN_RUN_SCHEMA,
      },
  }

  return {
    name,
    description: isEdit
      ? 'Edit a file by replacing literal text, then run a verification command in the same call. '
        + 'Both steps go through the normal approval and sandbox policy. '
        + 'The result is marked [then_run:succeeded|failed|not_run|skipped].'
      : 'Write a file, then run a verification command in the same call. '
        + 'Both steps go through the normal approval and sandbox policy. '
        + 'The result is marked [then_run:succeeded|failed|not_run|skipped].',
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    /**
     * Run the edit, then the command.
     * @param {object} args - the model's arguments.
     * @param {object} exec - the execution context.
     * @returns {Promise<object>} a value matching {@link OUTPUT_SCHEMA}.
     */
    async execute(args, exec) {
      return runFusion({ ctx, variant, args, exec, shells, read })
    },
  }
}

/**
 * The shared body of both fusion tools.
 *
 * Failure policy (`report.md` 3.7 rule 3):
 * - A malformed argument throws, so the pipeline reports it and nothing ran.
 * - A failed inner edit throws with the edit's own message, so the model sees
 *   exactly what a direct `edit` call would have told it, and the command never
 *   runs.
 * - Fusion's own malfunction after a successful edit returns the edit's text
 *   plus one explanation line: the model keeps the edit it already paid for.
 *
 * @param {object} options - the call inputs.
 * @param {object} options.ctx - the plugin context.
 * @param {'edit'|'write'} options.variant - which file tool to call.
 * @param {object} options.args - the model's arguments.
 * @param {object} options.exec - the outer execution context.
 * @param {() => readonly string[]} options.shells - the shell candidates.
 * @param {Function} options.read - file reader.
 * @returns {Promise<object>} the value.
 */
export async function runFusion({ ctx, variant, args, exec, shells, read }) {
  // Argument validation happens before anything runs: a malformed call must
  // leave the file untouched (report.md 2.1).
  const parsed = variant === 'edit' ? parseEditArgs(args) : parseWriteArgs(args)
  const { inner, thenRun } = parsed

  const editResult = await ctx.tools.execute(nestedExecution(exec, variant, inner, 1))
  if (editResult?.isError === true) {
    // The file was not changed, so there is nothing to verify. Throw so the
    // caller sees a failure, carrying the edit's own message.
    const message = typeof editResult?.error?.message === 'string' && editResult.error.message.length > 0
      ? editResult.error.message
      : 'the file could not be modified'
    const error = new Error(message)
    // Only the failure identity is attached: keeping the whole result would hold
    // the file contents on the error object for no benefit.
    error.cause = {
      message,
      ...editResult?.error?.info === undefined ? {} : { code: editResult.error.info.code },
    }
    throw error
  }

  const editText = textOf(editResult)
  const path = typeof editResult?.value?.path === 'string' ? editResult.value.path : inner.file_path
  const after = editResult?.value?.after

  try {
    const verdict = await verifyUnchanged(path, after, read)
    if (verdict === 'changed') {
      const line = thenRunMarker(MARKERS.skipped, 'the file changed after the edit, so the command was not run')
      return fusionValue({ marker: MARKERS.skipped, text: composeText(editText, [line]), path })
    }
    // `unreadable` is not a mismatch: the host may not be able to read the path.
    // Run the command and say so, rather than silently skipping verification.
    const note = verdict === 'unreadable'
      ? ['Note: could not re-read the file to confirm it is unchanged.']
      : []
    return await runShell({ ctx, exec, shells, thenRun, filePath: path, editText, note })
  } catch (error) {
    const line = thenRunMarker(
      MARKERS.notRun,
      `dsh-sol could not verify the file: ${String(error?.message ?? error)}`,
    )
    return fusionValue({ marker: MARKERS.notRun, text: composeText(editText, [line]), path })
  }
}

/**
 * Resolve a shell, run the command, and compose the value.
 * @param {object} options - the call inputs.
 * @param {object} options.ctx - the plugin context.
 * @param {object} options.exec - the outer execution context.
 * @param {() => readonly string[]} options.shells - the shell candidates.
 * @param {{command: string, timeout: number|undefined}} options.thenRun - the command.
 * @param {string} options.filePath - the modified file.
 * @param {string} options.editText - the inner edit result's text.
 * @param {string[]} options.note - extra explanation lines.
 * @returns {Promise<object>} the value.
 */
async function runShell({ ctx, exec, shells, thenRun, filePath, editText, note }) {
  let candidates
  try {
    candidates = [...shells()]
  } catch (error) {
    const line = thenRunMarker(MARKERS.notRun, `dsh-sol could not read its shell list: ${String(error?.message ?? error)}`)
    return fusionValue({ marker: MARKERS.notRun, text: composeText(editText, [line]), path: filePath })
  }

  let picked
  try {
    picked = pickShell(ctx.tools, candidates, exec?.agent)
  } catch (error) {
    const line = thenRunMarker(MARKERS.notRun, `dsh-sol could not look up a shell: ${String(error?.message ?? error)}`)
    return fusionValue({ marker: MARKERS.notRun, text: composeText(editText, [line]), path: filePath })
  }
  if (picked === undefined) {
    const line = thenRunMarker(
      MARKERS.notRun,
      `no shell tool whose result dsh-sol can read is available (tried ${candidates.join(', ')})`,
    )
    return fusionValue({ marker: MARKERS.notRun, text: composeText(editText, [line]), path: filePath })
  }

  let shellResult
  try {
    shellResult = await ctx.tools.execute(
      nestedExecution(exec, picked.name, shellArguments(picked.name, thenRun, filePath), 2),
    )
  } catch (error) {
    const line = thenRunMarker(MARKERS.notRun, `the shell call failed: ${String(error?.message ?? error)}`)
    return fusionValue({ marker: MARKERS.notRun, text: composeText(editText, [line]), path: filePath })
  }

  const classification = classify(shellResult)
  const marker = thenRunMarker(classification, reasonOf(shellResult, classification))
  const shellText = textOf(shellResult)
  const lines = [...note, marker]
  const jobId = typeof shellResult?.value?.jobId === 'string' ? shellResult.value.jobId : undefined
  if (jobId !== undefined) {
    lines.push(
      `The command is still running in the background as job ${jobId}. `
      + 'Read its newer output with job_output, or stop it with job_kill.',
    )
  }
  if (shellText.length > 0) lines.push(shellText)

  const exitCode = typeof shellResult?.value?.exitCode === 'number' ? shellResult.value.exitCode : undefined
  return fusionValue({
    marker: classification,
    text: composeText(editText, lines),
    path: filePath,
    shell: picked.name,
    command: thenRun.command,
    jobId,
    exitCode,
  })
}

/**
 * Mount both fusion tools.
 *
 * @param {object} ctx - a context providing `tools`.
 * @param {object} options - the resolved configuration.
 * @param {readonly string[]} options.shells - the shell candidates, in order.
 * @param {Function} [options.read] - file reader, injectable for tests.
 * @returns {Function} the disposer removing both registrations.
 */
export function mountFusion(ctx, options) {
  const { shells, read = readFile } = options ?? {}
  const candidates = () => shells
  const disposers = [
    ctx.tools.register(defineFusionTool({
      name: EDIT_TOOL_NAME, variant: 'edit', ctx, shells: candidates, read,
    })),
    ctx.tools.register(defineFusionTool({
      name: WRITE_TOOL_NAME, variant: 'write', ctx, shells: candidates, read,
    })),
  ]
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // One failing disposer must not block the other.
      }
    }
  }
}
