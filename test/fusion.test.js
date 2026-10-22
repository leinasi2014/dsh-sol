import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertKnownArguments,
  classify,
  composeText,
  EDIT_KEYS,
  EDIT_TOOL_NAME,
  defineFusionTool,
  FusionArgsError,
  fusionValue,
  MARKERS,
  mountFusion,
  nestedExecution,
  OUTPUT_SCHEMA,
  parseEditArgs,
  parseThenRun,
  parseWriteArgs,
  pickShell,
  reasonOf,
  readsObjectValue,
  shellArguments,
  spawnErrorOf,
  THEN_RUN_KEYS,
  thenRunMarker,
  textOf,
  verifyUnchanged,
  WRITE_KEYS,
  WRITE_TOOL_NAME,
} from '../lib/fusion.js'
import { createFakeCtx, createFakeTools } from './fake-ctx.js'

/*
 * Real shell definitions, by their output schemas.
 *
 * `pickShell` accepts a shell only when `classify` can read its value, which it
 * decides from `output.schema`. These three shapes are the real ones, so a
 * fixture that claims "a shell is available" has to carry the schema the real
 * shell declares — otherwise the test would be asserting against a shape no
 * profile produces.
 */

/** `ops_bash`: a plain object schema (`dsh-ops/lib/shells.js:890-891`). */
const OPS_BASH_DEF = Object.freeze({
  name: 'ops_bash',
  output: { schema: { type: 'object', additionalProperties: false, required: ['timedOut', 'timeoutMs', 'stdout', 'stderr'] } },
})

/**
 * The built-in `pwsh`: a `oneOf` of object schemas with **no** top-level `type`
 * (`asar:dsh-tool-pwsh/lib/index.js:503-508`).
 */
const PWSH_DEF = Object.freeze({
  name: 'pwsh',
  output: { schema: { oneOf: [{ type: 'object', additionalProperties: false }, { type: 'object', additionalProperties: false }] } },
})

/** The built-in `bash`: same shape as `pwsh` (`asar:dsh-tool-bash/lib/index.js:530-535`). */
const BASH_DEF = Object.freeze({
  name: 'bash',
  output: { schema: { oneOf: [{ type: 'object', additionalProperties: false }, { type: 'object', additionalProperties: false }] } },
})

/**
 * The persistent `pwsh` from the minimal preset: its value is a string
 * (`asar:dsh-tool-pwsh-persistent/lib/index.js:349-354`), which `classify`
 * cannot read.
 */
const PERSISTENT_PWSH_DEF = Object.freeze({
  name: 'pwsh',
  output: { schema: { type: 'string' } },
})

/**
 * A fake outer execution context shaped like the real one
 * (`asar:dsh-tools/lib/index.js:3227-3250`).
 * @param {object} [overrides] - fields to override.
 * @returns {object} the execution context.
 */
function outerExec(overrides = {}) {
  const agent = { id: 'agent-1', session: { header: { id: 'session-1' } } }
  return {
    token: Symbol('dsh.tool.execution'),
    callId: 'call-1',
    rootCallId: 'call-1',
    name: EDIT_TOOL_NAME,
    signal: new AbortController().signal,
    agent,
    ...overrides,
  }
}

/**
 * A materialized success result, shaped like the pipeline's
 * (`asar:dsh-tools/lib/index.js:3686-3705`).
 * @param {object} value - the tool's value.
 * @param {string} [text] - the rendered text.
 * @returns {object} the result.
 */
function ok(value, text = 'done') {
  return { isError: false, content: [{ type: 'text', text }], value }
}

/**
 * A materialized error result (`asar:dsh-tools/lib/index.js:3712-3726`).
 * @param {string} message - the error message.
 * @param {object} [info] - the structured info.
 * @returns {object} the result.
 */
function err(message, info) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, ...info === undefined ? {} : { info } },
  }
}

/**
 * An edit result as the fs tool returns it
 * (`asar:dsh-tool-fs/lib/index.js:714-733`).
 * @param {string} after - the written content.
 * @param {string} [path] - the reported path.
 * @returns {object} the result.
 */
function editOk(after, path = 'C:/w/a.txt') {
  return ok({ path, before: 'old', after }, `The file ${path} has been updated.`)
}

/**
 * Mount the fusion tools against a fake context.
 * @param {object} [options] - the harness options.
 * @param {Record<string, object>} [options.visible] - tools `get` can see.
 * @param {Record<string, Function>} [options.results] - nested results by name.
 * @param {readonly string[]} [options.shells] - the shell candidates.
 * @param {Function} [options.read] - the file reader.
 * @returns {object} the harness.
 */
