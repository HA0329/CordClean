import { describe, expect, it } from 'vitest'
import type { AiRuleSuggestion, TaskEnv } from '@cordclean/shared'
import { assessAiRuleSuggestion, inspectClientPageBridge } from '@cordclean/host'

const env = {
  platform: 'win32',
  arch: 'x64',
  elevated: false,
  username: 'tester',
  systemDrive: 'C:',
  windowsDir: 'C:\\Windows',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  programData: 'C:\\ProgramData',
  appData: 'C:\\Users\\tester\\AppData\\Roaming',
  localAppData: 'C:\\Users\\tester\\AppData\\Local',
  userProfile: 'C:\\Users\\tester',
  dataDir: 'C:\\Users\\tester\\AppData\\Local\\CordClean',
  drives: ['C:'],
  get(name: string): string | undefined {
    const values: Record<string, string> = {
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\tester',
      WINDIR: 'C:\\Windows',
      TEMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
      SystemDrive: 'C:',
    }
    return values[name]
  },
} as TaskEnv

function rule(path: string, risk: AiRuleSuggestion['risk'] = 'safe'): AiRuleSuggestion {
  return { name: '测试规则', category: 'dev', risk, target: { type: 'clear_dir', path } }
}

describe('AI 规则安全门（P0-1）', () => {
  it('拒绝整体 npm-cache（会破坏运行中的 npx/AI 工具）', () => {
    const result = assessAiRuleSuggestion(rule('%LOCALAPPDATA%/npm-cache'), env)
    expect(result.blocked).toContain('npm-cache')
  })

  it('拒绝整个 AppData / Temp / 盘符根', () => {
    for (const path of ['%LOCALAPPDATA%', '%APPDATA%', '%TEMP%', 'C:\\']) {
      expect(assessAiRuleSuggestion(rule(path), env).blocked, path).toBeTruthy()
    }
  })

  it('具体应用缓存允许，但 AppData 直系子目录降级为谨慎', () => {
    const edge = assessAiRuleSuggestion(
      rule('%LOCALAPPDATA%/Microsoft/Edge/User Data/Default/Cache'),
      env,
    )
    expect(edge.blocked).toBeUndefined()
    expect(edge.risk).toBe('safe')

    const shallow = assessAiRuleSuggestion(rule('%LOCALAPPDATA%/SomeApp'), env)
    expect(shallow.blocked).toBeUndefined()
    expect(shallow.risk).toBe('caution')
    expect(shallow.warnings.join(' ')).toContain('直接子目录')
  })
})

describe('client 页面 bridge 校验（P0-2）', () => {
  it('自定义协议返回错误', () => {
    const html = `<script>window.parent.postMessage({channel:'cordclean/plugin-page',action:'resolve',requestId:'1'},'*')</script>`
    const result = inspectClientPageBridge(html)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('bridge')
  })

  it('宿主协议通过', () => {
    const html = `
      window.parent.postMessage({ type: 'cordclean/plugin-page', method: 'resolve', id: 'r1', resolverId: 'disks' }, '*')
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'cordclean/plugin-page-result' && event.data.id === 'r1') render(event.data.value)
      })
    `
    const result = inspectClientPageBridge(html)
    expect(result.errors).toEqual([])
  })

  it('纯静态页面只提示、不阻断', () => {
    const result = inspectClientPageBridge('<h1>静态页</h1>')
    expect(result.errors).toEqual([])
    expect(result.warnings.length).toBe(1)
  })
})
