<template>
  <svg
    :viewBox="icon.viewBox"
    :width="size"
    :height="size"
    :fill="icon.fill || 'none'"
    :stroke="color"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    xmlns="http://www.w3.org/2000/svg"
    class="inline-block flex-shrink-0"
    :style="{ verticalAlign: 'middle' }"
  >
    <template v-for="(path, i) in icon.paths" :key="i">
      <path v-if="typeof path === 'string'" :d="path" />
      <circle v-else-if="path.type === 'circle'" :cx="path.cx" :cy="path.cy" :r="path.r" :fill="path.fill || 'none'" :stroke="path.stroke" />
      <rect v-else-if="path.type === 'rect'" :x="path.x" :y="path.y" :width="path.width" :height="path.height" :rx="path.rx" :fill="path.fill || 'none'" :stroke="path.stroke" />
    </template>
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  name: string
  size?: number
  color?: string
  strokeWidth?: number
}>(), {
  size: 20,
  color: 'currentColor',
  strokeWidth: 2,
})

// ============ 图标定义 ============
// 全部为卡通风格：圆头端点、圆角连接、柔和比例

interface IconDef {
  viewBox: string
  fill?: string
  paths: (string | { type: string; [key: string]: any })[]
}

const icons: Record<string, IconDef> = {
  // 📥 收集箱 - 一个可爱的小收纳盒带把手
  inbox: {
    viewBox: '0 0 24 24',
    paths: [
      'M3 10v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8',
      'M3 10l2-5h14l2 5',
      'M3 10h18',
      'M12 14v-4',
    ],
  },

  // 📌 今天 - 一个小旗帜/图钉
  today: {
    viewBox: '0 0 24 24',
    paths: [
      'M6 3v18',
      'M6 3l12 7-12 7',
    ],
  },

  // 📅 最近7天 - 日历页带可爱波浪
  next7: {
    viewBox: '0 0 24 24',
    paths: [
      'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z',
      'M8 3v4',
      'M16 3v4',
      'M4 11h16',
      'M12 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
      'M12 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
      'M12 14a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
    ],
  },

  // 🗓️ 日历 - 简洁日历带可爱笑脸圆点
  calendar: {
    viewBox: '0 0 24 24',
    paths: [
      'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z',
      'M8 3v4',
      'M16 3v4',
      'M4 11h16',
      { type: 'circle', cx: 12, cy: 16, r: 2, fill: 'none' },
    ],
  },

  // 🔲 四象限 - 四个小方块
  matrix: {
    viewBox: '0 0 24 24',
    paths: [
      'M3 3h8v8H3z',
      'M13 3h8v8h-8z',
      'M3 13h8v8H3z',
      'M13 13h8v8h-8z',
    ],
  },

  // ✅ 已完成 - 可爱勾勾
  completed: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 10, fill: 'none' },
      'M8 12l3 3 5-5',
    ],
  },

  // ⚙️ 设置 - 小齿轮
  settings: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 3, fill: 'none' },
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    ],
  },

  // 🔍 搜索 - 放大镜
  search: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 11, cy: 11, r: 7, fill: 'none' },
      'M16.5 16.5L21 21',
    ],
  },

  // ➕ 添加 - 圆角加号
  add: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 10, fill: 'none' },
      'M12 8v8',
      'M8 12h8',
    ],
  },

  // ✏️ 编辑 - 小铅笔
  edit: {
    viewBox: '0 0 24 24',
    paths: [
      'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
    ],
  },

  // 🗑️ 删除 - 垃圾桶
  delete: {
    viewBox: '0 0 24 24',
    paths: [
      'M3 6h18',
      'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
      'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
      'M10 11v6',
      'M14 11v6',
    ],
  },

  // ☀️ 亮色主题 - 可爱太阳
  sun: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 5, fill: 'none' },
      'M12 1v2',
      'M12 21v2',
      'M4.22 4.22l1.42 1.42',
      'M18.36 18.36l1.42 1.42',
      'M1 12h2',
      'M21 12h2',
      'M4.22 19.78l1.42-1.42',
      'M18.36 5.64l1.42-1.42',
    ],
  },

  // 🌙 暗黑主题 - 可爱月亮
  moon: {
    viewBox: '0 0 24 24',
    paths: [
      'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    ],
  },

  // 🌓 跟随系统 - 半边太阳半边月亮
  system: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 10, fill: 'none' },
      'M12 2a10 10 0 0 0 0 20 8 8 0 0 1 0-16 10 10 0 0 1 0-4z',
    ],
  },

  // 💾 存储 - 小硬盘
  storage: {
    viewBox: '0 0 24 24',
    paths: [
      'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
      'M4 8h16',
      'M9 12h6',
      'M9 16h6',
    ],
  },

  // 🔄 同步 - 旋转箭头
  sync: {
    viewBox: '0 0 24 24',
    paths: [
      'M1 4v6h6',
      'M23 20v-6h-6',
      'M20.49 9A9 9 0 0 0 5.64 5.64L1 10',
      'M22 14l-4.64 4.36A9 9 0 0 1 3.51 15',
    ],
  },

  // 🎨 主题 - 调色板
  palette: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 10, fill: 'none' },
      'M12 2a10 10 0 0 0 0 20 3 3 0 0 0 3-3v-1a2 2 0 0 1 2-2h2.82A10 10 0 0 0 12 2z',
      { type: 'circle', cx: 7.5, cy: 9.5, r: 1.5, fill: 'currentColor', stroke: 'none' },
      { type: 'circle', cx: 12, cy: 7.5, r: 1.5, fill: 'currentColor', stroke: 'none' },
      { type: 'circle', cx: 16.5, cy: 9.5, r: 1.5, fill: 'currentColor', stroke: 'none' },
    ],
  },

  // 📋 关于 - 信息卡片
  about: {
    viewBox: '0 0 24 24',
    paths: [
      { type: 'circle', cx: 12, cy: 12, r: 10, fill: 'none' },
      'M12 16v-4',
      'M12 8h.01',
    ],
  },

  // ◀ 左箭头
  chevronLeft: {
    viewBox: '0 0 24 24',
    paths: ['M15 18l-6-6 6-6'],
  },

  // ▶ 右箭头
  chevronRight: {
    viewBox: '0 0 24 24',
    paths: ['M9 18l6-6-6-6'],
  },

  // ▼ 下箭头
  chevronDown: {
    viewBox: '0 0 24 24',
    paths: ['M6 9l6 6 6-6'],
  },

  // 四象限 - 重要紧急 红色
  quadrantUrgent: {
    viewBox: '0 0 24 24',
    paths: [
      'M12 2L2 7l10 5 10-5-10-5z',
      'M2 17l10 5 10-5',
      'M2 12l10 5 10-5',
    ],
  },

  // 小旗子 - 用于今天视图
  flag: {
    viewBox: '0 0 24 24',
    paths: [
      'M4 21V3h13l-2 5 2 5H4',
    ],
  },

  // 星星 - 用于收藏或重要
  star: {
    viewBox: '0 0 24 24',
    paths: [
      'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    ],
  },

  // 小日历 - 用于日期
  calendarSmall: {
    viewBox: '0 0 24 24',
    paths: [
      'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
      'M8 3v4',
      'M16 3v4',
      'M3 11h18',
      'M8 15h.01',
      'M12 15h.01',
      'M16 15h.01',
    ],
  },

  // 📝 笔记 - 记事本
  notes: {
    viewBox: '0 0 24 24',
    paths: [
      'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
      'M8 8h8',
      'M8 12h8',
      'M8 16h5',
    ],
  },

  // 📦 归档 - 归档箱
  archive: {
    viewBox: '0 0 24 24',
    paths: [
      'M3 8h18',
      'M4 8l1.2 12h13.6L20 8',
      'M9 12h6',
    ],
  },

  // ↩️ 恢复 - 撤销箭头
  restore: {
    viewBox: '0 0 24 24',
    paths: [
      'M3 12a9 9 0 1 0 2.6-6.4',
      'M3 4v5h5',
    ],
  },

  // 🐶 小柴 - 圆润对话气泡 + 三个点
  ai: {
    viewBox: '0 0 24 24',
    paths: [
      'M7.9 20A9 9 0 1 0 4 16.1L2 22z',
      'M8 12h.01',
      'M12 12h.01',
      'M16 12h.01',
    ],
  },

  // ✈️ 发送 - 纸飞机
  send: {
    viewBox: '0 0 24 24',
    paths: [
      'M21 3L10 14',
      'M21 3l-7 19-4-8-8-4z',
    ],
  },

  // 🔊 朗读 - 喇叭 + 声波
  volume: {
    viewBox: '0 0 24 24',
    paths: [
      'M11 5L6 9H3v6h3l5 4V5z',
      'M15.5 8.5a5 5 0 0 1 0 7',
      'M18.5 6a9 9 0 0 1 0 12',
    ],
  },

  // ⏹ 停止 - 圆角方块
  stop: {
    viewBox: '0 0 24 24',
    paths: [
      'M7 7h10v10H7z',
    ],
  },

  // ↓ 排序：新的在前（倒序）- 长线在上 + 向下箭头
  sortDesc: {
    viewBox: '0 0 24 24',
    paths: [
      'M4 6h11',
      'M4 12h8',
      'M4 18h5',
      'M17 6v9',
      'M14.5 12.5L17 15l2.5-2.5',
    ],
  },

  // ↑ 排序：旧的在前（正序）- 长线在下 + 向上箭头
  sortAsc: {
    viewBox: '0 0 24 24',
    paths: [
      'M4 6h5',
      'M4 12h8',
      'M4 18h11',
      'M17 18V9',
      'M14.5 11.5L17 9l2.5 2.5',
    ],
  },
}

const icon = computed(() => {
  return icons[props.name] || icons.inbox
})
</script>
