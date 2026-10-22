import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  archiveContent,
  createArchiver,
  DIGEST_PATTERN,
  isValidDigest,
  objectPath,
  objectsDir,
  readArchived,
  sha256,
} from '../lib/archive.js'

const GOOD_ID = 'session-1bc7e121-212d-463c-ba02-53fb7b5169f3'

/**
 * Create a throwaway home directory.
 * @returns {Promise<string>} the absolute path.
 */
async function tempHome() {
  return mkdtemp(join(tmpdir(), 'dsh-sol-archive-'))
}

test('sha256 is stable lowercase hex', () => {
  const digest = sha256('hello')
  assert.equal(digest, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  assert.equal(digest, digest.toLowerCase())
  assert.match(digest, DIGEST_PATTERN)
  // The empty string is a real input, not an error.
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('utf8 content hashes over its bytes, not its code units', () => {
  assert.equal(sha256('中文'), sha256(Buffer.from('中文', 'utf8')))
  assert.notEqual(sha256('中文'), sha256('abc'))
})

test('isValidDigest accepts only 64 lowercase hex characters', () => {
  assert.equal(isValidDigest(sha256('x')), true)
  for (const bad of [
    '',
    'abc',
    sha256('x').toUpperCase(),
    `${sha256('x')}0`,
    `${sha256('x').slice(0, 63)}`,
    `${'g'.repeat(64)}`,
    null,
    undefined,
    42,
  ]) {
    assert.equal(isValidDigest(bad), false, JSON.stringify(bad))
  }
})

test('objectsDir refuses an unsafe session id', () => {
  assert.throws(() => objectsDir('C:/h', '../escape'), /refusing unsafe session id/u)
  assert.throws(() => objectPath('C:/h', 'a/b', sha256('x')), /refusing unsafe session id/u)
})

test('objectPath refuses a malformed digest', () => {
  assert.throws(() => objectPath('C:/h', GOOD_ID, 'not-a-digest'), /refusing malformed digest/u)
  assert.throws(() => objectPath('C:/h', GOOD_ID, '../x'), /refusing malformed digest/u)
})

test('objectPath nests under objects and uses the digest as the name', () => {
  const digest = sha256('x')
  const path = objectPath('C:/h', GOOD_ID, digest)
  assert.ok(path.endsWith(join(GOOD_ID, 'objects', `${digest}.txt`)), path)
})

test('archiveContent writes once and reports created', async () => {
  const home = await tempHome()
  try {
    const result = await archiveContent({ home, sessionId: GOOD_ID, content: 'hello' })
    assert.equal(result.created, true)
    assert.equal(result.digest, sha256('hello'))
    assert.equal(result.bytes, 5)
    assert.equal(await readFile(result.path, 'utf8'), 'hello')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('archiving the same content twice is idempotent and verified', async () => {
  const home = await tempHome()
  try {
    const first = await archiveContent({ home, sessionId: GOOD_ID, content: 'same bytes' })
    const second = await archiveContent({ home, sessionId: GOOD_ID, content: 'same bytes' })
    assert.equal(first.created, true)
    assert.equal(second.created, false, 'the second write must not claim to have created it')
    assert.equal(second.digest, first.digest)
    assert.equal(await readFile(second.path, 'utf8'), 'same bytes')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('concurrent identical writes publish one complete object without partial-read failures', async () => {
  const home = await tempHome()
  try {
    const content = Buffer.alloc(2 * 1024 * 1024, 'x')
    const results = await Promise.all(Array.from({ length: 16 }, () => (
      archiveContent({ home, sessionId: GOOD_ID, content })
    )))
    const digest = sha256(content)
    assert.equal(results.filter((result) => result.created).length, 1)
    assert.ok(results.every((result) => result.digest === digest && result.bytes === content.length))
    assert.deepEqual(await readArchived({ home, sessionId: GOOD_ID, digest }), content)
    assert.deepEqual(await readdir(objectsDir(home, GOOD_ID)), [`${digest}.txt`], 'no temporary files remain')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an existing object whose content does not match its name is refused', async () => {
  const home = await tempHome()
  try {
    const digest = sha256('real')
    const dir = objectsDir(home, GOOD_ID)
    await mkdir(dir, { recursive: true })
    // Plant a file under the wrong content, as a collision or corruption would.
    await writeFile(join(dir, `${digest}.txt`), 'tampered')
    await assert.rejects(
      () => archiveContent({ home, sessionId: GOOD_ID, content: 'real' }),
      /does not match its name/u,
    )
    assert.equal(await readFile(join(dir, `${digest}.txt`), 'utf8'), 'tampered', 'the existing object is not overwritten')
    assert.deepEqual(await readdir(dir), [`${digest}.txt`], 'failed publication cleans its temporary file')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('readArchived returns undefined for a missing object', async () => {
  const home = await tempHome()
  try {
    assert.equal(await readArchived({ home, sessionId: GOOD_ID, digest: sha256('absent') }), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a symbolic link at the object path is refused, not followed', async () => {
  const home = await tempHome()
  try {
    const outside = join(home, 'outside.txt')
    await writeFile(outside, 'secret')
    const digest = sha256('secret')
    const dir = objectsDir(home, GOOD_ID)
    await mkdir(dir, { recursive: true })
    try {
      await symlink(outside, join(dir, `${digest}.txt`))
    } catch (error) {
      // Creating a symlink needs a privilege on some Windows setups; skip then.
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    await assert.rejects(
      () => readArchived({ home, sessionId: GOOD_ID, digest }),
      /refusing to follow a symbolic link/u,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the archived bytes are exactly the bytes given, including multi-byte text', async () => {
  const home = await tempHome()
  try {
    const content = '中文内容\n带换行 🎉'
    const { digest } = await archiveContent({ home, sessionId: GOOD_ID, content })
    const back = await readArchived({ home, sessionId: GOOD_ID, digest })
    assert.equal(back.toString('utf8'), content)
    assert.equal(sha256(back), digest)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the archiver binds one home and one session', async () => {
  const home = await tempHome()
  try {
    const archiver = createArchiver({ home, sessionId: GOOD_ID })
    const put = await archiver.put('bound')
    assert.equal(put.digest, archiver.digestOf('bound'))
    assert.equal((await archiver.get(put.digest)).toString('utf8'), 'bound')
    assert.equal(archiver.pathOf(put.digest), put.path)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the archiver refuses an unsafe session id at the first write', async () => {
  const archiver = createArchiver({ home: 'C:/nowhere', sessionId: '../escape' })
  await assert.rejects(() => archiver.put('x'), /refusing unsafe session id/u)
})

test('two sessions keep separate object directories', async () => {
  const home = await tempHome()
  try {
    const a = await archiveContent({ home, sessionId: 'session-a', content: 'shared' })
    const b = await archiveContent({ home, sessionId: 'session-b', content: 'shared' })
    assert.equal(a.digest, b.digest, 'the address is content-based')
    assert.notEqual(a.path, b.path, 'the paths are session-scoped')
    assert.equal(a.created && b.created, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
