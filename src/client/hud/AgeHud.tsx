/**
 * The corner badge and its announcements: the part that makes the stutter read
 * as a *product*.
 *
 * A stall with no chrome is a bug. A stall with a breathing badge, a status line
 * and an occasional announcement is a security component doing its job — which
 * is the entire joke, and also the reason this file exists rather than the
 * effects speaking for themselves.
 *
 * ## Two layout facts that decide the implementation
 *
 * The `shell.overlay` layer is `position: absolute; inset: 0; pointer-events:
 * none` — but with a `> *` rule that hands pointer events *back* to every direct
 * child. So the HUD root, being a direct child, must set `pointer-events: none`
 * explicitly and re-enable it only on the few controls that need it. Getting
 * this wrong does not look broken; it silently eats every click in the corner of
 * the screen.
 *
 * The frame above the layer is `position: relative; overflow: hidden` with no
 * transform, filter or containment ancestor, so `position: fixed` escapes the
 * clip and resolves against the viewport. A `position: absolute` badge would be
 * clipped at the frame's edge.
 *
 * Styles are inline throughout: the host's CSS-module class names are per-build
 * hashes and cannot be imported from outside.
 */

import { useState, type CSSProperties } from 'react'
import { AgeBadge, type BadgePhase } from './AgeShield.tsx'
import { AGE_BLUE, AGE_GLOW } from './mark.ts'
import type { EngineStatus } from '../engine.ts'
import type { AgeSettings, HudCorner } from '../settings.ts'
import { PRESET_LABEL, PRESET_ORDER } from '../settings.ts'
import type { PresetId } from '../presets.ts'
import type { Toast } from '../toasts.ts'
import { pick, type AgeLocale } from '../locale.ts'

/** Where the badge sits, keyed by the setting. */
const CORNER: Readonly<Record<HudCorner, CSSProperties>> = {
  'top-right': { top: 14, right: 14 },
  'top-left': { top: 14, left: 14 },
  'bottom-right': { bottom: 14, right: 14 },
  'bottom-left': { bottom: 14, left: 14 },
}

/** Props for {@link AgeHud}. */
export interface AgeHudProps {
  readonly status: EngineStatus
  readonly settings: AgeSettings
  readonly toasts: readonly Toast[]
  readonly locale: AgeLocale
  readonly onPanic: () => void
  readonly onDisable: () => void
  readonly onPreset: (id: PresetId) => void
  readonly onToggleCollapsed: () => void
}

/** What the badge should show, from what the engine reports. */
function badgePhase(status: EngineStatus): BadgePhase {
  if (status.state === 'hitching' || status.frozen) return 'blocking'
  if (status.state === 'scanning') return 'scanning'
  return 'protected'
}

/** The status line, localized. */
function statusText(status: EngineStatus, locale: AgeLocale): string {
  if (status.paused) return pick(locale, { zh: '已暂停', en: 'Paused' })
  if (status.state === 'disabled') return pick(locale, { zh: '已关闭', en: 'Off' })
  if (status.state === 'suspended') return pick(locale, { zh: '已暂停', en: 'Paused' })
  if (status.frozen) return pick(locale, { zh: '正在扫描 · 环境阻塞', en: 'Scanning · blocked' })
  if (status.state === 'scanning') {
    return status.heavy
      ? pick(locale, { zh: '启动扫描中…', en: 'Launch scan…' })
      : pick(locale, { zh: '正在扫描…', en: 'Scanning…' })
  }
  return pick(locale, { zh: '已保护', en: 'Protected' })
}

/**
 * The badge.
 *
 * @param props - see {@link AgeHudProps}.
 * @returns the corner HUD and its announcements.
 */
export function AgeHud(props: AgeHudProps) {
  const { status, settings, toasts, locale, onPanic, onDisable, onPreset, onToggleCollapsed } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const phase = badgePhase(status)
  const expanded = !settings.hudCollapsed || menuOpen

  return (
    <>
      {/* The sweep is the loudest part of the illusion and the cheapest: one
          compositor-only transform, visible only while the thread is blocked. */}
      {status.frozen && (
        <div
          aria-hidden="true"
          data-dsh-age-scanline=""
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            zIndex: 29,
            pointerEvents: 'none',
            background: `linear-gradient(90deg, transparent, ${AGE_GLOW}, transparent)`,
            boxShadow: `0 0 18px 4px ${AGE_GLOW}`,
          }}
        />
      )}

      <div
        data-dsh-age-hud=""
        style={{
          position: 'fixed',
          zIndex: 30,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          // Not decorative: the overlay layer's `> *` rule re-enables events on
          // direct children, so without this the badge swallows every click
          // behind it.
          pointerEvents: 'none',
          fontFamily: 'inherit',
          ...CORNER[settings.hudCorner],
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            data-dsh-age-toast=""
            role="status"
            style={{
              maxWidth: 320,
              padding: '7px 11px',
              borderRadius: 8,
              background: 'rgba(20, 22, 26, 0.92)',
              color: '#fff',
              fontSize: 12,
              lineHeight: 1.45,
              boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
            }}
          >
            {toast.text}
          </div>
        ))}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: expanded ? '7px 9px' : 5,
            borderRadius: 12,
            background: 'rgba(20, 22, 26, 0.92)',
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
            pointerEvents: 'auto',
            userSelect: 'none',
          }}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={pick(locale, { zh: 'AGE 安全组件', en: 'AGE security component' })}
            style={{
              display: 'flex',
              border: 0,
              padding: 0,
              background: 'none',
              cursor: 'pointer',
            }}
          >
            <AgeBadge
              phase={phase}
              title={pick(locale, { zh: 'AGE 安全组件', en: 'AGE security component' })}
            />
          </button>

          {expanded && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 4 }}>
              <span style={{ color: '#fff', fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>
                {statusText(status, locale)}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.62)', fontSize: 10.5, lineHeight: 1.2 }}>
                {pick(locale, { zh: '本分钟 ', en: 'This minute ' })}
                {status.hitchesThisMinute}
                {' · '}
                {Math.round(status.budgetUsedMs / 1000)}s/{Math.round(status.budgetCapacityMs / 1000)}s
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={pick(locale, { zh: '折叠状态条', en: 'Collapse status' })}
            style={{
              border: 0,
              background: 'none',
              color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: 1,
              padding: '2px 3px',
            }}
          >
            {settings.hudCollapsed ? '‹' : '›'}
          </button>
        </div>

        {menuOpen && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: 10,
              borderRadius: 12,
              background: 'rgba(20, 22, 26, 0.95)',
              boxShadow: '0 10px 28px rgba(0, 0, 0, 0.34)',
              pointerEvents: 'auto',
              minWidth: 180,
            }}
          >
            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10.5 }}>
              {pick(locale, { zh: '扫描强度', en: 'Intensity' })}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {PRESET_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPreset(id)}
                  style={{
                    flex: 1,
                    padding: '4px 6px',
                    borderRadius: 6,
                    border: `1px solid ${id === settings.presetId ? AGE_BLUE : 'rgba(255,255,255,0.18)'}`,
                    background: id === settings.presetId ? AGE_BLUE : 'transparent',
                    color: id === settings.presetId ? '#fff' : 'rgba(255,255,255,0.8)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  {pick(locale, PRESET_LABEL[id])}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onPanic}
              style={{
                padding: '5px 8px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.85)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {pick(locale, { zh: '暂停 5 分钟', en: 'Pause 5 min' })}
            </button>
            <button
              type="button"
              onClick={onDisable}
              style={{
                padding: '5px 8px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.85)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {pick(locale, { zh: '彻底关闭', en: 'Turn off' })}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