function harness({ visible, results, shells = ['ops_bash', 'pwsh', 'bash'], read } = {}) {
  const fake = createFakeCtx()
  const fakeTools = createFakeTools({ visible, results })
  fake.ctx.tools = fakeTools.tools
  const dispose = mountFusion(fake.ctx, {
    shells,
    read: read ?? (async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  })
  const byName = new Map(fakeTools.registered.map((definition) => [definition.name, definition]))
  return { ...fake, fakeTools, dispose, byName, exec: outerExec() }
}

/* ------------------------------------------------------------------ */
/* 1. classify — order-sensitive, 11 cases                             */
/* ------------------------------------------------------------------ */

test('1.1 a clean exit classifies as succeeded', () => {
  assert.equal(classify(ok({ kind: 'foreground', exitCode: 0 })), MARKERS.succeeded)
})

test('1.2 a non-zero exit classifies as failed, and is not an isError', () => {
  assert.equal(classify(ok({ kind: 'foreground', exitCode: 1 })), MARKERS.failed)
})

test('1.3 a clean exit carries exitCode 0 and classifies as succeeded', () => {
  // The real shape of a clean `ops_bash` exit: `exitCode: 0` is present, because
  // `shells.js:1091` writes the key whenever the subprocess reported a number and
  // the subprocess service resolves a numeric code from the child's `exit` event
  // (`asar:dsh-subprocess-local/lib/index.js:480-495`). Live 2b ran `cat s2/g1.txt`
  // through exactly this shape.
  const value = { exitCode: 0, timedOut: false, timeoutMs: 120000 }
  assert.equal('exitCode' in value, true)
  assert.equal(classify(ok(value)), MARKERS.succeeded)
})

test('1.4 a timeout classifies as failed', () => {
  assert.equal(classify(ok({ kind: 'foreground', timedOut: true, exitCode: null })), MARKERS.failed)
})

test('1.5 a promoted result classifies as failed even without exitCode or timedOut', () => {
  const value = { kind: 'promoted', jobId: 'job-1', timeoutMs: 120000, output: '' }
  assert.equal('exitCode' in value, false)
  assert.equal('timedOut' in value, false)
  assert.equal(classify(ok(value)), MARKERS.failed)
})

test('1.6 a background result classifies as failed', () => {
  assert.equal(classify(ok({ kind: 'background', jobId: 'job-2', cwd: 'C:/x' })), MARKERS.failed)
})

test('1.7 a policy or user rejection classifies as not_run', () => {
  assert.equal(classify(err('the user rejected tool "pwsh"')), MARKERS.notRun)
})

test('1.8 a pre-dispatch abort classifies as not_run', () => {
  assert.equal(
    classify(err('tool call aborted before dispatch', { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' })),
    MARKERS.notRun,
  )
})

test('1.9 a mid-flight abort classifies as not_run', () => {
  assert.equal(classify(err('tool call aborted', { name: 'AbortError', code: 'ABORTED' })), MARKERS.notRun)
})

test('1.10 a null exit code without timedOut still classifies as failed', () => {
  assert.equal(classify(ok({ kind: 'foreground', exitCode: null })), MARKERS.failed)
})

test('1.11 a result with no value cannot prove success', () => {
  assert.equal(classify({ isError: false }), MARKERS.failed)
  assert.equal(classify({ isError: false, content: [] }), MARKERS.failed)
  assert.equal(classify(undefined), MARKERS.failed)
  assert.equal(classify(null), MARKERS.failed)
})

test('1.12 a shell that never started is not_run, not succeeded', () => {
  // `ops_bash` returns this exact shape when the process cannot be spawned: an
  // `error` string and NO `exitCode` (`dsh-ops/lib/shells.js:1098-1105`). Treating
  // a missing exit code as success made the model believe a command ran when
  // nothing had (`notes/live-load-2b.md`).
  const spawnFailure = {
    isError: false,
    content: [{ type: 'text', text: '[error: bash could not be started (ENOENT)]' }],
    value: {
      error: 'bash executable is unavailable (ENOENT): bash.exe. Install bash or use pwsh.',
      timedOut: false,
      timeoutMs: 120000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    },
  }
  assert.equal('exitCode' in spawnFailure.value, false, 'the fixture must not carry an exit code')
  assert.equal(classify(spawnFailure), MARKERS.notRun)
  assert.equal(
    reasonOf(spawnFailure, MARKERS.notRun),
    'bash executable is unavailable (ENOENT): bash.exe. Install bash or use pwsh.',
    'the shell\'s own message is passed through verbatim',
  )
})

test('1.13 an empty or non-string value.error does not flip the verdict', () => {
  // Only a real message counts; a null field must not turn a clean exit into
  // not_run.
  assert.equal(classify(ok({ kind: 'foreground', exitCode: 0, error: null })), MARKERS.succeeded)
  assert.equal(classify(ok({ kind: 'foreground', exitCode: 0, error: '' })), MARKERS.succeeded)
  assert.equal(spawnErrorOf({ value: { error: null } }), undefined)
  assert.equal(spawnErrorOf({ value: { error: '' } }), undefined)
  assert.equal(spawnErrorOf({ value: {} }), undefined)
  assert.equal(spawnErrorOf(undefined), undefined)
})

test('1.14 a process killed by a signal is failed, not succeeded', () => {
  // `ops_bash` omits `exitCode` when the process had none and reports `signal`
  // instead (`dsh-ops/lib/shells.js:1091-1092`). Without an explicit branch this
  // shape falls into "exitCode absent means success", the same hole as 1.12.
  const killed = ok({ signal: 'SIGTERM', timedOut: false, timeoutMs: 120000 })
  assert.equal('exitCode' in killed.value, false, 'the fixture must not carry an exit code')
  assert.equal(classify(killed), MARKERS.failed)
  assert.equal(reasonOf(killed, MARKERS.failed), 'killed by signal: SIGTERM')
})

test('1.14b a signal outranks a zero exit code', () => {
  // The one shape where the `signal` branch still changes the verdict: a shell
  // that reports both. `pwsh` always emits `exitCode` and `signal` together
  // (`asar:dsh-tool-pwsh/lib/index.js:268-279`), so a zero code with a signal
  // would otherwise read as success. The signal is the more specific fact.
  const both = ok({ kind: 'foreground', exitCode: 0, signal: 'SIGKILL', timedOut: false, timeoutMs: 1 })
  assert.equal(classify(both), MARKERS.failed)
  assert.equal(reasonOf(both, MARKERS.failed), 'killed by signal: SIGKILL')
})

test('1.15 an exitCode key that is missing is not read as success', () => {
  // This pins the rule the live 2b bug broke: "no exit code" is never success.
  // A clean exit really carries `exitCode: 0` (`dsh-ops/lib/shells.js:1091`,
  // `asar:dsh-subprocess-local/lib/index.js:480-495`, and both `pwsh` and `bash`
  // always emit the key), so the absent-key shape only appears for an unknown
  // exit fact — killed by a signal, or never spawned — both of which are failures
  // or not-runs. Reading absence as success is what produced the live bug.
  assert.equal(classify(ok({ timedOut: false, timeoutMs: 120000 })), MARKERS.failed)
  assert.equal(classify(ok({ timedOut: false, timeoutMs: 120000, signal: null })), MARKERS.failed)
})

test('1.16 a timeout outranks a spawn error, matching report.md 2.1', () => {
  // The shell can time out while preparing and also report an error in the same
  // result (`dsh-ops/lib/shells.js:1098-1105` puts `timedOut` in the catch
  // payload). `report.md` 2.1 checks `timedOut` before `error`, so the deadline
  // wins and the marker says `failed`.
  const both = ok({ error: 'bash could not be started: workspace preparation timed out', timedOut: true, timeoutMs: 5000 })
  assert.equal(classify(both), MARKERS.failed)
  assert.equal(reasonOf(both, MARKERS.failed), 'timed out after 5000ms')
})

test('1.17 the full order matches report.md 2.1 case for case', () => {
  // A table of every combination the two shells can produce, so a reordering of
  // the branches cannot pass unnoticed.
  const table = [
    [{ kind: 'promoted' }, MARKERS.failed],
    [{ kind: 'background' }, MARKERS.failed],
    [{ timedOut: true, timeoutMs: 1 }, MARKERS.failed],
    [{ timedOut: true, timeoutMs: 1, error: 'x' }, MARKERS.failed],
    [{ error: 'bash could not be started' }, MARKERS.notRun],
    [{ signal: 'SIGKILL' }, MARKERS.failed],
    [{ signal: 'SIGTERM', timedOut: false, timeoutMs: 1 }, MARKERS.failed],
    [{ exitCode: 0, signal: 'SIGKILL' }, MARKERS.failed],
    [{ exitCode: 0 }, MARKERS.succeeded],
    [{ exitCode: 1 }, MARKERS.failed],
    [{ exitCode: null }, MARKERS.failed],
    [{ timedOut: false, timeoutMs: 1 }, MARKERS.failed],
    [{ timedOut: false, timeoutMs: 1, signal: null }, MARKERS.failed],
  ]
  for (const [value, expected] of table) {
    assert.equal(classify(ok(value)), expected, JSON.stringify(value))
  }
})

test('the marker text is stable for every classification', () => {
  assert.equal(thenRunMarker(MARKERS.succeeded), '[then_run:succeeded]')
  assert.equal(thenRunMarker(MARKERS.failed), '[then_run:failed]')
  assert.equal(thenRunMarker(MARKERS.notRun), '[then_run:not_run]')
  assert.equal(thenRunMarker(MARKERS.skipped), '[then_run:skipped]')
  assert.equal(thenRunMarker(MARKERS.failed, 'exit code: 1'), '[then_run:failed] exit code: 1')
  assert.equal(thenRunMarker(MARKERS.failed, ''), '[then_run:failed]')
})

/* ------------------------------------------------------------------ */
/* 2. a failed edit never runs the command                             */
/* ------------------------------------------------------------------ */

test('2.1 a failed edit runs no command and surfaces the edit message', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: { edit: async () => err('old_string not found') },
  })
  const tool = h.byName.get(EDIT_TOOL_NAME)
  await assert.rejects(
    () => tool.execute({
      file_path: 'C:/w/a.txt', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' },
    }, h.exec),
    /old_string not found/u,
  )
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['edit'], 'only the edit ran')
})

