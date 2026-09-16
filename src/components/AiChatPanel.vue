<template>
  <!-- 小柴浮层：宽屏右侧 400px 面板，窄屏全屏（与 TaskDetailPanel 浮层同模式） -->
  <div
    v-if="aiChat.isOpen"
    class="fixed z-50 flex flex-col overflow-hidden shadow-2xl"
    :class="isNarrow ? 'inset-0' : 'right-0 top-0 bottom-0 w-[400px] border-l rounded-l-2xl'"
    :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
    @click="threadMenuOpen = false"
  >
    <!-- ===== 头部 ===== -->
    <div
      class="flex items-center justify-between pl-4 pr-2 h-12 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', paddingTop: isNarrow ? 'env(safe-area-inset-top)' : '0' }"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0"
          :style="{ backgroundColor: 'var(--color-accent-light)' }">
          <AppIcon name="ai" :size="16" color="var(--color-accent)" />
        </span>
        <!-- 会话切换器：历史线程列表 + 新对话 -->
        <div class="relative min-w-0" @click.stop>
          <button
            class="flex items-center gap-1 min-w-0 px-2 py-1 rounded-lg transition-all duration-150"
            :style="{ backgroundColor: threadMenuOpen ? 'var(--bg-hover)' : 'transparent' }"
            title="切换会话"
            @click="threadMenuOpen = !threadMenuOpen"
          >
            <span class="text-sm font-semibold truncate max-w-[180px]" :style="{ color: 'var(--text-primary)' }">
              {{ activeThreadTitle }}
            </span>
            <AppIcon name="chevronDown" :size="14" color="var(--text-tertiary)" />
          </button>
          <!-- 线程列表下拉 -->
          <div
            v-if="threadMenuOpen"
            class="absolute left-0 top-full mt-1 w-64 rounded-xl border shadow-lg overflow-hidden z-10"
            :style="{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)' }"
          >
            <div class="max-h-64 overflow-y-auto py-1">
              <div
                v-for="t in sortedThreads"
                :key="t.id"
                class="flex items-center gap-2 px-3 py-2 cursor-pointer transition-all duration-150 group"
                :style="{ backgroundColor: t.id === aiChat.activeThreadId ? 'var(--color-accent-light)' : 'transparent' }"
                @click="aiChat.switchThread(t.id); threadMenuOpen = false"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-sm truncate" :style="{ color: 'var(--text-primary)' }">{{ t.title }}</div>
                  <div class="text-xs" :style="{ color: 'var(--text-tertiary)' }">{{ timeAgo(t.updatedAt) }}</div>
                </div>
                <button
                  class="w-6 h-6 flex items-center justify-center rounded flex-shrink-0 text-xs"
                  :style="{ color: 'var(--text-tertiary)' }"
                  title="删除此会话"
                  @click.stop="aiChat.deleteThread(t.id)"
                >
                  ✕
                </button>
              </div>
              <div v-if="sortedThreads.length === 0" class="px-3 py-3 text-xs text-center" :style="{ color: 'var(--text-tertiary)' }">
                暂无历史会话
              </div>
            </div>
            <button
              class="w-full flex items-center gap-2 px-3 py-2.5 text-sm border-t transition-all duration-150"
              :style="{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }"
              @click="aiChat.newThread(); threadMenuOpen = false"
            >
              <AppIcon name="add" :size="14" color="var(--text-secondary)" />
              新对话
            </button>
          </div>
        </div>
      </div>
      <div class="flex items-center">
        <button
          v-if="aiChat.messages.length > 0"
          class="icon-btn w-8 h-8 flex items-center justify-center rounded-lg text-xs"
          :style="{ color: 'var(--text-tertiary)' }"
          title="清空当前会话"
          @click="handleClear"
        >
          清空
        </button>
        <button
          class="icon-btn w-8 h-8 flex items-center justify-center rounded-lg"
          :style="{ color: 'var(--text-tertiary)' }"
          title="关闭"
          @click="aiChat.close()"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- ===== 消息区 ===== -->
    <div ref="listEl" class="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
      <!-- 空状态：欢迎语 + 快捷提问 -->
      <div v-if="aiChat.messages.length === 0" class="h-full flex flex-col items-center justify-center gap-3 px-4">
        <div class="flex items-center justify-center w-14 h-14 rounded-full"
          :style="{ backgroundColor: 'var(--color-accent-light)' }">
          <AppIcon name="ai" :size="28" color="var(--color-accent)" />
        </div>
        <p class="text-sm text-center leading-relaxed" :style="{ color: 'var(--text-secondary)' }">
          {{ focusTodo ? '这个任务卡住你了？跟我说说，' : '畏难、拖延、不知道从哪开始？' }}<br>
          我陪你把大任务拆成小到不可能失败的一步。
        </p>
        <div class="flex flex-col gap-2 w-full max-w-[280px] mt-1">
          <button
            v-for="q in quickQuestions"
            :key="q"
            class="px-3 py-2 text-sm text-left rounded-xl transition-all duration-150 border"
            :style="{
              backgroundColor: 'var(--bg-app)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-secondary)',
            }"
            @click="aiChat.send(q)"
          >
            {{ q }}
          </button>
        </div>
      </div>

      <!-- 消息列表 -->
      <template v-for="m in aiChat.messages" :key="m.id">
        <!-- 系统回执：居中小字 -->
        <div v-if="m.role === 'system'" class="text-center text-xs py-0.5" :style="{ color: 'var(--text-tertiary)' }">
          {{ m.content }}
        </div>

        <!-- 用户消息：右侧气泡 -->
        <div v-else-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[82%] px-3 py-2 rounded-2xl rounded-br-md text-sm whitespace-pre-wrap break-words"
            :style="{ backgroundColor: 'var(--color-accent-light)', color: 'var(--text-primary)' }">
            {{ m.content }}
          </div>
        </div>

        <!-- AI 消息：左侧气泡 + 朗读按钮 + 建议卡片 -->
        <div v-else class="flex justify-start">
          <div class="max-w-[88%] min-w-0">
            <div class="px-3 py-2 rounded-2xl rounded-bl-md text-sm whitespace-pre-wrap break-words leading-relaxed"
              :style="m.error
                ? { backgroundColor: '#fef2f2', color: '#ef4444' }
                : { backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }">
              {{ m.content }}
            </div>

            <!-- 朗读按钮（非错误消息才有） -->
            <div v-if="!m.error && m.content.trim()" class="flex mt-0.5 ml-1">
              <button
                class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-all duration-150"
                :style="{
                  color: isSpeakingThis(m.id) ? 'var(--color-accent)' : 'var(--text-tertiary)',
                  backgroundColor: isSpeakingThis(m.id) ? 'var(--color-accent-light)' : 'transparent',
                }"
                :title="isSpeakingThis(m.id) ? '停止朗读' : '朗读这条回复'"
                @click="toggleSpeak(m)"
              >
                <AppIcon :name="isSpeakingThis(m.id) ? 'stop' : 'volume'" :size="12" :color="isSpeakingThis(m.id) ? 'var(--color-accent)' : 'var(--text-tertiary)'" />
                {{ isSpeakingThis(m.id) ? '停止' : '朗读' }}
              </button>
            </div>

            <!-- 清单调整卡片：小柴直接执行（无需确认）；历史遗留的待确认卡片仍可手动应用 -->
            <div v-if="m.actions && m.actions.length"
              class="mt-1.5 rounded-xl border px-3 py-2.5"
              :style="{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-color)' }">
              <div class="text-xs font-medium mb-1.5" :style="{ color: 'var(--text-secondary)' }">
                {{ actionCardTitle(m) }}
              </div>
              <div class="space-y-1">
                <div v-for="(label, i) in m.actionLabels" :key="i"
                  class="flex items-start gap-1.5 text-xs leading-relaxed"
                  :style="{ color: 'var(--text-secondary)' }">
                  <span class="flex-shrink-0" :style="{ color: 'var(--text-tertiary)' }">·</span>
                  <span>{{ label }}</span>
                </div>
              </div>
              <div v-if="m.actionsState === 'pending'" class="flex gap-2 mt-2.5">
                <button
                  class="px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150"
                  :style="{ backgroundColor: 'var(--color-accent)', color: '#fff' }"
                  @click="aiChat.applyActions(m.id)"
                >
                  应用到清单
                </button>
                <button
                  class="px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
                  :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
                  @click="aiChat.dismissActions(m.id)"
                >
                  忽略
                </button>
              </div>
              <div v-else-if="m.actionsState === 'applied'" class="text-xs mt-2" :style="{ color: '#22c55e' }">
                ✓ 已写入清单
              </div>
              <div v-else-if="m.actionsState === 'dismissed'" class="text-xs mt-2" :style="{ color: 'var(--text-tertiary)' }">
                已忽略
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 加载中：三点动画 -->
      <div v-if="aiChat.loading" class="flex justify-start">
        <div class="px-4 py-3 rounded-2xl rounded-bl-md flex items-center gap-1"
          :style="{ backgroundColor: 'var(--bg-hover)' }">
          <span v-for="i in 3" :key="i" class="dot-loading w-1.5 h-1.5 rounded-full"
            :style="{ backgroundColor: 'var(--text-tertiary)', animationDelay: `${(i - 1) * 0.15}s` }"></span>
        </div>
      </div>
    </div>

    <!-- ===== 输入区 ===== -->
    <div
      class="border-t flex-shrink-0 px-2.5 pt-2.5 pb-2"
      :style="{ borderColor: 'var(--border-color)', paddingBottom: isNarrow ? 'max(0.5rem, env(safe-area-inset-bottom))' : '0.5rem' }"
    >
      <div class="flex items-end gap-2">
        <textarea
          ref="inputEl"
          v-model="draft"
          rows="1"
          placeholder="说说你的困扰…"
          class="flex-1 resize-none px-3 py-2 rounded-xl border outline-none transition-all duration-150 leading-relaxed max-h-28"
          :style="{
            backgroundColor: 'var(--bg-app)',
            borderColor: 'var(--border-color)',
            color: 'var(--text-primary)',
            fontSize: '16px', // ≥16px：防 iOS 聚焦时页面自动放大
          }"
          @keydown.enter.exact.prevent="onEnterSend"
        ></textarea>
        <button
          class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl transition-all duration-150"
          :disabled="!draft.trim() || aiChat.loading"
          :style="{
            backgroundColor: draft.trim() && !aiChat.loading ? 'var(--color-accent)' : 'var(--bg-hover)',
            color: draft.trim() && !aiChat.loading ? '#fff' : 'var(--text-tertiary)',
            cursor: draft.trim() && !aiChat.loading ? 'pointer' : 'default',
          }"
          title="发送"
          @click="onSend"
        >
          <AppIcon name="send" :size="16" :color="draft.trim() && !aiChat.loading ? '#fff' : 'var(--text-tertiary)'" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAiChatStore, type ChatBubble } from '../stores/ai-chat'
