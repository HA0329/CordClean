/**
 * 内置插件清单。
 *
 * 清单只保存「元数据 + 懒加载函数」，插件模块仅在被启用时才会被
 * `import()` 载入内存 —— 这既是启动性能优化，也是插件「按需装载」的体现。
 */
import type { PluginManifestEntry } from './domains/kernel/plugins.ts'

export const BUILTIN_MANIFEST: PluginManifestEntry[] = [
  {
    id: 'rule-pack',
    name: '规则库',
    description: '把 JSON 规则自动转换为清理能力：30 个分类、270+ 条规则，新增清理域只需加数据',
    category: 'system',
    version: '2.0.0',
    load: () => import('@cordclean/plugin-rule-pack'),
  },
  {
    id: 'scheduler',
    name: '定时扫描',
    description: '按间隔自动扫描并通知；只提醒，不会在后台自动删除',
    category: 'system',
    version: '1.0.0',
    defaultEnabled: false,
    load: () => import('@cordclean/plugin-scheduler'),
  },
  {
    id: 'shortcuts',
    name: '失效快捷方式',
    description: '纯二进制解析 .lnk，只清理目标确实不存在的死链（Startup 默认排除）',
    category: 'apps',
    version: '2.0.0',
    defaultEnabled: false,
    load: () => import('@cordclean/plugin-shortcuts'),
  },
  {
    id: 'recycle',
    name: '回收站',
    description: '统计并清空各磁盘回收站',
    category: 'system',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-recycle'),
  },
  {
    id: 'large-files',
    name: '大文件扫描',
    description: '在指定范围中找出占用空间最大的文件（只报告，需手动选择删除）',
    category: 'disk',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-large-files'),
  },
  {
    id: 'duplicates',
    name: '重复文件查找',
    description: '按「体积 → 头部哈希 → 全量 SHA-256」三级策略找出重复文件',
    category: 'disk',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-duplicates'),
  },
  {
    id: 'empty-dirs',
    name: '空目录清理',
    description: '找出并删除没有任何文件的空文件夹',
    category: 'disk',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-empty-dirs'),
  },
  {
    id: 'leftovers',
    name: '应用残留分析',
    description: '比对注册表卸载项与实际安装目录，找出已卸载软件的残留（注册表项备份后可清理）',
    category: 'apps',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-leftovers'),
  },
  {
    id: 'startup',
    name: '启动项管理',
    description: '注册表 Run/RunOnce 与启动文件夹中的自启动项，删除前自动导出 .reg 备份',
    category: 'startup',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-startup'),
  },
  {
    id: 'registry',
    name: '注册表问题',
    description: '失效的卸载残留项与无效的文件关联（清理前自动导出 .reg 备份）',
    category: 'system',
    version: '1.0.0',
    load: () => import('@cordclean/plugin-registry'),
  },
  {
    id: 'ai',
    name: 'AI 清理顾问',
    description: '调用 DeepSeek 等大模型 API，结合本机磁盘画像给出针对性的清理建议',
    category: 'ai',
    version: '1.0.0',
    defaultEnabled: false,
    load: () => import('@cordclean/plugin-ai'),
  },
]