test('2.2 a failed write runs no command', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: { write: async () => err('EACCES') },
  })
  const tool = h.byName.get(WRITE_TOOL_NAME)
  await assert.rejects(
    () => tool.execute({ file_path: 'C:/w/a.txt', content: 'x', then_run: { command: 'npm test' } }, h.exec),
    /EACCES/u,
  )
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['write'])
})

test('2.3 an edit that throws still runs no command', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => {
        throw new Error('registry exploded')
      },
    },
  })
  const tool = h.byName.get(EDIT_TOOL_NAME)
  await assert.rejects(
    () => tool.execute({ file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } }, h.exec),
    /registry exploded/u,
  )
  assert.equal(h.fakeTools.executed.length, 1)
})

/* ------------------------------------------------------------------ */
/* 3. the file changed underneath us → skipped                         */
/* ------------------------------------------------------------------ */

test('3.1 a file changed after the edit skips the command', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: { edit: async () => editOk('new content') },
    read: async () => 'someone else wrote this',
  })
  const tool = h.byName.get(EDIT_TOOL_NAME)
  const value = await tool.execute(
    { file_path: 'C:/w/a.txt', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.skipped)
  assert.match(value.text, /\[then_run:skipped\]/u)
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['edit'])
})

test('3.2 an unchanged file runs the command', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => editOk('new content'),
      ops_bash: async () => ok({ exitCode: 0, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false }, timedOut: false, timeoutMs: 120000 }),
    },
    read: async () => 'new content',
  })
  const tool = h.byName.get(EDIT_TOOL_NAME)
  const value = await tool.execute(
    { file_path: 'C:/w/a.txt', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.succeeded)
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['edit', 'ops_bash'])
})