import { useTodoStore } from '../stores/todo'
import { isAiConfigured } from '../services/ai/ai-client'
import { useSettingsStore } from '../stores/settings'
import { speakWithSettings, stopSpeaking, ttsState } from '../services/tts'
import AppIcon from './icons/AppIcon.vue'

const aiChat = useAiChatStore()
const todoStore = useTodoStore()
const settingsStore = useSettingsStore()
const router = useRouter()

// 窄屏全屏 / 宽屏右侧面板（与 MainLayout 的 1000px 断点一致）
const windowWidth = ref(window.innerWidth)
function updateWindowWidth() {
  windowWidth.value = window.innerWidth
}
onMounted(() => window.addEventListener('resize', updateWindowWidth))
onUnmounted(() => window.removeEventListener('resize', updateWindowWidth))
const isNarrow = computed(() => windowWidth.value < 1000)

const focusTodo = computed(() =>
  aiChat.focusTodoId ? todoStore.todos.find(t => t.id === aiChat.focusTodoId) ?? null : null,
)

// ============ 会话切换器 ============

const threadMenuOpen = ref(false)
const sortedThreads = computed(() =>
  aiChat.threads.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
)
const activeThreadTitle = computed(() => {
  const t = aiChat.threads.find(x => x.id === aiChat.activeThreadId)
  return t?.title || '小柴'
})

