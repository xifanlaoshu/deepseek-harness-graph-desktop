import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { prepareLoopxRuntime, readLoopXReleaseLock, unpackLoopXWheel, validateLoopXWheel } from '../scripts/prepare-loopx-runtime.ts'

it('pins the LoopX release wheel and its upstream licensing metadata', () => {
  const lock = readLoopXReleaseLock()
  expect(lock).toMatchObject({
    version: '1.2.2', sourceCommit: 'ee9dad81b14c6d15d32b95851b5d38fcc485e732',
    license: 'Apache-2.0', wheel: { fileName: 'loopx-1.2.2-py3-none-any.whl', size: 6_847_544 },
  })
})

it('unpacks ordinary wheel paths and preserves files beneath wheel data directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loopx-wheel-safe-'))
  const archive = join(root, 'fixture.whl')
  const packages = join(root, 'python-packages')
  mkdirSync(packages)
  writeFileSync(archive, zipFixture(['loopx/__init__.py', 'loopx-1.2.2.data/data/share/example.txt']))
  try {
    await unpackLoopXWheel(archive, packages)
    expect(readFileSync(join(packages, 'loopx-1.2.2.data/data/share/example.txt'), 'utf8')).toBe('')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.each(['../outside.txt', '/absolute.txt', 'C:/drive.txt', 'loopx\\escape.txt', 'loopx/../escape.txt'])(
  'rejects unsafe wheel member %s before extraction', async (name) => {
    await expectWheelRejected([name], /unsafe archive path|invalid relative path|absolute path|invalid characters/)
  },
)

it('rejects symbolic links, duplicate paths, and file-as-parent conflicts', async () => {
  await expectWheelRejected([{ name: 'loopx/link', mode: 0o120777 }], /link or special file/)
  await expectWheelRejected(['loopx/file', 'loopx/file'], /repeats or collides/)
  await expectWheelRejected(['loopx/file', 'loopx/file/child'], /beneath a file/)
})

it('rejects malformed and truncated ZIP data', async () => {
  await expectWheelRejected([], /end of central directory/i, Buffer.from('not a wheel'))
  await expectWheelRejected(['loopx/module.py'], /end of central directory/i, zipFixture(['loopx/module.py']).subarray(0, -1))
})

it('rejects network bytes with the locked size but a different digest before creating output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loopx-wheel-hash-'))
  const lock = readLoopXReleaseLock()
  const output = join(root, 'runtime', 'loopx')
  try {
    await expect(prepareLoopxRuntime({
      pythonExecutable: fileURLToPath(import.meta.url), output, cache: join(root, 'cache'),
      fetcher: async () => responseFor(Buffer.alloc(lock.wheel.size)),
    })).rejects.toThrow(/SHA-256 mismatch/)
    expect(existsSync(output)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('rejects a corrupt cache entry without replacing or downloading it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loopx-wheel-cache-'))
  const lock = readLoopXReleaseLock()
  const cache = join(root, 'cache')
  mkdirSync(cache)
  writeFileSync(join(cache, lock.wheel.fileName), Buffer.alloc(lock.wheel.size))
  let downloadCount = 0
  try {
    await expect(prepareLoopxRuntime({
      pythonExecutable: fileURLToPath(import.meta.url), output: join(root, 'runtime', 'loopx'), cache,
      fetcher: async () => { downloadCount += 1; return responseFor(Buffer.alloc(0)) },
    })).rejects.toThrow(/SHA-256 mismatch/)
    expect(downloadCount).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('requires an explicit bundled Python executable before requesting the wheel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loopx-wheel-python-'))
  let downloadCount = 0
  try {
    await expect(prepareLoopxRuntime({
      pythonExecutable: join(root, 'missing-python.exe'), output: join(root, 'runtime', 'loopx'), cache: join(root, 'cache'),
      fetcher: async () => { downloadCount += 1; return responseFor(Buffer.alloc(0)) },
    })).rejects.toThrow(/bundled Python executable/)
    expect(downloadCount).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('stops an oversized wheel response before buffering bytes beyond the lock size', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loopx-wheel-size-'))
  const lock = readLoopXReleaseLock()
  try {
    await expect(prepareLoopxRuntime({
      pythonExecutable: fileURLToPath(import.meta.url), output: join(root, 'runtime', 'loopx'), cache: join(root, 'cache'),
      fetcher: async () => responseFor(Buffer.alloc(lock.wheel.size + 1)),
    })).rejects.toThrow(/exceeds the locked size/)
    expect(existsSync(join(root, 'runtime', 'loopx'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

type ZipEntry = string | { name: string; mode: number }

function zipFixture(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name
    const nameBytes = Buffer.from(name)
    const content = Buffer.alloc(0)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    local.push(localHeader, nameBytes, content)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(((typeof entry === 'string' ? 0 : entry.mode) << 16) >>> 0, 38)
    header.writeUInt32LE(localOffset, 42)
    central.push(header, nameBytes)
    localOffset += localHeader.length + nameBytes.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

async function expectWheelRejected(entries: ZipEntry[], message: RegExp, bytes = zipFixture(entries)): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'loopx-wheel-reject-'))
  const archive = join(root, 'fixture.whl')
  writeFileSync(archive, bytes)
  try { await expect(validateLoopXWheel(archive)).rejects.toThrow(message) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

function responseFor(bytes: Buffer): Response {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)
  const response = new Response(body)
  Object.defineProperty(response, 'url', { value: readLoopXReleaseLock().wheel.url })
  return response
}