test('3.3 an unreadable file does not block the command, and says so', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => editOk('new content'),
      ops_bash: async () => ok({ exitCode: 0, timedOut: false }),
    },
    read: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  })
  const tool = h.byName.get(EDIT_TOOL_NAME)
  const value = await tool.execute(
    { file_path: 'C:/w/a.txt', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.succeeded, 'an unreadable path must not skip verification')
  assert.match(value.text, /could not re-read the file/u)
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['edit', 'ops_bash'])
})

test('verifyUnchanged distinguishes the three verdicts', async () => {
  assert.equal(await verifyUnchanged('C:/a', 'x', async () => 'x'), 'unchanged')
  assert.equal(await verifyUnchanged('C:/a', 'x', async () => 'y'), 'changed')
  assert.equal(await verifyUnchanged('C:/a', 'x', async () => { throw new Error('nope') }), 'unreadable')
  assert.equal(await verifyUnchanged('', 'x', async () => 'x'), 'unreadable')
  assert.equal(await verifyUnchanged('C:/a', undefined, async () => 'x'), 'unreadable')
})

/* ------------------------------------------------------------------ */
/* 4. shell discovery                                                  */
/* ------------------------------------------------------------------ */

test('4.1 the first registered candidate wins', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF, pwsh: PWSH_DEF, bash: BASH_DEF },
    results: {
      edit: async () => editOk('c'),
      ops_bash: async () => ok({ exitCode: 0, timedOut: false }),
      pwsh: async () => ok({ kind: 'foreground', exitCode: 0, timedOut: false }),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.shell, 'ops_bash')
})

