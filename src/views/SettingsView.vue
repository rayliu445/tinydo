<template>
  <div class="flex flex-col h-full overflow-hidden" :style="{ backgroundColor: 'var(--bg-app)' }">
    <!-- 页面头部 -->
    <div class="flex items-center justify-between px-6 h-14 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }">
      <h1 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">设置</h1>
    </div>

    <!-- Tab 切换栏 -->
    <div class="flex gap-1 px-4 py-3 border-b flex-shrink-0 overflow-x-auto"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }">
      <button
        v-for="t in tabs" :key="t.id"
        class="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150 flex-shrink-0"
        :style="getTabStyle(t.id)"
        @click="activeTab = t.id"
      >
        <AppIcon :name="t.icon" :size="16" :color="activeTab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)'" />
        {{ t.label }}
      </button>
    </div>

    <!-- 内容区 -->
    <div class="flex-1 overflow-y-auto">
      <!-- ===== 存储 ===== -->
      <div v-if="activeTab === 'storage'" class="p-6 max-w-2xl space-y-4">
        <div class="rounded-xl p-5" :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="flex items-start gap-4">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              :style="{ backgroundColor: 'var(--bg-hover)' }">
              <AppIcon name="storage" :size="20" color="var(--text-secondary)" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">本地存储</div>
              <div class="text-xs mt-0.5 mb-3" :style="{ color: 'var(--text-secondary)' }">数据存储在浏览器本地，关闭页面也不会丢失</div>
              <div class="flex items-center gap-2 text-xs">
                <span class="w-2 h-2 rounded-full" style="background-color: #22c55e"></span>
                <span class="font-medium" style="color: #22c55e">运行正常</span>
                <span class="mx-1" :style="{ color: 'var(--text-tertiary)' }">|</span>
                <span :style="{ color: 'var(--text-secondary)' }">IndexedDB + localStorage 双备份</span>
              </div>
            </div>
          </div>
        </div>
        <div class="flex gap-2">
          <button class="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg transition-all duration-150"
            :style="{ backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }"
            @click="exportData">
            <AppIcon name="add" :size="14" color="var(--text-secondary)" />
            <span>导出数据</span>
          </button>
          <button class="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg transition-all duration-150"
            :style="{ backgroundColor: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }"
            @click="importData">
            <AppIcon name="edit" :size="14" color="var(--text-secondary)" />
            <span>导入数据</span>
          </button>
        </div>
      </div>

      <!-- ===== 同步 ===== -->
      <div v-if="activeTab === 'sync'" class="p-6 max-w-2xl space-y-4">
        <div v-if="store.isSyncEnabled" class="rounded-xl p-4"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <span class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: syncDotColor }"></span>
              <span class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">{{ syncStatusText }}</span>
              <span v-if="lastSyncTime" class="text-xs" :style="{ color: 'var(--text-tertiary)' }">上次：{{ lastSyncTime }}</span>
            </div>
            <button class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
              :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }"
              @click="handleSyncNow">
              <AppIcon name="sync" :size="12" color="var(--text-secondary)" />
              同步
            </button>
          </div>
          <div v-if="syncErrorMessage" class="mt-2 text-xs px-3 py-2 rounded-lg"
            :style="{ backgroundColor: '#fef2f2', color: '#ef4444' }">
            {{ syncErrorMessage }}
          </div>
          <!-- 同步诊断：让用户看到云端/本地任务数等真相，便于定位问题 -->
          <div v-if="syncDetail" class="mt-2 text-xs px-3 py-2 rounded-lg space-y-0.5"
            :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }">
            <div class="font-medium" :style="{ color: 'var(--text-primary)' }">同步诊断</div>
            <template v-if="syncDetail.error">
              <div>阶段：{{ syncDetail.stage || '未知' }}</div>
              <div>错误：{{ syncDetail.error }}</div>
            </template>
            <template v-else>
              <div v-if="syncDetail.cloudBytes !== undefined">云端文件：{{ syncDetail.cloudBytes === null ? '无（首次）' : (syncDetail.cloudBytes / 1024).toFixed(1) + ' KB' }}</div>
              <div v-if="syncDetail.cloudTodos !== undefined">云端任务：{{ syncDetail.cloudTodos }}</div>
              <div v-if="syncDetail.localTodos !== undefined">本地任务：{{ syncDetail.localTodos }}</div>
              <div v-if="syncDetail.mergedTodos !== undefined">合并后：{{ syncDetail.mergedTodos }}</div>
            </template>
          </div>
        </div>

        <!-- 七牛云配置卡片 -->
        <div class="rounded-xl overflow-hidden"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="flex items-center justify-between px-5 py-4">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl flex items-center justify-center"
                :style="{ backgroundColor: '#f0f9ff' }">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#0284c7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2a10 10 0 0 1 7.07 17.07A10 10 0 0 1 4.93 4.93 10 10 0 0 1 12 2z"/>
                  <path d="M8 12l3 3 5-5"/>
                </svg>
              </div>
              <div>
                <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">七牛云 Kodo</div>
                <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">10GB 免费存储，国内直连</div>
              </div>
            </div>
            <span v-if="store.activeProvider?.status === 'connected'" class="text-xs font-medium px-2.5 py-0.5 rounded-full"
              :style="{ backgroundColor: '#f0fdf4', color: '#22c55e' }">已连接</span>
            <span v-else-if="store.activeProvider?.status === 'connecting'" class="text-xs font-medium px-2.5 py-0.5 rounded-full"
              :style="{ backgroundColor: '#eff6ff', color: '#3b82f6' }">连接中...</span>
            <span v-else-if="store.activeProvider?.status === 'error'" class="text-xs font-medium px-2.5 py-0.5 rounded-full"
              :style="{ backgroundColor: '#fef2f2', color: '#ef4444' }">连接失败</span>
            <span v-else class="text-xs" :style="{ color: 'var(--text-tertiary)' }">未配置</span>
          </div>
          <div v-if="store.activeProvider?.status === 'error' && store.activeProvider?.lastError"
            class="px-5 py-2 text-xs" :style="{ backgroundColor: '#fef2f2', color: '#ef4444' }">
            错误：{{ store.activeProvider.lastError }}
          </div>

          <div class="px-5 py-4 border-t space-y-3"
            :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-app)' }">
            <div v-for="field in kodoFields" :key="field.key" class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">{{ field.label }}</label>
              <input
                v-model="store.settings.providers[0].config[field.key]"
                :type="field.type || 'text'"
                :placeholder="field.placeholder"
                class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150"
                :style="{
                  backgroundColor: 'var(--bg-card)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                }"
              />
              <div v-if="field.hint" class="text-xs" :style="{ color: 'var(--text-tertiary)' }">{{ field.hint }}</div>
            </div>

            <div class="flex items-center gap-2 pt-2">
              <button v-if="!store.activeProvider?.enabled"
                class="px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }"
                @click="handleEnableProvider('kodo-default')">连接</button>
              <button v-else
                class="px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150"
                :style="{ backgroundColor: '#fef2f2', color: '#ef4444' }"
                @click="handleDisconnect">断开</button>
              <button class="px-4 py-2 text-sm rounded-lg transition-all duration-150 ml-auto"
                :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
                :disabled="isTesting"
                @click="handleTestConnection">
                <span v-if="isTesting">测试中...</span>
                <span v-else>测试连接</span>
              </button>
            </div>
            <div v-if="testResult" class="text-xs mt-1"
              :style="{ color: testResult.ok ? '#22c55e' : '#ef4444' }">
              {{ testResult.ok ? '✓ ' : '✗ ' }}{{ testResult.message }}
            </div>
          </div>
        </div>
      </div>

      <!-- ===== AI 助手 ===== -->
      <div v-if="activeTab === 'ai'" class="p-6 max-w-2xl space-y-4">
        <div class="rounded-xl p-5" :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="flex items-start gap-4">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              :style="{ backgroundColor: 'var(--color-accent-light)' }">
              <AppIcon name="ai" :size="20" color="var(--color-accent)" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">小柴</div>
              <div class="text-xs mt-0.5" :style="{ color: 'var(--text-secondary)' }">
                畏难或不知道怎么拆任务时，找小柴聊聊。小柴会鼓励你，并在你同意后把大任务拆小写进清单。兼容 OpenAI 接口格式，API Key 仅保存在本机。
              </div>
            </div>
          </div>
        </div>

        <!-- AI 配置卡片 -->
        <div class="rounded-xl overflow-hidden"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="px-5 py-4 space-y-3"
            :style="{ backgroundColor: 'var(--bg-app)' }">
            <div v-for="field in aiFields" :key="field.key" class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">{{ field.label }}</label>
              <input
                v-model="aiForm[field.key]"
                :type="field.type || 'text'"
                :placeholder="field.placeholder"
                class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150"
                :style="{
                  backgroundColor: 'var(--bg-card)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                }"
                @change="saveAi"
              />
              <div v-if="field.hint" class="text-xs" :style="{ color: 'var(--text-tertiary)' }">{{ field.hint }}</div>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">自定义提示词（可选）</label>
              <textarea
                v-model="aiForm.customPrompt"
                rows="4"
                placeholder="例如：语气更轻松一点，多用比喻；重点关注我的deadline焦虑…"
                class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150 resize-y"
                :style="{
                  backgroundColor: 'var(--bg-card)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                }"
                @change="saveAi"
              ></textarea>
              <div class="text-xs" :style="{ color: 'var(--text-tertiary)' }">
                追加在默认人设之后生效，可调整语气与关注点
              </div>
            </div>

            <div class="flex items-center gap-2 pt-2">
              <button class="px-4 py-2 text-sm rounded-lg transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
                :disabled="isTestingAi"
                @click="handleTestAi">
                <span v-if="isTestingAi">测试中...</span>
                <span v-else>测试连接</span>
              </button>
            </div>
            <div v-if="aiTestResult" class="text-xs mt-1"
              :style="{ color: aiTestResult.ok ? '#22c55e' : '#ef4444' }">
              {{ aiTestResult.ok ? '✓ ' : '✗ ' }}{{ aiTestResult.message }}
            </div>
          </div>
        </div>
        <!-- 朗读（TTS）卡片 -->
        <div class="rounded-xl overflow-hidden"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="px-5 py-4 space-y-3"
            :style="{ backgroundColor: 'var(--bg-app)' }">
            <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">朗读</div>
            <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">
              让小柴把回复读给你听。系统语音离线可用；Edge TTS 音质更自然但需要网络，失败会自动降级为系统语音。
            </div>

            <label class="flex items-center gap-2 text-sm cursor-pointer" :style="{ color: 'var(--text-secondary)' }">
              <input v-model="ttsForm.autoSpeak" type="checkbox" class="checkbox-tick" @change="saveTts" />
              AI 回复后自动朗读
            </label>

            <div class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">朗读引擎</label>
              <div class="flex gap-2">
                <button
                  v-for="eng in ttsEngineOptions" :key="eng.value"
                  class="flex-1 py-2 text-xs rounded-lg transition-all duration-150 font-medium"
                  :style="ttsEngineBtnStyle(eng.value)"
                  @click="ttsForm.engine = eng.value; saveTts()"
                >
                  {{ eng.label }}
                </button>
              </div>
              <div class="text-xs" :style="{ color: 'var(--text-tertiary)' }">{{ activeEngineHint }}</div>
            </div>

            <div v-if="ttsForm.engine !== 'system'" class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">声音</label>
              <select
                v-model="ttsForm.edgeVoice"
                class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }"
                @change="saveTts"
              >
                <option v-for="v in edgeVoices" :key="v.value" :value="v.value">{{ v.label }}</option>
              </select>
            </div>

            <div v-if="ttsForm.engine === 'azure'" class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">Azure 区域</label>
              <select
                v-model="ttsForm.azureRegion"
                class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }"
                @change="saveTts"
              >
                <option v-for="r in azureRegions" :key="r.value" :value="r.value">{{ r.label }}</option>
              </select>
              <div class="text-xs" :style="{ color: 'var(--text-tertiary)' }">与创建 Speech 资源时选择的区域一致</div>
            </div>

            <div v-if="ttsForm.engine === 'azure'" class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">Azure 密钥（仅存本机）</label>
              <input
                v-model="ttsForm.azureKey"
                type="password"
                placeholder="Azure Speech 资源的 Key"
                class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }"
                @change="saveTts"
              />
              <div class="text-xs" :style="{ color: 'var(--text-tertiary)' }">Azure 门户 → Speech 服务 → 密钥和终结点；免费层 F0 每月 50 万字符</div>
            </div>

            <div class="space-y-1">
              <label class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">
                语速（{{ ttsForm.rate.toFixed(1) }}×）
              </label>
              <input
                v-model.number="ttsForm.rate"
                type="range" min="0.5" max="2" step="0.1"
                class="w-full"
                @change="saveTts"
              />
            </div>

            <div class="flex items-center gap-2 pt-1">
              <button class="px-4 py-2 text-sm rounded-lg transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
                :disabled="ttsState.speaking"
                @click="handleTestSpeak">
                <span v-if="ttsState.speaking">朗读中…（点击无效）</span>
                <span v-else>试听</span>
              </button>
              <button v-if="ttsState.speaking"
                class="px-4 py-2 text-sm rounded-lg transition-all duration-150"
                :style="{ backgroundColor: 'var(--bg-hover)', color: '#ef4444' }"
                @click="stopSpeaking">
                停止
              </button>
            </div>
            <div v-if="ttsState.engineUsed" class="text-xs space-y-0.5">
              <div :style="{ color: ttsState.engineUsed === 'edge' ? '#22c55e' : '#f59e0b' }">
                上次朗读实际使用：{{ ttsState.engineUsed === 'edge' ? 'Edge TTS（云端语音，音色随设置变化）' : ttsState.engineUsed === 'azure' ? 'Azure 官方接口（云端语音，音色随设置变化）' : '系统语音（声音较机械，与音色设置无关）' }}
              </div>
              <div v-if="ttsState.lastFallbackReason && ttsState.engineUsed === 'system'"
                :style="{ color: 'var(--text-tertiary)' }">
                降级原因：{{ ttsState.lastFallbackReason }}。多为网络到微软接口不通或被限流，可稍后重试或切换网络。
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 主题 ===== -->
      <div v-if="activeTab === 'theme'" class="p-6 max-w-2xl space-y-3">
        <div class="rounded-xl p-5"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="text-sm font-medium mb-4" :style="{ color: 'var(--text-primary)' }">外观主题</div>
          <div class="space-y-2">
            <label v-for="opt in themeOptions" :key="opt.value"
              class="flex items-center justify-between p-3 rounded-lg cursor-pointer transition-all duration-150"
              :style="getThemeOptionStyle(opt.value)"
              @click="setThemeMode(opt.value)">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-lg flex items-center justify-center"
                  :style="{ backgroundColor: tm === opt.value ? 'var(--color-accent-light)' : 'var(--bg-hover)' }">
                  <AppIcon :name="opt.icon" :size="18" :color="tm === opt.value ? 'var(--color-accent)' : 'var(--text-secondary)'" />
                </div>
                <div>
                  <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">{{ opt.label }}</div>
                  <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">{{ opt.desc }}</div>
                </div>
              </div>
              <span v-if="tm === opt.value" :style="{ color: 'var(--text-primary)' }" class="text-sm font-medium">✓</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ===== 关于 ===== -->
      <div v-if="activeTab === 'about'" class="p-6 max-w-2xl space-y-3">
        <div class="rounded-xl p-8 text-center"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-3"
            :style="{ backgroundColor: 'var(--color-accent-light)' }">
            <AppIcon name="about" :size="32" color="var(--color-accent)" />
          </div>
          <div class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">TinyDo</div>
          <div class="text-sm mt-0.5 mb-4" :style="{ color: 'var(--text-secondary)' }">对标滴答清单的个人任务管理工具</div>
          <div class="inline-flex items-center gap-2 text-xs rounded-full px-4 py-1.5"
            :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }">
            <span>v{{ appVersion }}</span>
            <span class="w-1 h-1 rounded-full" :style="{ backgroundColor: 'var(--text-tertiary)' }"></span>
            <span>Vue 3 + SQLite</span>
          </div>
          <div class="mt-4 flex justify-center gap-3">
            <a href="https://github.com/rayliu445" target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
              :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
              作者主页
            </a>
            <a href="https://github.com/rayliu445/tinydo" target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
              :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
              项目仓库
            </a>
          </div>
        </div>
        <!-- 软件更新卡片 -->
        <div class="rounded-xl p-5"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="flex items-center justify-between mb-4">
            <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">软件更新</div>
            <button v-if="isElectron && updateState === 'idle'"
              class="px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
              :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }"
              @click="handleCheckUpdate">检查更新</button>
            <button v-else-if="isIOS && iosUpdateState === 'idle'"
              class="px-3 py-1.5 text-xs rounded-lg transition-all duration-150"
              :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }"
              @click="handleCheckIOSUpdate">检查更新</button>
          </div>

          <!-- iOS 专属更新检查（仅 iOS 显示） -->
          <template v-if="isIOS">
            <div v-if="iosUpdateState === 'idle'" class="text-xs" :style="{ color: 'var(--text-secondary)' }">
              检查 iOS 版是否有新版本，发现后可下载新 ipa 覆盖安装。
            </div>
            <div v-else-if="iosUpdateState === 'checking'" class="text-xs" :style="{ color: 'var(--text-secondary)' }">
              正在检查更新...
            </div>
            <div v-else-if="iosUpdateState === 'none'" class="text-xs" :style="{ color: '#22c55e' }">
              ✓ 已是最新版本（v{{ appVersion }}）
            </div>
            <div v-else-if="iosUpdateState === 'available'" class="space-y-3">
              <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">
                发现新版本 <span class="font-medium" :style="{ color: 'var(--text-primary)' }">v{{ iosUpdateInfo?.latestVersion }}</span>
                （当前 v{{ appVersion }}）
              </div>
              <a
                :href="iosUpdateInfo?.downloadUrl"
                target="_blank" rel="noopener noreferrer"
                class="inline-flex px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150"
                :style="{ backgroundColor: 'var(--color-accent-light)', color: 'var(--text-primary)' }"
              >下载新版本 ipa</a>
              <div class="text-xs" :style="{ color: 'var(--text-tertiary)' }">
                下载后用 Sideloadly 签名安装（覆盖更新，数据保留）。
              </div>
            </div>
            <div v-else-if="iosUpdateState === 'error'" class="space-y-2">
              <div class="text-xs" :style="{ color: '#ef4444' }">检查失败：{{ iosUpdateError }}</div>
              <button class="px-3 py-1.5 text-xs rounded-lg"
                :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }"
                @click="handleCheckIOSUpdate">重试</button>
            </div>
          </template>

          <!-- 桌面 Electron 自动更新 -->
          <template v-else-if="isElectron">
            <div v-if="updateState === 'checking'" class="text-xs" :style="{ color: 'var(--text-secondary)' }">
              正在检查更新...
            </div>
            <div v-else-if="updateState === 'none'" class="text-xs" :style="{ color: '#22c55e' }">
              ✓ 已是最新版本（v{{ appVersion }}）
            </div>
            <div v-else-if="updateState === 'available'" class="space-y-3">
              <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">
                发现新版本 <span class="font-medium" :style="{ color: 'var(--text-primary)' }">v{{ updateInfo?.latestVersion }}</span>
                （当前 v{{ appVersion }}）
              </div>
              <button class="px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150"
                :style="{ backgroundColor: 'var(--color-accent-light)', color: 'var(--text-primary)' }"
                @click="handleInstallUpdate">下载并安装</button>
            </div>
            <div v-else-if="updateState === 'updating'" class="space-y-2">
              <div class="text-xs" :style="{ color: 'var(--text-secondary)' }">正在下载 v{{ updateInfo?.latestVersion }} ... {{ updateProgress }}%</div>
              <div class="w-full h-2 rounded-full" :style="{ backgroundColor: 'var(--bg-hover)' }">
                <div class="h-2 rounded-full transition-all duration-150" :style="{ width: updateProgress + '%', backgroundColor: 'var(--color-accent)' }"></div>
              </div>
            </div>
            <div v-else-if="updateState === 'done'" class="text-xs" :style="{ color: '#22c55e' }">
              ✓ 新版本已安装完成，应用即将自动重启（任务数据与同步配置会保留）。
            </div>
            <div v-else-if="updateState === 'error'" class="space-y-2">
              <div class="text-xs" :style="{ color: '#ef4444' }">更新失败：{{ updateError }}</div>
              <button class="px-3 py-1.5 text-xs rounded-lg"
                :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' }"
                @click="handleCheckUpdate">重试</button>
            </div>
          </template>

          <!-- 其他平台（Web / Android） -->
          <div v-else class="text-xs" :style="{ color: 'var(--text-secondary)' }">
            桌面版支持自动更新，Web 版请前往 GitHub Releases 下载最新安装包。
          </div>
        </div>

        <div class="rounded-xl p-5"
          :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }">
          <div class="text-xs font-medium mb-3" :style="{ color: 'var(--text-secondary)' }">功能列表</div>
          <div class="grid grid-cols-2 gap-2">
            <div v-for="f in features" :key="f" class="flex items-center gap-2 text-xs"
              :style="{ color: 'var(--text-secondary)' }">
              <span :style="{ color: 'var(--text-secondary)' }">✓</span>{{ f }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { themeMode as tm, setThemeMode } from '../stores/theme'
import AppIcon from '../components/icons/AppIcon.vue'
import { Capacitor } from '@capacitor/core'
import { testAiConnection } from '../services/ai/ai-client'
import { EDGE_VOICES } from '../services/tts/edge-tts'
import { AZURE_REGIONS } from '../services/tts/azure-tts'
import { speakWithSettings, stopSpeaking, ttsState } from '../services/tts'

const router = useRouter()
const store = useSettingsStore()
const activeTab = ref<'storage' | 'sync' | 'ai' | 'theme' | 'about'>('storage')

// 版本号：由 vite.config.js 注入（读取自 package.json，随版本发布自动更新）
const appVersion = __APP_VERSION__

// ============ 软件更新 ============
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI
// 是否为 iOS（Capacitor 平台）：仅 iOS 显示 iOS 版更新检查，其他平台不展示
const isIOS = typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'ios'
const updateState = ref<'idle' | 'checking' | 'available' | 'none' | 'updating' | 'done' | 'error'>('idle')
const updateInfo = ref<{ latestVersion?: string; downloadUrl?: string } | null>(null)
const updateProgress = ref(0)
const updateError = ref('')

// ============ iOS 版更新检查（仅 iOS 显示） ============
const iosUpdateState = ref<'idle' | 'checking' | 'available' | 'none' | 'error'>('idle')
const iosUpdateInfo = ref<{ latestVersion?: string; downloadUrl?: string } | null>(null)
const iosUpdateError = ref('')

async function handleCheckIOSUpdate() {
  iosUpdateState.value = 'checking'
  iosUpdateError.value = ''
  try {
    const res = await fetch('https://raw.githubusercontent.com/rayliu445/tinydo/main/package.json', { cache: 'no-store' })
    if (!res.ok) throw new Error('网络请求失败（HTTP ' + res.status + '）')
    const pkg = await res.json()
    const latest = String(pkg.version || '')
    const hasUpdate = !!latest && latest !== appVersion
    iosUpdateInfo.value = {
      latestVersion: latest,
      downloadUrl: `https://github.com/rayliu445/tinydo/releases/download/v${latest}/TinyDo-v${latest}-ios.ipa`,
    }
    iosUpdateState.value = hasUpdate ? 'available' : 'none'
  } catch (err: any) {
    iosUpdateState.value = 'error'
    iosUpdateError.value = err?.message || '检查更新失败'
  }
}

async function handleCheckUpdate() {
  if (!isElectron) return
  updateState.value = 'checking'
  updateError.value = ''
  try {
    const res = await (window as any).electronAPI.checkForUpdate()
    if (res.error) {
      updateState.value = 'error'
      updateError.value = res.error
      return
    }
    updateInfo.value = res
    updateState.value = res.hasUpdate ? 'available' : 'none'
  } catch (err: any) {
    updateState.value = 'error'
    updateError.value = err?.message || '检查更新失败'
  }
}

function handleInstallUpdate() {
  if (!isElectron || !updateInfo.value?.downloadUrl) return
  updateState.value = 'updating'
  updateProgress.value = 0
  ;(window as any).electronAPI.onUpdateProgress((p: number) => {
    updateProgress.value = p
  })
  ;(window as any).electronAPI.downloadAndInstall(updateInfo.value.downloadUrl).then((res: any) => {
    if (res && res.success) {
      updateState.value = 'done'
    } else {
      updateState.value = 'error'
      updateError.value = (res && res.error) || '安装失败'
    }
  })
}

const tabs = [
  { id: 'storage' as const, label: '存储', icon: 'storage' },
  { id: 'sync' as const, label: '同步', icon: 'sync' },
  { id: 'ai' as const, label: 'AI 助手', icon: 'ai' },
  { id: 'theme' as const, label: '主题', icon: 'palette' },
  { id: 'about' as const, label: '关于', icon: 'about' },
]

const themeOptions = [
  { value: 'light' as const, label: '亮色', icon: 'sun', desc: '始终使用亮色主题' },
  { value: 'dark' as const, label: '暗黑', icon: 'moon', desc: '始终使用暗黑主题' },
  { value: 'system' as const, label: '跟随系统', icon: 'system', desc: '自动跟随系统主题设置' },
]

const kodoFields = [
  { key: 'bucket', label: 'Bucket 名称', placeholder: '如：todo-app-sync' },
  { key: 'region', label: 'Region（地域）', placeholder: 'cn-east-1（华东）| cn-north-1（华北）| cn-south-1（华南）', hint: '七牛云控制台 → 空间概览可查看地域' },
  { key: 'accessKeyId', label: 'AccessKey ID', placeholder: 'LTAI5t...' },
  { key: 'accessKeySecret', label: 'AccessKey Secret', placeholder: 'xxxxxxxxxx', type: 'password' },
]

const features = ['日历月/周/日视图', '四象限矩阵', '滴答清单导入', 'SQLite 数据持久化', '暗黑/亮色主题', '七牛云 Kodo 云同步']

function getTabStyle(tabId: string) {
  const active = activeTab.value === tabId
  return {
    backgroundColor: active ? 'var(--color-accent-light)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
  }
}

function getThemeOptionStyle(value: string) {
  const active = tm.value === value
  return {
    backgroundColor: active ? 'var(--color-accent-light)' : 'transparent',
    borderRadius: '0.75rem',
  }
}

const syncDotColor = computed(() => {
  const s = store.syncState.status
  return s === 'idle' ? '#22c55e' : s === 'syncing' ? '#3b82f6' : s === 'error' ? '#ef4444' : '#eab308'
})
const syncStatusText = computed(() => ({ idle: '同步正常', syncing: '同步中…', error: '同步出错', offline: '离线' })[store.syncState.status] || '未知')
const lastSyncTime = computed(() => { const t = store.syncState.lastSyncTime; return t ? new Date(t).toLocaleString('zh-CN') : null })
const syncErrorMessage = computed(() => store.syncState.lastError)
const syncDetail = computed(() => store.syncState.lastSyncDetail)

function handleEnableProvider(id: string) { store.toggleProvider(id) }
function handleDisconnect() { store.disconnectProvider() }
async function handleSyncNow() { await store.syncNow() }

const isTesting = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
async function handleTestConnection() {
  isTesting.value = true
  testResult.value = null
  testResult.value = await store.testKodoConnection()
  isTesting.value = false
}

// ============ AI 助手 ============

const aiFields = [
  { key: 'baseUrl' as const, label: 'Base URL', placeholder: 'https://api.deepseek.com/v1', hint: 'OpenAI 兼容接口地址，填到 /v1 这一层（DeepSeek / GLM / Kimi / Qwen / OpenAI 等均可）' },
  { key: 'apiKey' as const, label: 'API Key', placeholder: 'sk-...', type: 'password' },
  { key: 'model' as const, label: '模型名', placeholder: 'deepseek-chat', hint: '如 deepseek-chat、glm-4-flash、moonshot-v1-8k、gpt-4o-mini' },
]

// 本地编辑副本（失焦/变更时提交到 store 持久化）
const aiForm = reactive({ ...store.settings.ai })
function saveAi() {
  store.updateAiSettings({ ...aiForm })
}

const isTestingAi = ref(false)
const aiTestResult = ref<{ ok: boolean; message: string } | null>(null)
async function handleTestAi() {
  saveAi()
  isTestingAi.value = true
  aiTestResult.value = null
  aiTestResult.value = await testAiConnection(store.settings.ai)
  isTestingAi.value = false
}

// ============ 朗读（TTS） ============

const edgeVoices = EDGE_VOICES
const azureRegions = AZURE_REGIONS
const ttsEngineOptions = [
  { value: 'edge' as const, label: 'Edge TTS（免 Key）' },
  { value: 'azure' as const, label: 'Azure 官方（稳定）' },
  { value: 'system' as const, label: '系统语音（兜底）' },
]
const activeEngineHint = computed(() =>
  ttsForm.engine === 'edge'
    ? '微软云端神经网络语音，免 Key，音质自然。Web 开发模式经本地代理稳定可用；App 内直连可能被微软风控拒绝，被拒时自动降级系统语音（追求稳定可选 Azure 官方）'
    : ttsForm.engine === 'azure'
      ? '微软官方接口，与 Edge 同一批音色，稳定不受限流影响；免费层每月 50 万字符，需注册 Azure 创建语音服务拿 Key'
      : '设备内置语音，离线可用，但声音较机械，仅建议离线场景使用',
)

// 本地编辑副本（变更时提交到 store 持久化）
const ttsForm = reactive({ ...store.settings.tts })
function saveTts() {
  store.updateTtsSettings({ ...ttsForm })
}

function ttsEngineBtnStyle(value: string) {
  const active = ttsForm.engine === value
  return {
    backgroundColor: active ? 'var(--color-accent-light)' : 'var(--bg-hover)',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: '1px solid ' + (active ? 'var(--border-color)' : 'transparent'),
  }
}

function handleTestSpeak() {
  saveTts()
  speakWithSettings('你好呀，我是 TinyDo 的小柴，很高兴陪你一起把任务变小、变轻松。', store.settings.tts)
    .catch(err => console.warn('[TTS] 试听失败:', err))
}

async function exportData() {
  const { getDataAccess } = await import('../services/data-access')
  const json = getDataAccess().exportJSON()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  a.download = 'todo-backup-' + new Date().toISOString().slice(0, 10) + '.json'
  a.click(); URL.revokeObjectURL(a.href)
}
// 导入数据：跳转到完整导入页（支持滴答清单 CSV / JSON 格式预览导入）
function importData() {
  router.push('/import')
}
</script>