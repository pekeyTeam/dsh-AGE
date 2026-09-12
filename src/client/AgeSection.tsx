/**
 * The settings page.
 *
 * This page carries more weight than a settings page normally does: it is one of
 * the four exits from the plugin, and it is the only one a user will find without
 * being told. Two consequences run through the whole file.
 *
 * **Its root carries `data-dsh-age-section`**, which `engine.ts` reads to refuse
 * every hitch while the page is on screen. If that attribute were ever dropped,
 * the plugin would freeze the very panel that turns it off — a trap with no exit,
 * which is the one outcome this project is not allowed to have.
 *
 * **The dangerous controls are separated from the switches.** Presets and symptom
 * toggles are experiments; "暂停 5 分钟" and "彻底关闭" are the way out, and they
 * sit below a rule so they are never what a stray click finds.
 *
 * Styles are inline throughout — the host's CSS-module class names are per-build
 * hashes and cannot be imported from outside — and every colour is either
 * inherited or a neutral alpha, so the page follows the host's light and dark
 * themes without knowing which one is on.
 */

import type { CSSProperties } from 'react'
import { AgeMark } from './hud/AgeMark.tsx'
import { AGE_BLUE } from './hud/mark.ts'
import type { EngineStatus } from './engine.ts'
import type { AgeSettings, HudCorner, MouseMode } from './settings.ts'
import { PRESET_BLURB, PRESET_LABEL, PRESET_ORDER, effectivePreset } from './settings.ts'
import type { PresetId, Symptom } from './presets.ts'
import { pick, type AgeLocale } from './locale.ts'

/** Props for {@link AgeSection}. */
export interface AgeSectionProps {
  readonly settings: AgeSettings
  readonly status: EngineStatus
  readonly locale: AgeLocale
  readonly onSet: (patch: Partial<AgeSettings>) => void
  readonly onScanNow: () => void
  readonly onPanic: () => void
  readonly onDisable: () => void
  readonly onEnable: () => void
  readonly onReset: () => void
}

const card: CSSProperties = {
  border: '1px solid rgba(128, 128, 128, 0.28)',
  borderRadius: 12,
  padding: '14px 16px',
  marginBottom: 16,
}

const heading: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 10,
  opacity: 0.9,
}

const hint: CSSProperties = { fontSize: 12, lineHeight: 1.55, opacity: 0.68 }

const rule: CSSProperties = {
  border: 0,
  borderTop: '1px solid rgba(128, 128, 128, 0.28)',
  margin: '18px 0',
}

/** One labelled switch. */
function Toggle(props: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '7px 0',
        cursor: props.disabled === true ? 'not-allowed' : 'pointer',
        opacity: props.disabled === true ? 0.45 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        style={{ marginTop: 2, accentColor: AGE_BLUE }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13 }}>{props.label}</span>
        {props.description !== undefined && <span style={hint}>{props.description}</span>}
      </span>
    </label>
  )
}

