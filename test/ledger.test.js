import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendLedgerRecord,
  isValidSessionId,
  ledgerPath,
  PLUGIN_DIR_NAME,
  resolveDshHome,
  SESSION_ID_PATTERN,
  sessionDir,
} from '../lib/ledger.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

test('a real-shaped session id is accepted', () => {
  assert.equal(isValidSessionId(GOOD_ID), true)
})

test('path separators, dot-dot, absolute paths, trailing dots, and empties are rejected', () => {
  const bad = [
    '',
    '.',
    '..',
    '../escape',
    '..\\escape',
    'a/b',
    'a\\b',
    '/etc/passwd',
    'C:\\Windows',
    'C:evil',
    'session-1.',
    'session-.',
    '-leading-dash',
    '_leading-underscore',
    '.leading-dot',
    'has space',
    'has\u0000nul',
    'x'.repeat(200),
    'CON',
    'nul',
    'aux.log',
    null,
    undefined,
    42,
    {},
  ]
  for (const id of bad) assert.equal(isValidSessionId(id), false, JSON.stringify(id))
})

test('the pattern is anchored and bounded', () => {
  assert.match(SESSION_ID_PATTERN.source, /^\^.*\$$/u)
  assert.ok(SESSION_ID_PATTERN.test('a'))
  assert.equal(SESSION_ID_PATTERN.test('x'.repeat(128)), true)
  assert.equal(SESSION_ID_PATTERN.test('x'.repeat(129)), false)
})

test('sessionDir refuses an unsafe id instead of joining it', () => {
  assert.throws(() => sessionDir('C:/home', '../etc'), /refusing unsafe session id/u)
  assert.throws(() => ledgerPath('C:/home', 'a/b'), /refusing unsafe session id/u)
})

test('sessionDir nests under the plugin directory', () => {
  assert.equal(sessionDir('C:/home', GOOD_ID), join('C:/home', PLUGIN_DIR_NAME, GOOD_ID))
})

test('the Harness home follows the documented precedence', () => {
  assert.equal(resolveDshHome('D:/explicit', { DSH_HOME: 'E:/env' }), join('D:/explicit'))
  assert.equal(resolveDshHome(undefined, { DSH_HOME: 'E:/env' }), join('E:/env'))
  assert.equal(resolveDshHome(undefined, { DSH_HOME: '   ' }).endsWith(join('.dsh')), true)
  assert.equal(resolveDshHome(undefined, {}).endsWith(join('.dsh')), true)
})

test('a tilde override expands against the OS home', () => {
  const resolved = resolveDshHome('~/alt', {})
  assert.equal(resolved.includes('~'), false)
  assert.equal(resolved.endsWith(join('alt')), true)
})

test('appendLedgerRecord writes one JSON line and creates the directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sol-ledger-'))
  try {
    await appendLedgerRecord({ home, sessionId: GOOD_ID, record: { v: 1, kind: 'turn', turn: 1 } })
    await appendLedgerRecord({ home, sessionId: GOOD_ID, record: { v: 1, kind: 'turn', turn: 2 } })
    const text = await readFile(ledgerPath(home, GOOD_ID), 'utf8')
    const lines = text.trimEnd().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]), { v: 1, kind: 'turn', turn: 1 })
    assert.deepEqual(JSON.parse(lines[1]), { v: 1, kind: 'turn', turn: 2 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('appendLedgerRecord refuses an unsafe id before touching the filesystem', async () => {
  await assert.rejects(
    appendLedgerRecord({ home: 'C:/nowhere', sessionId: '../escape', record: {} }),
    /refusing unsafe session id/u,
  )
})
