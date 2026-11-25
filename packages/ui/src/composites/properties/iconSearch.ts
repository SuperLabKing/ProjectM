// Search descriptions for frequently used project icons. The host supplies the actual IDs.
const keywords: Record<string, string> = {
  'flask-conical': '实验 实验室 锥形瓶 烧瓶 化学 试剂 lab experiment chemistry',
  'test-tube': '实验 实验室 试管 样品 lab experiment sample',
  microscope: '显微镜 显微 成像 观察 实验 microscopy imaging lab',
  dna: '基因 基因组 遗传 DNA genome genetics',
  'file-text': '笔记 文件 文档 记录 note document',
  'book-open': '文献 阅读 书籍 资料 paper literature reading',
  library: '文献 资料库 图书馆 library reference literature',
  search: '搜索 查找 检索 调研 lookup research',
  'clipboard-list': '清单 待办 任务 检查 checklist tasks',
  'list-todo': '清单 待办 任务 checklist tasks',
  'circle-check': '完成 核对 通过 done complete success',
  'calendar-days': '日程 日历 排期 schedule month',
  'clock': '时间 计时 时钟 time timer',
  'folder-open': '文件夹 目录 归档 directory archive',
  'folder-kanban': '项目 看板 任务 项目管理 project planning',
  'chart-bar': '统计 数据 图表 柱状图 analysis statistics graph',
  'chart-line': '数据 分析 趋势 折线图 analysis trend graph',
  'database': '数据库 数据 存档 storage',
  'target': '目标 靶点 定位 goal aim',
  'milestone': '里程碑 阶段 milestone',
  'waypoints': '流程 依赖 关系 workflow dependency',
  'lightbulb': '想法 灵感 创意 idea inspiration',
  'rocket': '发布 上线 启动 launch release',
  'users': '团队 成员 人员 协作 team people',
  'settings': '设置 配置 齿轮 config gear',
  'wrench': '工具 维护 修复 tool maintenance',
  'camera': '相机 拍照 图像 照片 photo picture',
  'image': '图片 图像 照片 photo picture',
  'check': '对勾 勾选 通过 tick verified',
  'triangle-alert': '提醒 警告 风险 warning alert',
  'pin': '置顶 图钉 固定 pinned'
}

export const commonProjectIcons = [
  'folder-kanban', 'clipboard-list', 'calendar-days', 'target',
  'file-text', 'book-open', 'flask-conical', 'microscope'
]

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/^lucide[\s_-]+/, '').replace(/[\s_-]+/g, ' ')
}

export function makeIconSearch(ids: string[]) {
  const entries = ids.map((id) => {
    const name = normalize(id)
    return { id, name, aliases: (keywords[name.replace(/ /g, '-')] ?? '').toLowerCase().split(' ') }
  })
  const catalog = new Map(entries.map(({ name, id }) => [name, id]))
  return {
    resolve: (id: string) => catalog.get(normalize(id)),
    match(query: string): string[] {
      const text = normalize(query)
      if (!text) return ids
      const tokens = text.split(' ')
      return entries.flatMap(({ id, name, aliases }) => {
        if (name === text) return [{ id, rank: 0 }]
        if (aliases.includes(text)) return [{ id, rank: 1 }]
        if (name.startsWith(text)) return [{ id, rank: 2 }]
        if (tokens.every((token) => name.includes(token))) return [{ id, rank: 3 }]
        if (tokens.every((token) => name.includes(token) || aliases.some((alias) => alias.includes(token)))) {
          return [{ id, rank: 4 }]
        }
        return []
      }).sort((a, b) => a.rank - b.rank).map(({ id }) => id)
    }
  }
}