/** One labelled choice set. */
function Choice<T extends string>(props: {
  label: string
  description?: string
  value: T
  options: readonly { id: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div style={{ padding: '7px 0' }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>{props.label}</div>
      {props.description !== undefined && <div style={{ ...hint, marginBottom: 8 }}>{props.description}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {props.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => props.onChange(option.id)}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              fontSize: 12,
              cursor: 'pointer',
              border: `1px solid ${option.id === props.value ? AGE_BLUE : 'rgba(128,128,128,0.35)'}`,
              background: option.id === props.value ? AGE_BLUE : 'transparent',
              color: option.id === props.value ? '#fff' : 'inherit',
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Readout of what the plugin has actually done, not what it planned. */
function Readout({ settings, status, locale }: { settings: AgeSettings; status: EngineStatus; locale: AgeLocale }) {
  const preset = effectivePreset(settings)
  const usedSeconds = (status.budgetUsedMs / 1000).toFixed(1)
  const capacitySeconds = (status.budgetCapacityMs / 1000).toFixed(0)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
      <div>
        <div style={hint}>{pick(locale, { zh: '本分钟已卡次数', en: 'Hitches this minute' })}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{status.hitchesThisMinute}</div>
      </div>
      <div>
        <div style={hint}>{pick(locale, { zh: '本分钟已占用', en: 'Blocked this minute' })}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {usedSeconds}s<span style={{ fontSize: 12, opacity: 0.6 }}> / {capacitySeconds}s</span>
        </div>
      </div>
      <div>
        <div style={hint}>{pick(locale, { zh: '本次会话实测阻塞', en: 'Measured this session' })}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{(status.measuredMs / 1000).toFixed(1)}s</div>
      </div>
      <div>
        <div style={hint}>{pick(locale, { zh: '单次上限', en: 'Hard per-hitch cap' })}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {(preset.hitchMs[1] / 1000).toFixed(1)}s
        </div>
      </div>
    </div>
  )
}

/**
 * The four lines every Chinese game is legally obliged to show on launch.
 *
 * Reproduced here because it is the last piece of the ritual this plugin was
 * missing: anyone who has played a domestic game has read these exact sentences
 * more times than they have read the game's own name, and their absence would be
 * more conspicuous than their presence. The copy is rewritten to fit, but the
 * rhythm — four lines, four clauses, one comma each — is the joke.
 */
const ADVISORY: readonly { zh: string; en: string }[] = [
  { zh: '抵制不良ai，拒绝盗版token', en: 'Resist bad AI, refuse pirated tokens' },
  { zh: '注意自我保护，谨防受骗上当', en: 'Protect yourself; beware of scams' },
  { zh: '适度ask益脑，沉迷reply伤身', en: 'Asking in moderation sharpens the mind; replying to excess harms the body' },
  { zh: '合理安排时间，享受健康生活', en: 'Manage your time well; enjoy a healthy life' },
]

/**
 * The launch advisory, styled the way the real one is: a bordered box, small
 * type, no decoration.
 *
 * @param props - active language.
 * @returns the advisory block.
 */
function Advisory({ locale }: { locale: AgeLocale }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: '12px 16px',
        border: '1px solid rgba(128, 128, 128, 0.28)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {ADVISORY.map((line) => (
        <span key={line.zh} style={{ ...hint, opacity: 0.75 }}>
          {pick(locale, line)}
        </span>
      ))}
    </div>
  )
}

/**
 * The AGE settings page.
 *
 * @param props - see {@link AgeSectionProps}.
 * @returns the page.
 */