test('4.2 a missing first candidate falls through to the next', async () => {
  const h = harness({
    visible: { pwsh: PWSH_DEF },
    results: {
      edit: async () => editOk('c'),
      pwsh: async () => ok({ kind: 'foreground', exitCode: 0, timedOut: false }),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.shell, 'pwsh')
})

test('4.3 with no shell at all the command is not attempted', async () => {
  const h = harness({
    visible: {},
    results: { edit: async () => editOk('c') },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.notRun)
  assert.match(value.text, /no shell tool whose result dsh-sol can read is available \(tried ops_bash, pwsh, bash\)/u)
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['edit'], 'the shell was never called')
})

test('4.3b a shell whose value is a string is skipped, not used', async () => {
  // The minimal preset registers a persistent `pwsh` whose value is a string
  // (`asar:dsh-tool-pwsh-persistent/lib/index.js:349-354`). `classify` reads an
  // object, so that shell is unusable for Fusion: picking it would mark every
  // successful command `failed` (`notes/load-check.md`, persistent-shell row).
  const h = harness({
    visible: { pwsh: PERSISTENT_PWSH_DEF },
    results: { edit: async () => editOk('c') },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.notRun)
  assert.match(value.text, /no shell tool whose result dsh-sol can read is available/u)
  assert.deepEqual(h.fakeTools.executed.map((call) => call.name), ['edit'], 'the unreadable shell was never called')
})

test('4.3c an unreadable shell is skipped and the next readable one is used', async () => {
  // The order matters: a string-valued shell earlier in the list must not stop
  // the search, or one preset change would disable Fusion entirely.
  const h = harness({
    visible: { ops_bash: PERSISTENT_PWSH_DEF, pwsh: PWSH_DEF },
    results: {
      edit: async () => editOk('c'),
      pwsh: async () => ok({ kind: 'foreground', exitCode: 0, timedOut: false }),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.succeeded)
  assert.equal(value.shell, 'pwsh', 'the unreadable first candidate was skipped')
})

test('4.4 the shell is looked up again on every call, never cached', async () => {
  const fake = createFakeCtx()
  const visible = { ops_bash: OPS_BASH_DEF, pwsh: PWSH_DEF }
  const results = {
    edit: async () => editOk('c'),
    ops_bash: async () => ok({ exitCode: 0, timedOut: false }),
    pwsh: async () => ok({ kind: 'foreground', exitCode: 0, timedOut: false }),
  }
  const fakeTools = createFakeTools({ visible, results })
  fake.ctx.tools = fakeTools.tools
  mountFusion(fake.ctx, { shells: ['ops_bash', 'pwsh'], read: async () => 'c' })
  const tool = fakeTools.registered.find((definition) => definition.name === EDIT_TOOL_NAME)
  const args = { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } }

  const first = await tool.execute(args, outerExec())
  assert.equal(first.shell, 'ops_bash')

  // The permission changed and ops_bash was withdrawn.
  delete visible.ops_bash
  const second = await tool.execute(args, outerExec())
  assert.equal(second.shell, 'pwsh', 'the lookup must not be cached across calls')
  // First call probed ops_bash once; second probed ops_bash (absent) then pwsh.
  assert.deepEqual(fakeTools.looked.map((call) => call.name), ['ops_bash', 'ops_bash', 'pwsh'])
})

test('4.5 the lookup passes the calling agent as its scope', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: { edit: async () => editOk('c'), ops_bash: async () => ok({ exitCode: 0, timedOut: false }) },
    read: async () => 'c',
  })
  await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  assert.ok(h.fakeTools.looked.length > 0)
  for (const call of h.fakeTools.looked) {
    assert.equal(call.argumentCount, 2, `get("${call.name}") must pass a scope`)
    assert.equal(call.scope, h.exec.agent, 'the scope must be exec.agent')
  }
})

test('pickShell returns the first readable definition, in order', () => {
  const tools = { get: (name) => (name === 'pwsh' ? PWSH_DEF : undefined) }
  assert.deepEqual(pickShell(tools, ['ops_bash', 'pwsh'], undefined), { name: 'pwsh', definition: PWSH_DEF })
  assert.equal(pickShell(tools, ['ops_bash'], undefined), undefined)
  assert.equal(pickShell({ get: () => undefined }, ['ops_bash'], undefined), undefined)
})

test('pickShell accepts every real shell shape and rejects a string-valued one', () => {
  // The three defaults must all be usable, or one wrong probe would disable
  // Fusion for every profile that has any of them.
  const byName = { ops_bash: OPS_BASH_DEF, pwsh: PWSH_DEF, bash: BASH_DEF }
  const tools = { get: (name) => byName[name] }
  assert.deepEqual(pickShell(tools, ['ops_bash'], undefined), { name: 'ops_bash', definition: OPS_BASH_DEF })
  assert.deepEqual(pickShell(tools, ['pwsh'], undefined), { name: 'pwsh', definition: PWSH_DEF })
  assert.deepEqual(pickShell(tools, ['bash'], undefined), { name: 'bash', definition: BASH_DEF })
  assert.equal(pickShell({ get: () => PERSISTENT_PWSH_DEF }, ['pwsh'], undefined), undefined)
})

test('readsObjectValue accepts object schemas, oneOf of objects, and rejects the rest', () => {
  assert.equal(readsObjectValue({ type: 'object' }), true)
  assert.equal(readsObjectValue({ oneOf: [{ type: 'object' }, { type: 'object' }] }), true)
  assert.equal(readsObjectValue({ anyOf: [{ type: 'object' }] }), true)
  assert.equal(readsObjectValue({ type: 'string' }), false)
  assert.equal(readsObjectValue({ oneOf: [{ type: 'object' }, { type: 'string' }] }), false, 'one unreadable branch is enough to refuse')
  assert.equal(readsObjectValue({ oneOf: [] }), false)
  assert.equal(readsObjectValue({}), false)
  assert.equal(readsObjectValue(undefined), false)
  assert.equal(readsObjectValue(null), false)
  assert.equal(readsObjectValue('object'), false)
})

/* ------------------------------------------------------------------ */
/* 5. per-shell argument construction                                  */
/* ------------------------------------------------------------------ */

test('5.1 pwsh always gets a non-empty description', () => {
  const args = shellArguments('pwsh', { command: 'npm test', timeout: undefined }, 'C:/w/a.txt')
  assert.equal(typeof args.description, 'string')
  assert.ok(args.description.length > 0)
  assert.equal(args.command, 'npm test')
})

for (const [variant, name, args] of [
  ['edit', EDIT_TOOL_NAME, { file_path: '/work/a.txt', old_string: 'old', new_string: 'new' }],
  ['write', WRITE_TOOL_NAME, { file_path: '/work/a.txt', content: 'new' }],
]) {
  test(`5.1b ${variant} falls back to built-in bash and satisfies its required description`, async () => {
    const h = harness({
      visible: { bash: BASH_DEF },
      results: {
        [variant]: async () => editOk('new', '/work/a.txt'),
        bash: async (exec) => {
          // DSH's built-in bash requires description, unlike ops_bash.
          if (typeof exec.arguments.description !== 'string' || exec.arguments.description.trim() === '') {
            return err('invalid arguments: missing required property "description"')
          }
          assert.equal(exec.arguments.command, 'npm test')
          assert.equal(exec.arguments.timeoutMs, 5000)
          return ok({ exitCode: 0, timedOut: false }, 'verification passed')
        },
      },
      read: async () => 'new',
    })
    const value = await h.byName.get(name).execute({ ...args, then_run: { command: 'npm test', timeout: 5000 } }, h.exec)
    assert.equal(value.marker, MARKERS.succeeded)
    assert.equal(value.shell, 'bash')
    assert.match(value.text, /verification passed/u)
    assert.deepEqual(h.fakeTools.executed.map((call) => call.name), [variant, 'bash'])
  })
}

test('5.2 ops_bash gets command and never script_path', () => {
  const args = shellArguments('ops_bash', { command: 'npm test', timeout: undefined }, 'C:/w/a.txt')
  assert.equal(args.command, 'npm test')
  assert.equal('script_path' in args, false)
  assert.equal('description' in args, false, 'ops_bash accepts description but this tool does not send it')
})

test('5.3 then_run refuses script_path outright', () => {
  assert.throws(
    () => parseThenRun({ command: 'npm test', script_path: 'C:/x.sh' }),
    FusionArgsError,
  )
  try {
    parseThenRun({ command: 'npm test', script_path: 'C:/x.sh' })
  } catch (error) {
    assert.match(error.message, /script_path/u)
    assert.match(error.message, /unknown key/u)
  }
})

test('5.4 a call can never carry both command and script_path', () => {
  for (const name of ['ops_bash', 'pwsh', 'bash']) {
    const args = shellArguments(name, { command: 'npm test', timeout: undefined }, 'f')
    assert.equal('command' in args, true, name)
    assert.equal('script_path' in args, false, name)
  }
})

test('5.5 no undeclared key reaches the shell', () => {
  for (const name of ['ops_bash', 'pwsh', 'bash']) {
    const args = shellArguments(name, { command: 'npm test', timeout: 1000 }, 'f')
    const allowed = name === 'pwsh' || name === 'bash'
      ? ['description', 'command', 'timeoutMs']
      : ['command', 'timeoutMs']
    for (const key of Object.keys(args)) assert.ok(allowed.includes(key), `${name} sent ${key}`)
  }
})

test('5.6 a timeout is forwarded as timeoutMs, and omitted when absent', () => {
  assert.equal(shellArguments('ops_bash', { command: 'c', timeout: 5000 }, 'f').timeoutMs, 5000)
  assert.equal(shellArguments('pwsh', { command: 'c', timeout: 5000 }, 'f').timeoutMs, 5000)
  assert.equal('timeoutMs' in shellArguments('ops_bash', { command: 'c', timeout: undefined }, 'f'), false)
})

/* ------------------------------------------------------------------ */
/* 6. nested calls carry parent, agent, signal, distinct callIds       */
/* ------------------------------------------------------------------ */

test('6.1 and 6.2 both nested calls carry parent === outerExec.token', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: { edit: async () => editOk('c'), ops_bash: async () => ok({ exitCode: 0, timedOut: false }) },
    read: async () => 'c',
  })
  await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  assert.equal(h.fakeTools.executed.length, 2)
  for (const call of h.fakeTools.executed) {
    assert.equal(call.parent, h.exec.token, 'parent must be the outer Symbol, by identity')
  }
})

