/**
 * 页面级卡片标题图标（内联 SVG，数据驱动）。
 *
 * 与侧边栏 `AreaIcon` 同一套视觉规范：24×24 viewBox、`stroke=currentColor`、
 * `stroke-width=1.9`、圆角端点，缩放不糊、跟随主题色。
 *
 * 为什么不复用 AreaIcon：导航区域只有 7 个固定图标；页面卡片图标更多，
 * 但不应扩大导航语义。这里用「名字 → 路径数组」的纯数据表，组件只负责渲染，
 * 新增图标只需加一条路径，并且可以被单测覆盖（类型 + 运行时集合校验）。
 */

export type SectionIconName =
  | 'disk'
  | 'monitor'
  | 'clock'
  | 'puzzle'
  | 'check'
  | 'shield'
  | 'alarm'
  | 'broom'
  | 'bolt'
  | 'book'
  | 'archive'
  | 'lock'
  | 'folders'
  | 'toolbox'
  | 'health'
  | 'receipt'
  | 'info'
  | 'alert'

/** 每个图标由若干条 SVG path 组成（只描边、不填充，符合现有图标规范） */
export const SECTION_ICON_PATHS: Readonly<Record<SectionIconName, readonly string[]>> = {
  disk: ['M4 5h16v6H4z', 'M4 13h16v6H4z', 'M7.5 8h.01', 'M7.5 16h.01'],
  monitor: ['M4 5h16v10H4z', 'M9 19h6', 'M12 15v4'],
  clock: ['M12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 0 0 0-16.4', 'M12 7.6V12l3.1 1.9'],
  puzzle: ['M9 4.5h3.5a1.5 1.5 0 0 1 0 3H14a1.5 1.5 0 0 1 0 3h1.2v3.4a1.5 1.5 0 0 1-3 0V15H9.8a1.5 1.5 0 0 1 0 3H6.4V6a1.5 1.5 0 0 1 1.5-1.5H9Z'],
  check: ['M12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 0 0 0-16.4', 'M8.2 12.2l2.6 2.6 5-5.2'],
  shield: ['M12 3l7 3v5.2c0 4.4-2.9 7.4-7 8.8-4.1-1.4-7-4.4-7-8.8V6z', 'M9 12l2.1 2.1L15.2 10'],
  alarm: ['M12 4.2a7 7 0 1 0 0 14a7 7 0 0 0 0-14', 'M12 8v4l2.6 1.6', 'M5.2 4.4l2 2', 'M18.8 4.4l-2 2'],
  broom: ['M14.5 3 8 13', 'M5.6 13h7.2l2.6 8H3l2.6-8Z', 'M8.5 16.4h4.2'],
  bolt: ['M13 3 5.5 14H10l-1 7 8-11h-4.5L13 3Z'],
  book: ['M5 4.5h8.5A3.5 3.5 0 0 1 17 8v11.5H8.5A3.5 3.5 0 0 1 5 16z', 'M17 8h2v11.5h-2'],
  archive: ['M4 6h16v4H4z', 'M6 10v9h12v-9', 'M10 14h4'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3', 'M12 15v2'],
  folders: ['M3.5 7h6.5l2 3h8.5v9h-17z', 'M3.5 7V5h5l1.5 2'],
  toolbox: ['M4 9h16v10H4z', 'M9 9V6h6v3', 'M4 13h16', 'M10 13v2h4v-2'],
  health: ['M12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 0 0 0-16.4', 'M12 8v8', 'M8 12h8'],
  receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6', 'M9 16h4'],
  info: ['M12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 0 0 0-16.4', 'M12 11v6', 'M12 7.8h.01'],
  alert: ['M12 4 21 20H3z', 'M12 10v4.5', 'M12 17.4h.01'],
}
