/**
 * 哈希工具：用于重复文件检测与缓存键计算。
 */
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'

/** 计算字符串的 SHA-256 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 计算文件的 SHA-256。
 * @param sampleBytes 只读取开头 N 字节做「快速指纹」，用于二级筛选
 */
export async function hashFile(file: string, sampleBytes?: number): Promise<string> {
  const hash = createHash('sha256')
  if (sampleBytes && sampleBytes > 0) {
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(sampleBytes)
      const { bytesRead } = await handle.read(buffer, 0, sampleBytes, 0)
      hash.update(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
    return hash.digest('hex')
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}
