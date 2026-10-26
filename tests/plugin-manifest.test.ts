import { describe, expect, it } from 'vitest'
import {
  PLUGIN_API_VERSION,
  checkPluginManifestCompatibility,
  createLegacyPluginManifest,
  isSafePluginFsRoot,
  isSafeRelativePath,
  isValidVersionRange,
  parsePluginManifest,
  satisfiesVersionRange,
  validatePluginManifest,
} from '@cordclean/shared'

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dev-cache',
    name: '开发缓存清理',
    version: '1.2.0',
    apiVersion: 2,
    engines: { cordclean: '>=0.5.0 <1.0.0' },
    kind: 'cleaner',
    entry: 'index.mjs',
    permissions: {
      services: ['cleaner', 'ui'],
      fsRoots: ['%TEMP%'],
      network: false,
      subprocess: false,
    },
    ...overrides,
  }
}

function codes(result: { errors: Array<{ code: string }>; warnings: Array<{ code: string }> }): string[] {
  return [...result.errors, ...result.warnings].map((item) => item.code)
}

describe('v2 插件清单校验', () => {
  it('最小合法清单通过并归一化', () => {
    const result = validatePluginManifest(validManifest())
    expect(result.errors).toEqual([])
    expect(result.manifest).toBeDefined()
    expect(result.manifest!.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(result.manifest!.permissions.services).toEqual(['cleaner', 'ui'])
    expect(result.manifest!.engines.cordclean).toBe('>=0.5.0 <1.0.0')
  })

  it('apiVersion 不是 2 时拒绝', () => {
    const result = validatePluginManifest(validManifest({ apiVersion: 1 }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('unsupported-api-version')
  })

  it('缺少 id / version / engines / permissions 时给出明确错误', () => {
    const base = validManifest()
    delete base.engines
    delete base.permissions
    const result = validatePluginManifest({ ...base, id: undefined, version: undefined })
    expect(result.ok).toBe(false)
    const all = codes(result)
    expect(all).toContain('missing-id')
    expect(all).toContain('missing-version')
    expect(all).toContain('missing-engines')
    expect(all).toContain('missing-permissions')
  })

  it('非法 id / version / kind 被拒绝', () => {
    expect(codes(validatePluginManifest(validManifest({ id: 'Bad_ID' })))).toContain('invalid-id')
    expect(codes(validatePluginManifest(validManifest({ version: '1.2' })))).toContain('invalid-version')
    expect(codes(validatePluginManifest(validManifest({ kind: 'whatever' })))).toContain('invalid-kind')
  })

  it('entry 必须是包内相对路径且不能越界', () => {
    expect(codes(validatePluginManifest(validManifest({ entry: '../evil.mjs' })))).toContain('invalid-entry')
    expect(codes(validatePluginManifest(validManifest({ entry: 'C:/evil.mjs' })))).toContain('invalid-entry')
    expect(codes(validatePluginManifest(validManifest({ entry: '/abs/index.mjs' })))).toContain('invalid-entry')
    expect(codes(validatePluginManifest(validManifest({ entry: 'client/index.mjs' })))).toContain('entry-in-client')
    expect(codes(validatePluginManifest(validManifest({ entry: 'index.txt' })))).toContain('invalid-entry-ext')
  })

  it('client.mode=page 必须在 client/ 下声明入口', () => {
    expect(
      validatePluginManifest(
        validManifest({ client: { mode: 'page', entry: 'client/index.html' } }),
      ).errors,
    ).toEqual([])
    expect(
      codes(validatePluginManifest(validManifest({ client: { mode: 'page' } }))),
    ).toContain('missing-client-entry')
    expect(
      codes(validatePluginManifest(validManifest({ client: { mode: 'page', entry: 'index.html' } }))),
    ).toContain('client-entry-outside')
    expect(
      codes(validatePluginManifest(validManifest({ client: { mode: 'page', entry: 'client/index.html' } }))),
    ).not.toContain('missing-client-entry')
  })

  it('declarative 模式声明 entry 只产生警告', () => {
    const result = validatePluginManifest(validManifest({ client: { mode: 'declarative', entry: 'client/x.html' } }))
    expect(result.errors).toEqual([])
    expect(codes(result)).toContain('ignored-client-entry')
  })

  it('权限：未知服务是错误，网络/子进程为 true 是警告', () => {
    expect(
      codes(
        validatePluginManifest(
          validManifest({ permissions: { services: ['nope'], network: false, subprocess: false } }),
        ),
      ),
    ).toContain('unknown-service')

    const networkResult = validatePluginManifest(
      validManifest({
        permissions: { services: ['cleaner'], network: true, subprocess: false },
      }),
    )
    expect(networkResult.errors).toEqual([])
    expect(codes(networkResult)).toContain('network-permission')

    const subprocessResult = validatePluginManifest(
      validManifest({
        permissions: { services: ['cleaner'], network: false, subprocess: true },
      }),
    )
    expect(codes(subprocessResult)).toContain('subprocess-permission')
  })

  it('fsRoots 拒绝盘符根与目录穿越，允许 %VAR% 模板', () => {
    const result = validatePluginManifest(
      validManifest({
        permissions: {
          services: ['cleaner'],
          fsRoots: ['C:\\', '%TEMP%', 'C:\\Windows\\..\\Users'],
          network: false,
          subprocess: false,
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result).filter((code) => code === 'invalid-fs-root').length).toBe(2)
  })

  it('contributes 重复 id 只警告，非法 id 是错误', () => {
    const result = validatePluginManifest(
      validManifest({ contributes: { tasks: ['a', 'a', 'Bad Id'] } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('duplicate-contribute-tasks')
    expect(codes(result)).toContain('invalid-contribute-id-tasks')
  })

  it('依赖声明沿用插件依赖校验（拒绝 git/URL 规格）', () => {
    const result = validatePluginManifest(
      validManifest({ dependencies: { 'left-pad': 'git+https://example.com/x.git' } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('invalid-dependency')
  })

  it('未知字段只警告，不阻止通过', () => {
    const result = validatePluginManifest(validManifest({ futureField: 1 }))
    expect(result.errors).toEqual([])
    expect(codes(result)).toContain('unknown-field')
  })

  it('非法 JSON 给出 invalid-json', () => {
    const result = parsePluginManifest('{ not json')
    expect(result.ok).toBe(false)
    expect(result.errors[0]!.code).toBe('invalid-json')
  })
})

describe('semver range 子集', () => {
  it('基本比较', () => {
    expect(satisfiesVersionRange('1.2.3', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesVersionRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfiesVersionRange('0.5.18', '>=0.6.0 <0.7.0')).toBe(false)
    expect(satisfiesVersionRange('0.6.2', '>=0.6.0 <0.7.0')).toBe(true)
  })

  it('caret / tilde', () => {
    expect(satisfiesVersionRange('1.9.0', '^1.2.3')).toBe(true)
    expect(satisfiesVersionRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesVersionRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesVersionRange('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfiesVersionRange('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfiesVersionRange('0.3.0', '^0.2.3')).toBe(false)
  })

  it('或运算与通配', () => {
    expect(satisfiesVersionRange('0.4.0', '^0.5.0 || ^0.4.0')).toBe(true)
    expect(satisfiesVersionRange('0.6.0', '^0.5.0 || ^0.4.0')).toBe(false)
    expect(satisfiesVersionRange('9.9.9', '*')).toBe(true)
  })

  it('非法 range 被识别', () => {
    expect(isValidVersionRange('>=0.6.0 <0.7.0')).toBe(true)
    expect(isValidVersionRange('latest')).toBe(false)
    expect(isValidVersionRange('>=0.6 <0.7')).toBe(false)
  })
})

describe('清单兼容性检查', () => {
  const manifest = validatePluginManifest(validManifest()).manifest!

  it('appVersion 不满足 engines 时拒绝', () => {
    const result = checkPluginManifestCompatibility(manifest, { appVersion: '1.0.0' })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('engines-mismatch')
  })

  it('appVersion 满足时通过', () => {
    const result = checkPluginManifestCompatibility(manifest, { appVersion: '0.6.0' })
    expect(result.ok).toBe(true)
  })

  it('宿主 API 版本不一致时拒绝', () => {
    const result = checkPluginManifestCompatibility(manifest, { appVersion: '0.6.0', apiVersion: 3 })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain('api-version-mismatch')
  })
})

describe('路径与旧版清单', () => {
  it('相对路径规则', () => {
    expect(isSafeRelativePath('index.mjs')).toBe(true)
    expect(isSafeRelativePath('client/index.html')).toBe(true)
    expect(isSafeRelativePath('client\\index.html')).toBe(false)
    expect(isSafeRelativePath('../x')).toBe(false)
    expect(isSafeRelativePath('/x')).toBe(false)
    expect(isSafeRelativePath('./x')).toBe(false)
  })

  it('fsRoot 规则', () => {
    expect(isSafePluginFsRoot('C:\\Users\\me\\AppData\\Local\\Temp')).toBe(true)
    expect(isSafePluginFsRoot('%TEMP%')).toBe(true)
    expect(isSafePluginFsRoot('%LOCALAPPDATA%\\Temp')).toBe(true)
    expect(isSafePluginFsRoot('C:\\')).toBe(false)
    expect(isSafePluginFsRoot('relative\\path')).toBe(false)
  })

  it('旧版单文件插件合成 apiVersion=1 清单', () => {
    const manifest = createLegacyPluginManifest({ id: 'old', entry: 'old.mjs' })
    expect(manifest.apiVersion).toBe(1)
    expect(manifest.engines.cordclean).toBe('*')
    expect(manifest.permissions.services).toEqual([])
  })
})