function timeAgo(iso: string): string {
  const ts = new Date(iso).getTime()
  if (isNaN(ts)) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

// 空态快捷提问：有聚焦任务时围绕当前任务
const quickQuestions = computed(() => {
  if (focusTodo.value) {
    return ['这个任务让我有点畏难', '帮我把它拆成小步骤', '不知道从哪开始，给我指个方向']
  }
  return ['最近有点拖延，鼓励我一下', '任务太多不知道先做哪个', '教我怎么把任务拆小']
})

const draft = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

function onEnterSend() {
  // 窄屏（移动端软键盘）Enter 换行，发送靠按钮
  if (isNarrow.value) return
  onSend()
}

function onSend() {
  const text = draft.value.trim()
  if (!text || aiChat.loading) return
  // 未配置时引导去设置页（不空转请求）
  if (!isAiConfigured(settingsStore.settings.ai) && aiChat.messages.length === 0) {
    aiChat.close()
    router.push('/settings')
    return
  }
  draft.value = ''
  aiChat.send(text)
}

function handleClear() {
  if (confirm('确定清空当前会话的全部消息吗？')) {
    aiChat.clearChat()
  }
}

/** 清单调整卡片的标题：按状态区分「已写入 / 已忽略 / 待确认（历史遗留）」 */
function actionCardTitle(m: ChatBubble): string {
  const n = m.actions?.length ?? 0
  if (m.actionsState === 'applied') return `已调整清单（${n} 条）`
  if (m.actionsState === 'dismissed') return `建议调整清单（${n} 条，已忽略）`
  return `建议调整清单（${n} 条，确认后生效）`
}

// ============ 朗读 ============

function isSpeakingThis(msgId: string): boolean {
  return ttsState.speaking && ttsState.speakingMessageId === msgId
}

function toggleSpeak(m: ChatBubble) {
  if (isSpeakingThis(m.id)) {
    stopSpeaking()
    return
  }
  speakWithSettings(m.content, settingsStore.settings.tts, { messageId: m.id })
    .catch(err => console.warn('[AI] 朗读失败:', err))
}

// 面板关闭时停止朗读
watch(
  () => aiChat.isOpen,
  (open) => {
    if (!open) stopSpeaking()
  },
)

// 新消息/加载态变化时滚到底部
watch(
  () => [aiChat.messages.length, aiChat.loading],
  () => {
    nextTick(() => {
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    })
  },
)

// 打开面板时聚焦输入框（桌面端），并收起会话下拉
watch(
  () => aiChat.isOpen,
  (open) => {
    if (open) {
      threadMenuOpen.value = false
      if (!isNarrow.value) {
        nextTick(() => inputEl.value?.focus())
      }
    }
  },
)
</script>

<style scoped>
.dot-loading {
  animation: ai-dot-bounce 1s ease-in-out infinite;
}
@keyframes ai-dot-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
</style>
