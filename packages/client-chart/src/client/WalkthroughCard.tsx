/**
 * The `walkthrough` tool's card: one section of the analyst talking, set in
 * the conversation like any assistant paragraph, one line at a time.
 *
 * The card owns none of the pacing. It registers its section with the player
 * (lesson.ts) and renders whatever the player says is visible; the chart
 * column reads the same player and moves with each line. Clicking an earlier
 * line puts the chart back to that moment. When the analyst ends the turn on
 * a question, the replies it offered sit under the last line and send a real
 * message when tapped.
 * @module
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { useDark } from './ChartCard.js'
import { getLessonSnapshot, lesson, LIVE_WINDOW_MS, subscribeLesson } from './lesson.js'
import { contentText } from './payload.js'
import { parseSay, readWalkthrough } from './walkthrough.js'

/** What the plugin binds at registration: a way to send the reader's reply. */
export interface WalkthroughInject {
  ask?: (text: string) => void
}

type SessionHook = <S>(sel: (s: { running: boolean; nodes: readonly { kind: string; seq: number }[] }) => S) => S

const LINE: CSSProperties = {
  position: 'relative', margin: '0 -8px', padding: '2px 8px', borderRadius: 8,
  fontSize: 16, lineHeight: '28px', cursor: 'pointer', transition: 'background-color .15s ease',
}
const TITLE: CSSProperties = {
  margin: '10px 0 2px', fontSize: 12.5, fontWeight: 600, letterSpacing: '.04em',
  color: 'var(--dsw-alias-text-3, #61666b)',
}
const NOTE: CSSProperties = { fontSize: 12.5, lineHeight: '20px', color: 'var(--dsw-alias-text-3, #8b949e)', margin: '2px 0' }

export function WalkthroughCard(props: ToolCallViewProps & WalkthroughInject): JSX.Element {
  const { block, callId } = props
  const settled = 'kind' in block
  const data = useMemo(() => (settled && !block.isError ? readWalkthrough(block.meta) : null), [block, settled])
  const time = settled ? block.time : 0
  const seq = settled ? block.seq : Number.POSITIVE_INFINITY
  const dark = useDark()

  useEffect(() => {
    if (data !== null) lesson.register(callId, time, data, Date.now() - time < LIVE_WINDOW_MS)
  }, [callId, data, time])

  const snap = useSyncExternalStore(subscribeLesson, getLessonSnapshot, getLessonSnapshot)
  // Replies only make sense while the analyst is waiting: turn over, nothing typed since.
  const useSession = (props as unknown as { useSession?: SessionHook }).useSession
  const replied = useSession?.(s => s.nodes.some(n => n.kind === 'user' && n.seq > seq)) ?? false
  const running = useSession?.(s => s.running) ?? false

  if (!settled) return <Typing dark={dark} />
  if (block.isError) {
    // A failed check is the tool doing its job; show it, quietly, while the model corrects itself.
    const first = contentText(block.content).split('\n')[0] ?? ''
    return <p style={NOTE}>✗ {first.slice(0, 200) || 'walkthrough failed'}</p>
  }
  if (data === null) return <p style={NOTE}>{contentText(block.content).slice(0, 300)}</p>

  const shown = snap.shown.get(callId) ?? data.lines.length
  // Still queued behind another section: nothing of it is said yet, not even its title.
  if (shown === 0 && snap.typing !== callId) return <></>
  const onChart = snap.cursor?.callId === callId ? snap.cursor.line : -1
  const replayingHere = snap.mode === 'replay' && onChart >= 0
  const hereLook = snap.look && snap.cursor?.callId === callId
  const asking = snap.asking === callId && !replied && !running && data.ask !== undefined
  const markBg = dark ? 'rgba(101,248,79,.24)' : '#b8ff9f'

  return (
    <div style={{ margin: '2px 0 6px' }}>
      <p style={TITLE}>{data.section}</p>
      {data.lines.slice(0, shown).map((line, k) => (
        <Line
          key={k}
          on={k === onChart}
          fresh={k === shown - 1 && snap.shown.has(callId)}
          dark={dark}
          onClick={() => { if (k !== onChart || snap.mode === 'replay') lesson.replay(callId, k) }}
        >
          {parseSay(line.say).map((seg, j) => seg.mark !== undefined
            ? (
              <mark
                key={j}
                style={{ background: `linear-gradient(transparent 58%, ${markBg} 58%)`, color: 'inherit', padding: '0 1px', borderRadius: 2 }}
                onMouseEnter={() => lesson.setHot(seg.mark!)}
                onMouseLeave={() => lesson.setHot(null)}
              >
                {seg.text}
              </mark>
            )
            : seg.bold === true ? <strong key={j}>{seg.text}</strong> : <span key={j}>{seg.text}</span>)}
        </Line>
      ))}
      {snap.typing === callId ? <Typing dark={dark} onClick={() => lesson.hurry()} /> : null}
      {hereLook || replayingHere || asking
        ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', margin: '8px 0 2px' }}>
            {hereLook ? <Chip dark={dark} strong onClick={() => lesson.resume()}>Continue</Chip> : null}
            {replayingHere ? <Chip dark={dark} strong onClick={() => lesson.backToLive()}>Back to where we were</Chip> : null}
            {asking
              ? data.ask!.map((text, i) => (
                <Chip key={text} dark={dark} strong={i === 0} onClick={() => { lesson.answer(callId); props.ask?.(text) }}>{text}</Chip>
              ))
              : null}
          </div>
        )
        : null}
    </div>
  )
}

function Line({ on, fresh, dark, onClick, children }: {
  on: boolean
  fresh: boolean
  dark: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  const el = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!fresh || el.current === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.current.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'ease' })
  }, [fresh])
  return (
    <p
      ref={el}
      style={LINE}
      title="Show the chart as it was at this line"
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.background = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.035)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {on
        ? <span aria-hidden="true" style={{ position: 'absolute', left: -3, top: 7, bottom: 7, width: 3, borderRadius: 2, background: '#65f84f', boxShadow: `0 0 0 1px ${dark ? '#0d1117' : '#050605'}` }} />
        : null}
      {children}
    </p>
  )
}

function Typing({ dark, onClick }: { dark: boolean; onClick?: () => void }): JSX.Element {
  const dot = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const d = dot.current
    if (d === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const a = d.animate([{ opacity: 0.25, transform: 'scale(.8)' }, { opacity: 0.9, transform: 'scale(1)' }, { opacity: 0.25, transform: 'scale(.8)' }], { duration: 1000, iterations: Infinity })
    return () => a.cancel()
  }, [])
  return (
    <div style={{ padding: '8px 0 4px', cursor: onClick !== undefined ? 'pointer' : 'default' }} onClick={onClick} title={onClick !== undefined ? 'Say it now' : undefined}>
      <span ref={dot} aria-label="typing" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: dark ? '#e8eaed' : '#0f1115', opacity: 0.5 }} />
    </div>
  )
}

function Chip({ dark, strong, onClick, children }: { dark: boolean; strong?: boolean; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${strong === true ? (dark ? '#e8eaed' : '#0f1115') : dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.1)'}`,
        background: 'transparent', color: 'inherit', borderRadius: 18, padding: '5px 13px', fontSize: 13, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