test('6.3 both calls carry the agent and signal, with distinct callIds', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: { edit: async () => editOk('c'), ops_bash: async () => ok({ exitCode: 0, timedOut: false }) },
    read: async () => 'c',
  })
  await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  const [first, second] = h.fakeTools.executed
  assert.equal(first.agent, h.exec.agent)
  assert.equal(second.agent, h.exec.agent)
  assert.equal(first.signal, h.exec.signal)
  assert.equal(second.signal, h.exec.signal)
  assert.notEqual(first.callId, second.callId)
  assert.ok(first.callId.length > 0 && second.callId.length > 0)
  assert.equal(first.rootCallId, h.exec.rootCallId)
})

test('a nested call without an agent omits the field rather than writing undefined', () => {
  const exec = outerExec({ agent: undefined })
  const input = nestedExecution(exec, 'edit', {}, 1)
  assert.equal('agent' in input, false)
  assert.equal(input.parent, exec.token)
})

test('a nested call without an outer signal still carries a signal', () => {
  // The registry reads `callerSignal.aborted` directly
  // (`asar:dsh-tools/lib/index.js:3372-3377`), so an absent signal would throw a
  // TypeError instead of running the command (`notes/load-check.md` 2).
  const exec = outerExec({ signal: undefined })
  const input = nestedExecution(exec, 'edit', {}, 1)
  assert.ok(input.signal !== undefined, 'the signal is always present')
  assert.equal(input.signal.aborted, false, 'a fresh signal is never aborted')
})

/* ------------------------------------------------------------------ */
/* 7. Fusion malfunction lets the edit through                         */
/* ------------------------------------------------------------------ */

test('7.1 a throwing tools.get still returns the edit text with not_run', async () => {
  const fake = createFakeCtx()
  const fakeTools = createFakeTools({
    results: { edit: async () => editOk('c') },
  })
  fakeTools.tools.get = () => {
    throw new Error('registry is gone')
  }
  fake.ctx.tools = fakeTools.tools
  mountFusion(fake.ctx, { shells: ['ops_bash'], read: async () => 'c' })
  const tool = fakeTools.registered.find((definition) => definition.name === EDIT_TOOL_NAME)
  const value = await tool.execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    outerExec(),
  )
  assert.equal(value.marker, MARKERS.notRun)
  assert.match(value.text, /The file C:\/w\/a.txt has been updated\./u, 'the edit text survives verbatim')
  assert.match(value.text, /could not look up a shell/u)
})

test('7.2 a throwing shell list still returns the edit text', async () => {
  const fake = createFakeCtx()
  const fakeTools = createFakeTools({ results: { edit: async () => editOk('c') } })
  fake.ctx.tools = fakeTools.tools
  mountFusion(fake.ctx, {
    shells: () => {
      throw new Error('config exploded')
    },
    read: async () => 'c',
  })
  const tool = fakeTools.registered.find((definition) => definition.name === EDIT_TOOL_NAME)
  const value = await tool.execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    outerExec(),
  )
  assert.equal(value.marker, MARKERS.notRun)
  assert.match(value.text, /could not read its shell list/u)
})

test('7.3 a throwing nested shell call still returns the edit text', async () => {
  const fake = createFakeCtx()
  const fakeTools = createFakeTools({ visible: { ops_bash: OPS_BASH_DEF } })
  const realExecute = fakeTools.tools.execute.bind(fakeTools.tools)
  fakeTools.tools.execute = async (exec) => {
    if (exec.name === 'edit') return editOk('c')
    throw new Error('dispatch exploded')
  }
  void realExecute
  fake.ctx.tools = fakeTools.tools
  mountFusion(fake.ctx, { shells: ['ops_bash'], read: async () => 'c' })
  const tool = fakeTools.registered.find((definition) => definition.name === EDIT_TOOL_NAME)
  const value = await tool.execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    outerExec(),
  )
  assert.equal(value.marker, MARKERS.notRun)
  assert.match(value.text, /the shell call failed/u)
  assert.match(value.text, /updated/u)
})

