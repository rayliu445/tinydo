/**
 * 优先级 → 勾选框边框色（对齐滴答清单：勾选框边框随优先级染色）。
 * 色值与 index.css 的 .priority-dot 保持同色系。
 * 无优先级返回 undefined，CSS 端走 var(--prio-border, 默认色) 回退。
 */
export function prioBorderColor(priority?: number): string | undefined {
  switch (priority) {
    case 5: return '#e74c3c' // 高：红
    case 3: return '#e88c31' // 中：橙
    case 1: return '#3498db' // 低：蓝
    default: return undefined
  }
}