export function AgeSection(props: AgeSectionProps) {
  const { settings, status, locale, onSet } = props
  const t = (copy: { zh: string; en: string }): string => pick(locale, copy)
  // Three switches for five mechanisms. The text presentations were three
  // separate toggles and nobody could tell them apart well enough to want them
  // separately — the honest count of decisions here is three, not five.
  const symptoms: readonly {
    key: 'mouse' | 'text' | 'interaction'
    label: { zh: string; en: string }
    description: { zh: string; en: string }
  }[] = [
    {
      key: 'mouse',
      label: { zh: '鼠标延滞', en: 'Pointer stall' },
      description: {
        zh: '屏幕上的指针本身停住不动，你手还在移，它却冻在原位，几秒后拖回你手的位置。',
        en: 'The pointer itself stops: your hand keeps moving, it stays where it was, and a beat later it drags across to catch up.',
      },
    },
    {
      key: 'text',
      label: { zh: '文字停滞', en: 'Text stalls' },
      description: {
        zh: 'AI 回复输出时出现三种形态：中途停住、几秒后把攒下的内容一次性吐出来；一块一块地跳出来而不是顺滑地爬；或者被横向拉一下再弹回。文字不会丢，只是被推迟。',
        en: 'Three shapes of the same thing while a reply streams: it stops and later dumps its backlog at once; it arrives in lumps instead of flowing; or it gets pulled sideways and snaps back. No text is lost, only delayed.',
      },
    },
    {
      key: 'interaction',
      label: { zh: '交互停滞', en: 'Interaction stalls' },
      description: {
        zh: '扫描窗口内弹出的设置框、菜单会延迟入场，切换会话也会顿一下。',
        en: 'Dialogs and menus that arrive during a scan window fade in late; switching conversations stutters.',
      },
    },
  ]

  return (
    <div data-dsh-age-section="" style={{ paddingBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
        <AgeMark width={112} />
        <span style={{ fontSize: 12, opacity: 0.62 }}>
          {t({ zh: 'AGE安全组件', en: 'AGE security component' })}
        </span>
      </div>
      <p style={{ ...hint, marginBottom: 18 }}>
        {t({
          zh: '本页由社区插件 dsh-age 提供，非 DeepSeek 官方功能。它不会读写你的会话内容、账号或文件——所有卡顿都在本地浏览器里产生，刷新即消失。',
          en: 'This page is provided by the community plugin dsh-age. It is not a DeepSeek feature. It does not read or write your sessions, account or files — every stall is produced locally in your browser and disappears on refresh.',
        })}
      </p>

      <div style={card}>
        <div style={heading}>{t({ zh: '总开关', en: 'Master switch' })}</div>
        <Toggle
          label={t({ zh: '启用 AGE 扫描模拟', en: 'Enable AGE scan simulation' })}
          description={t({
            zh: '关闭后立即停止一切卡顿，并记住这个选择。也可以随时按 Ctrl+Alt+Shift+A 暂停 5 分钟。',
            en: 'Turning this off stops every stall immediately and remembers the choice. Ctrl+Alt+Shift+A pauses for five minutes at any time.',
          })}
          checked={settings.enabled}
          // Routed through the same exits the keyboard uses, so switching this
          // on and pressing the hotkey twice cannot leave the two disagreeing.
          onChange={(next) => (next ? props.onEnable() : props.onDisable())}
        />
      </div>

      <div style={card}>
        <div style={heading}>{t({ zh: '扫描强度', en: 'Scan intensity' })}</div>
        <Choice<PresetId>
          label={t({ zh: '档位', en: 'Preset' })}
          value={settings.presetId}
          options={PRESET_ORDER.map((id) => ({ id, label: pick(locale, PRESET_LABEL[id]) }))}
          onChange={(id) => onSet({ presetId: id })}
        />
        <div style={{ ...hint, marginTop: 4 }}>{pick(locale, PRESET_BLURB[settings.presetId])}</div>
        <hr style={rule} />
        <Toggle
          label={t({ zh: '三种症状同时触发', en: 'Symptoms fire together' })}
          description={t({
            zh: '开启时，鼠标、文字、交互都由同一次扫描同时触发。关闭后三者各自独立随机。',
            en: 'On, one scan produces every symptom in the same instant. Off, the three run on independent random schedules.',
          })}
          checked={settings.correlate}
          onChange={(next) => onSet({ correlate: next })}
        />
      </div>

      <div style={card}>
        <div style={heading}>{t({ zh: '症状', en: 'Symptoms' })}</div>
        {symptoms.map((symptom) => (
          <Toggle
            key={symptom.key}
            label={t(symptom.label)}
            description={t(symptom.description)}
            checked={settings[symptom.key]}
            onChange={(next) => onSet({ [symptom.key]: next })}
          />
        ))}
        <hr style={rule} />
        <Choice<MouseMode>
          label={t({ zh: '鼠标延滞的实现方式', en: 'Pointer mechanism' })}
          description={t({
            zh: '「指针冻结」是默认方式，也是唯一能让指针本身上滞的一种：系统光标由操作系统绘制，不在页面里，'
              + '所以网页冻不住它——只能把真光标藏起来、自己画一个，阻塞期间那个画出来的光标就是静止的，恢复后再拖回你手的位置。'
              + '「仅冻帧」保持指针原样，只卡页面内容，不绘制也不隐藏任何东西，因此不可能出错。'
              + '「精确输入延迟」是实验性方案，让界面按几百毫秒前的位置响应——但布局变化时可能把点击落到你没瞄准的控件上，'
              + '所以无法证明安全的点击会被直接丢弃（宁可让你重点一次）。',
            en: 'Cursor freeze (default) is the only mechanism that makes the pointer itself lag: the platform cursor is '
              + 'compositor-drawn and outside the page, so it cannot be frozen — it has to be hidden, with a drawn one taking its '
              + 'place. That drawn cursor sits still through the block, then drags back to your hand. '
              + 'Page freeze alone leaves the pointer untouched: nothing is drawn or hidden, so it cannot misbehave. '
              + 'Precise input delay is experimental — it makes the UI react to where the pointer was, and a layout shift can land a '
              + 'click on a control you never aimed at, so any press that cannot be proven safe is dropped rather than re-aimed.',
          })}
          value={settings.mouseMode}
          options={[
            { id: 'cursor', label: t({ zh: '指针冻结（默认）', en: 'Cursor freeze (default)' }) },
            { id: 'hitch', label: t({ zh: '仅冻帧', en: 'Page freeze only' }) },
            { id: 'input-lag', label: t({ zh: '精确输入延迟（实验）', en: 'Precise input delay (experimental)' }) },
          ]}
          onChange={(mode) => onSet({ mouseMode: mode })}
        />
      </div>

      <div style={card}>
        <div style={heading}>{t({ zh: '状态', en: 'Status' })}</div>
        <Readout settings={settings} status={status} locale={locale} />
        {status.lastSuppression !== null && (
          <div style={{ ...hint, marginTop: 10 }}>
            {t({ zh: '最近一次未执行的扫描原因：', en: 'Last scan not run because: ' })}
            <code>{status.lastSuppression}</code>
          </div>
        )}
        <button
          type="button"
          onClick={props.onScanNow}
          style={{
            marginTop: 12,
            padding: '6px 14px',
            borderRadius: 8,
            border: `1px solid ${AGE_BLUE}`,
            background: 'transparent',
            color: AGE_BLUE,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {t({ zh: '现在扫描一次', en: 'Scan now' })}
        </button>
      </div>

      <div style={card}>
        <div style={heading}>{t({ zh: '界面', en: 'Interface' })}</div>
        <Toggle
          label={t({ zh: '显示角落安全组件徽标', en: 'Show the corner badge' })}
          checked={settings.hud}
          onChange={(next) => onSet({ hud: next })}
        />
        <Choice<HudCorner>
          label={t({ zh: '徽标位置', en: 'Badge corner' })}
          value={settings.hudCorner}
          options={[
            { id: 'top-right', label: t({ zh: '右上', en: 'Top right' }) },
            { id: 'top-left', label: t({ zh: '左上', en: 'Top left' }) },
            { id: 'bottom-right', label: t({ zh: '右下', en: 'Bottom right' }) },
            { id: 'bottom-left', label: t({ zh: '左下', en: 'Bottom left' }) },
          ]}
          onChange={(corner) => onSet({ hudCorner: corner })}
        />
        <Choice<string>
          label={t({ zh: '扫描提示频率', en: 'Announcement frequency' })}
          description={t({
            zh: '多大概率弹出「正在扫描」提示条。',
            en: 'How often a scan announces itself with a toast.',
          })}
          value={settings.toastChance >= 60 ? 'loud' : settings.toastChance >= 20 ? 'normal' : 'quiet'}
          options={[
            { id: 'quiet', label: t({ zh: '安静', en: 'Quiet' }) },
            { id: 'normal', label: t({ zh: '正常', en: 'Normal' }) },
            { id: 'loud', label: t({ zh: '啰嗦', en: 'Chatty' }) },
          ]}
          onChange={(level) => onSet({ toastChance: level === 'loud' ? 80 : level === 'normal' ? 35 : 8 })}
        />
        <div style={{ ...hint, marginTop: 6 }}>
          {t({ zh: '复现种子：', en: 'Reproduction seed: ' })}
          <code>{settings.seed}</code>
        </div>
      </div>

      <hr style={rule} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={props.onPanic}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid rgba(128,128,128,0.4)',
            background: 'transparent',
            color: 'inherit',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {t({ zh: '暂停 5 分钟', en: 'Pause for 5 minutes' })}
        </button>
        <button
          type="button"
          onClick={props.onDisable}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid rgba(197, 52, 42, 0.55)',
            background: 'transparent',
            color: '#c5342a',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {t({ zh: '彻底关闭', en: 'Turn off' })}
        </button>
        <button
          type="button"
          onClick={props.onReset}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid rgba(128,128,128,0.4)',
            background: 'transparent',
            color: 'inherit',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {t({ zh: '恢复默认设置', en: 'Reset to defaults' })}
        </button>
      </div>

      <Advisory locale={locale} />
    </div>
  )
}