test('7.4 the returned value always satisfies the declared output schema', async () => {
  const h = harness({
    visible: {},
    results: { edit: async () => editOk('c') },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  assert.equal(typeof value.marker, 'string')
  assert.equal(typeof value.text, 'string')
  assert.ok(OUTPUT_SCHEMA.properties.marker.enum.includes(value.marker))
  for (const key of Object.keys(value)) {
    assert.ok(key in OUTPUT_SCHEMA.properties, `undeclared output field ${key}`)
  }
})

/* ------------------------------------------------------------------ */
/* 8. argument validation                                              */
/* ------------------------------------------------------------------ */

test('8.1 an undeclared top-level key is refused before anything runs', async () => {
  const h = harness({ visible: { ops_bash: OPS_BASH_DEF }, results: {} })
  await assert.rejects(
    () => h.byName.get(EDIT_TOOL_NAME).execute(
      { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' }, sandbox_permissions: 'x' },
      h.exec,
    ),
    FusionArgsError,
  )
  assert.equal(h.fakeTools.executed.length, 0, 'the edit must not run')
})

test('8.2 a missing then_run is refused', async () => {
  const h = harness({ visible: {}, results: {} })
  await assert.rejects(
    () => h.byName.get(EDIT_TOOL_NAME).execute({ file_path: 'a', old_string: 'x', new_string: 'y' }, h.exec),
    FusionArgsError,
  )
  assert.equal(h.fakeTools.executed.length, 0)
})

test('8.3 an empty then_run.command is refused', async () => {
  assert.throws(() => parseThenRun({ command: '' }), FusionArgsError)
  assert.throws(() => parseThenRun({ command: '   ' }), FusionArgsError)
})

test('8.4 a non-positive or non-numeric timeout is refused', () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000', null]) {
    assert.throws(() => parseThenRun({ command: 'c', timeout }), FusionArgsError, String(timeout))
  }
})

test('8.5 arguments must be an object', () => {
  for (const raw of [undefined, null, 'x', 42, []]) {
    assert.throws(() => assertKnownArguments(raw, ['a'], 'arguments'), FusionArgsError, String(raw))
  }
})

test('8.6 edit and write parse only their own fields', () => {
  const edit = parseEditArgs({ file_path: 'a', old_string: 'x', new_string: '', then_run: { command: 'c' } })
  assert.deepEqual(edit.inner, { file_path: 'a', old_string: 'x', new_string: '' })
  assert.equal(edit.thenRun.command, 'c')

  const write = parseWriteArgs({ file_path: 'a', content: '', then_run: { command: 'c', timeout: 10 } })
  assert.deepEqual(write.inner, { file_path: 'a', content: '' })
  assert.equal(write.thenRun.timeout, 10)

  // replace_all is optional and only forwarded when present.
  const withAll = parseEditArgs({
    file_path: 'a', old_string: 'x', new_string: 'y', replace_all: true, then_run: { command: 'c' },
  })
  assert.equal(withAll.inner.replace_all, true)
  assert.equal('replace_all' in edit.inner, false)
})

test('8.7 the escalation pair is never forwarded to the inner tool', () => {
  assert.deepEqual(EDIT_KEYS, ['file_path', 'old_string', 'new_string', 'replace_all'])
  assert.deepEqual(WRITE_KEYS, ['file_path', 'content'])
  assert.deepEqual(THEN_RUN_KEYS, ['command', 'timeout'])
})

/* ------------------------------------------------------------------ */
/* 9. registration shape                                               */
/* ------------------------------------------------------------------ */

test('9.1 both tools use new names, never edit or write', () => {
  const h = harness({ visible: {}, results: {} })
  const names = h.fakeTools.registered.map((definition) => definition.name)
  assert.deepEqual(names, [EDIT_TOOL_NAME, WRITE_TOOL_NAME])
  assert.equal(names.includes('edit'), false)
  assert.equal(names.includes('write'), false)
})

test('9.2 every definition declares a render function', () => {
  const h = harness({ visible: {}, results: {} })
  for (const definition of h.fakeTools.registered) {
    assert.equal(typeof definition.output.render, 'function', definition.name)
    assert.equal(typeof definition.output.schema, 'object', definition.name)
  }
})

test('9.3 the parameter schemas use only the supported keyword subset', () => {
  const supported = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title']
  const visit = (node, path) => {
    if (node === null || typeof node !== 'object') return
    for (const key of Object.keys(node)) {
      assert.ok(supported.includes(key), `${path}.${key} is not a supported keyword`)
    }
    if (node.properties !== undefined) {
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.properties.${key}`)
    }
  }
  const h = harness({ visible: {}, results: {} })
  for (const definition of h.fakeTools.registered) {
    visit(definition.parameters, `${definition.name}.parameters`)
    visit(definition.output.schema, `${definition.name}.output.schema`)
  }
})

test('9.4 neither tool claims the reserved run_code name', () => {
  const h = harness({ visible: {}, results: {} })
  for (const definition of h.fakeTools.registered) assert.notEqual(definition.name, 'run_code')
})

test('9.5 the declared schema is exactly what the body can return', () => {
  const h = harness({ visible: {}, results: {} })
  for (const definition of h.fakeTools.registered) {
    assert.equal(definition.output.schema.type, 'object')
    assert.deepEqual(definition.output.schema.required, ['marker', 'text'])
    assert.equal(definition.output.schema.additionalProperties, false)
  }
})

test('9.6 the parameter schema requires then_run', () => {
  const h = harness({ visible: {}, results: {} })
  for (const definition of h.fakeTools.registered) {
    assert.ok(definition.parameters.required.includes('then_run'), definition.name)
    assert.equal(definition.parameters.additionalProperties, false)
    assert.deepEqual(definition.parameters.properties.then_run.required, ['command'])
  }
})

test('9.7 mount returns a disposer that removes both registrations', () => {
  const h = harness({ visible: {}, results: {} })
  assert.equal(h.fakeTools.registered.length, 2)
  h.dispose()
  assert.equal(h.fakeTools.registered.length, 0)
})

test('9.8 a duplicate registration failure does not leave a half-mounted pair', () => {
  const fake = createFakeCtx()
  const fakeTools = createFakeTools()
  fakeTools.reject.add(WRITE_TOOL_NAME)
  fake.ctx.tools = fakeTools.tools
  assert.throws(() => mountFusion(fake.ctx, { shells: ['ops_bash'] }), /already registered/u)
})

/* ------------------------------------------------------------------ */
/* 10. marker text and passthrough                                     */
/* ------------------------------------------------------------------ */

test('10.1 a success carries the marker and the command output', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => editOk('c'),
      ops_bash: async () => ok({ exitCode: 0, timedOut: false }, 'all 42 tests passed'),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.match(value.text, /\[then_run:succeeded\]/u)
  assert.match(value.text, /all 42 tests passed/u)
})

test('10.2 a failure carries the marker, the exit code and the output', async () => {
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => editOk('c'),
      ops_bash: async () => ok({ exitCode: 1, timedOut: false }, '2 tests failed'),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'npm test' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.failed)
  assert.match(value.text, /\[then_run:failed\] exit code: 1/u)
  assert.match(value.text, /2 tests failed/u)
})

test('10.3 not_run carries the reason verbatim', async () => {
  const reason = 'Host tool pwsh is disabled by dsh-ops shellPolicy.'
  const h = harness({
    visible: { pwsh: PWSH_DEF },
    results: { edit: async () => editOk('c'), pwsh: async () => err(reason) },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.notRun)
  assert.ok(value.text.includes(reason), 'the reason appears verbatim')
})

test('10.4 a promoted result names the job and says it is still running', async () => {
  const h = harness({
    visible: { pwsh: PWSH_DEF },
    results: {
      edit: async () => editOk('c'),
      pwsh: async () => ok({ kind: 'promoted', jobId: 'job-9', timeoutMs: 120000, output: 'partial' }, 'partial'),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  assert.equal(value.marker, MARKERS.failed)
  assert.equal(value.jobId, 'job-9')
  assert.match(value.text, /still running/u)
  assert.match(value.text, /job_output/u)
  assert.match(value.text, /job_kill/u)
})

test('10.5 a truncation notice is passed through exactly once', async () => {
  const notice = '[output truncated; full output: C:/tmp/spill.txt]'
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => editOk('c'),
      ops_bash: async () => ok({ exitCode: 0, timedOut: false }, `body\n${notice}`),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'a', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  const occurrences = value.text.split(notice).length - 1
  assert.equal(occurrences, 1, 'Fusion must not re-add the notice the shell already wrote')
})

test('10.6 the edit output survives verbatim in front of the marker', async () => {
  const editText = 'The file C:/w/a.txt has been updated with 2 replacements.'
  const h = harness({
    visible: { ops_bash: OPS_BASH_DEF },
    results: {
      edit: async () => ok({ path: 'C:/w/a.txt', before: 'a', after: 'c' }, editText),
      ops_bash: async () => ok({ exitCode: 0, timedOut: false }, 'ok'),
    },
    read: async () => 'c',
  })
  const value = await h.byName.get(EDIT_TOOL_NAME).execute(
    { file_path: 'C:/w/a.txt', old_string: 'x', new_string: 'y', then_run: { command: 'c' } },
    h.exec,
  )
  assert.ok(value.text.startsWith(editText), 'the edit text comes first, unchanged')
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

test('textOf joins only text blocks', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(textOf({ content: [] }), '')
  assert.equal(textOf({}), '')
  assert.equal(textOf(undefined), '')
})

test('composeText keeps order and drops empty lines', () => {
  assert.equal(composeText('edit', ['[then_run:succeeded]', '', 'out']), 'edit\n[then_run:succeeded]\nout')
  assert.equal(composeText('', ['m']), 'm')
  assert.equal(composeText(undefined, []), '')
})

test('fusionValue omits absent optional fields', () => {
  const value = fusionValue({ marker: 'succeeded', text: 't' })
  assert.deepEqual(value, { marker: 'succeeded', text: 't' })
  assert.equal('path' in value, false)
  assert.equal('jobId' in value, false)
  assert.equal('exitCode' in value, false)
})

test('a definition can be built for either variant without a context call', () => {
  const fake = createFakeCtx()
  const definition = defineFusionTool({
    name: 'probe', variant: 'write', ctx: fake.ctx, shells: () => [], read: async () => '',
  })
  assert.equal(definition.name, 'probe')
  assert.equal(typeof definition.execute, 'function')
  assert.deepEqual(definition.parameters.required, ['file_path', 'content', 'then_run'])
})
