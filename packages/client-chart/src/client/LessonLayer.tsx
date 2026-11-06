/**
 * The analyst's hand over the chart: frames the camera for a section, then
 * draws what each line names (pen circles and strokes, a highlighter zone,
 * spotlit volume) and moves a pointer to whatever is being talked about.
 *
 * Drawn as SVG over the canvas rather than as klinecharts overlays, for two
 * reasons. The ink animates (a stroke that draws itself is half of what makes
 * this read as someone pointing), and the canvas has no notion of that. And
 * nothing here touches the chart's own drawing: the layer only reads
 * coordinates, so the chart the user drives stays exactly as it was.
 * @module
 */
import { useEffect, useRef } from 'react'
import type { Chart } from 'klinecharts'
import { arrowHead, loop, polyline, rng, seedOf, stroke } from './ink.js'
import type { Pt } from './ink.js'
import type { Board, BoardMark, PointerTarget } from './lesson.js'
import type { WalkPoint, WalkSurface } from './walkthrough.js'

/** Pane ids the chart created: the volume pane and any indicator panes, by chip id. */
export type PaneIds = { volume?: string } & Record<string, string | undefined>

type Ink = {
  pen: string; ring: string; lime: string; up: string; down: string; muted: string
  labelBg: string; dim: string; hlOpacity: number; hlBlend: string
}

/** maddog lime for highlights; ink-black strokes on white, lime strokes on dark. */
const LIGHT: Ink = {
  pen: '#050605', ring: '#050605', lime: '#65f84f', up: '#26a17b', down: '#e0563f', muted: '#8b949e',
  labelBg: 'rgba(255,255,255,0.92)', dim: 'rgba(255,255,255,0.74)', hlOpacity: 0.5, hlBlend: 'multiply',
}
const DARK: Ink = {
  pen: '#65f84f', ring: '#0d1117', lime: '#65f84f', up: '#3ddc97', down: '#f47067', muted: '#768390',
  labelBg: 'rgba(13,17,23,0.9)', dim: 'rgba(13,17,23,0.74)', hlOpacity: 0.22, hlBlend: 'normal',
}

const NS = 'http://www.w3.org/2000/svg'
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

type Box = { x: number; y: number; w: number; h: number }

/**
 * @param chart - the live chart instance.
 * @param panes - pane ids the chart created.
 * @param board - what to show, or null to show nothing and give the chart back.
 * @param dark - theme.
 * @param onUserMove - the reader scrolled or zoomed the chart themselves.
 */
export function LessonLayer({ chart, panes, board, dark, onUserMove }: {
  chart: Chart
  panes: PaneIds
  board: Board | null
  dark: boolean
  onUserMove: () => void
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const pointer = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLSpanElement>(null)
  const lastBeat = useRef<string | null>(null)
  const lastShot = useRef<string | null>(null)
  const programmatic = useRef(0)
  const live = useRef({ board, dark, panes, onUserMove })
  live.current = { board, dark, panes, onUserMove }

  // A slow ping around the pointer, so it reads as "look here" rather than a dot.
  useEffect(() => {
    const r = ring.current
    if (r === null || reducedMotion()) return
    const a = r.animate([{ transform: 'scale(1)', opacity: 0.8 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 1600, iterations: Infinity, easing: 'ease-out' })
    return () => a.cancel()
  }, [])

  // Camera: each section frames its own window, ending at the latest bar. One
  // set, not a tween: tweening the bar space left klinecharts' candle layer
  // painted at the old spacing on touch screens at 2x.
  const frameKey = board === null ? '' : `${board.callId}|${board.frame.from}|${board.frame.pad}`
  useEffect(() => {
    if (board === null) return
    const list = chart.getDataList()
    if (list.length === 0) return
    let a = list.length - 1
    while (a > 0 && list[a - 1]!.timestamp >= board.frame.from) a -= 1
    const size = chart.getSize('candle_pane', 'main' as never)
    const width = size !== null && size.width > 0 ? size.width : 600
    programmatic.current = performance.now() + 450
    chart.setOffsetRightDistance(board.frame.pad)
    chart.setBarSpace(Math.max(2, Math.min(46, (width - board.frame.pad) / (list.length - a + 1.6))))
    chart.scrollToRealTime()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, frameKey])

  // The section decides which averages are worth their axis room.
  const maKey = board === null ? '20,50,200' : board.ma.join(',')
  useEffect(() => {
    safely(() => chart.overrideIndicator({ name: 'MA', calcParams: maKey.split(',').map(Number) }, 'candle_pane'))
  }, [chart, maKey])
  // Kline disposes its chart before this layer unmounts, so cleanups must tolerate a dead chart.
  useEffect(() => () => safely(() => chart.overrideIndicator({ name: 'MA', calcParams: [20, 50, 200] }, 'candle_pane')), [chart])

  // Draw on every beat, and again whenever the chart moves under the ink.
  useEffect(() => {
    const redraw = (): void => paint(false)
    const moved = (): void => {
      redraw()
      if (performance.now() > programmatic.current) live.current.onUserMove()
    }
    chart.subscribeAction('onScroll' as never, moved)
    chart.subscribeAction('onZoom' as never, moved)
    chart.subscribeAction('onVisibleRangeChange' as never, redraw)
    const host = root.current
    const observer = host !== null ? new ResizeObserver(redraw) : null
    if (host !== null) observer!.observe(host)
    return () => {
      safely(() => {
        chart.unsubscribeAction('onScroll' as never, moved)
        chart.unsubscribeAction('onZoom' as never, moved)
        chart.unsubscribeAction('onVisibleRangeChange' as never, redraw)
      })
      observer?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart])

  useEffect(() => {
    // After a camera move the axes settle over the next frames; draw once they have.
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => paint(true)) })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, board, dark, panes])

  /** Render the board. `beatChanged` lets this beat's new marks draw themselves once. */
  function paint(beatChanged: boolean): void {
    const host = root.current
    const s = svg.current
    const lab = labels.current
    const ptr = pointer.current
    if (host === null || s === null || lab === null || ptr === null) return
    const { board: b, dark: isDark, panes: ids } = live.current
    s.replaceChildren()
    lab.replaceChildren()
    if (b === null) {
      ptr.hidden = true
      lastBeat.current = null
      return
    }
    const ink = isDark ? DARK : LIGHT
    const animate = beatChanged && lastBeat.current !== b.beat && !reducedMotion()
    const sameShot = lastShot.current === b.callId
    lastBeat.current = b.beat
    lastShot.current = b.callId
    const origin = host.getBoundingClientRect()

    const paneId = (surface: WalkSurface): string | undefined =>
      surface === 'price' ? 'candle_pane' : surface === 'volume' ? ids.volume : b.pane !== undefined ? ids[b.pane] : undefined
    const box = (surface: WalkSurface): Box | null => {
      const id = paneId(surface)
      const el = id !== undefined ? chart.getDom(id, 'main' as never) : null
      if (el === null || el === undefined) return null
      const r = el.getBoundingClientRect()
      return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
    }
    const list = chart.getDataList()
    const lastIdx = list.length - 1
    const px = (p: WalkPoint, surface: WalkSurface): Pt | null => {
      const id = paneId(surface)
      if (id === undefined) return null
      const point = 't' in p ? { timestamp: p.t, value: p.v } : { dataIndex: lastIdx + p.ahead, value: p.v }
      const c = chart.convertToPixel(point, { paneId: id, absolute: true }) as { x?: number; y?: number }
      return c.x !== undefined && c.y !== undefined ? { x: c.x, y: c.y } : null
    }
    const yOf = (v: number, surface: WalkSurface): number | null => {
      const id = paneId(surface)
      if (id === undefined) return null
      const c = chart.convertToPixel({ dataIndex: lastIdx, value: v }, { paneId: id, absolute: true }) as { y?: number }
      return c.y ?? null
    }
    const space = (): number => {
      const bs = chart.getBarSpace() as unknown
      return typeof bs === 'number' ? bs : (bs as { bar?: number } | null)?.bar ?? 8
    }
    const lastX = (): number | null => {
      const last = list[lastIdx]
      return last === undefined ? null : px({ t: last.timestamp, v: last.close }, 'price')?.x ?? null
    }

    const placed: { x: number; y: number; w: number; h: number }[] = []
    const label = (text: string, x: number, y: number, color: string, how: 'left' | 'right' | 'center', fresh: boolean, hot: boolean): void => {
      const el = document.createElement('div')
      el.textContent = text
      Object.assign(el.style, {
        position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', font: `600 12px/1.3 ${FONT}`,
        padding: '1px 6px', borderRadius: '4px', color: hot ? '#050605' : color,
        background: hot ? ink.lime : ink.labelBg, pointerEvents: 'none',
        opacity: fresh ? '0' : '1', transition: fresh ? 'opacity .3s ease .35s' : '',
      } satisfies Partial<CSSStyleDeclaration>)
      lab.appendChild(el)
      const w = el.offsetWidth
      const h = el.offsetHeight
      let lx = how === 'right' ? x - w : how === 'center' ? x - w / 2 : x
      let ly = y - h / 2
      lx = Math.max(2, Math.min(origin.width - w - 64, lx))
      for (let guard = 0; guard < 6; guard++) {
        const hit = placed.find(o => lx < o.x + o.w && lx + w > o.x && ly < o.y + o.h && ly + h > o.y)
        if (hit === undefined) break
        ly = hit.y + hit.h + 2
      }
      placed.push({ x: lx, y: ly, w, h })
      el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`
      if (fresh) requestAnimationFrame(() => { el.style.opacity = '1' })
    }
    const path = (d: string, color: string, width: number, opts: { opacity?: number; dash?: boolean; fresh?: boolean; delay?: number; clip?: string } = {}): void => {
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', d)
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', color)
      p.setAttribute('stroke-width', String(width))
      p.setAttribute('stroke-linecap', 'round')
      p.setAttribute('stroke-linejoin', 'round')
      if (opts.opacity !== undefined) p.setAttribute('stroke-opacity', String(opts.opacity))
      if (opts.dash === true) p.setAttribute('stroke-dasharray', '7 6')
      if (opts.clip !== undefined) p.setAttribute('clip-path', `url(#${opts.clip})`)
      s.appendChild(p)
      if (opts.fresh !== true) return
      if (opts.dash === true) {
        p.style.opacity = '0'
        p.style.transition = `opacity .5s ease ${opts.delay ?? 0}ms`
        requestAnimationFrame(() => { p.style.opacity = '1' })
        return
      }
      const len = p.getTotalLength()
      p.style.strokeDasharray = `${len}`
      p.style.strokeDashoffset = `${len}`
      p.getBoundingClientRect()
      p.style.transition = `stroke-dashoffset 640ms cubic-bezier(.35,.6,.25,1) ${opts.delay ?? 0}ms`
      p.style.strokeDashoffset = '0'
    }
    const rect = (x: number, y: number, w: number, h: number, fill: string, opacity: number, opts: { blend?: string; sweep?: boolean; flash?: boolean } = {}): void => {
      const r = document.createElementNS(NS, 'rect')
      r.setAttribute('x', x.toFixed(1))
      r.setAttribute('y', y.toFixed(1))
      r.setAttribute('width', Math.max(0, w).toFixed(1))
      r.setAttribute('height', Math.max(0, h).toFixed(1))
      r.setAttribute('rx', '3')
      r.setAttribute('fill', fill)
      r.setAttribute('fill-opacity', String(opacity))
      if (opts.blend !== undefined) r.style.mixBlendMode = opts.blend
      s.appendChild(r)
      if (opts.sweep === true) {
        r.style.transformBox = 'fill-box'
        r.style.transformOrigin = 'left center'
        r.style.transform = 'scaleX(0)'
        r.getBoundingClientRect()
        r.style.transition = 'transform .55s cubic-bezier(.16,1,.3,1)'
        r.style.transform = 'scaleX(1)'
      } else if (opts.flash === true) {
        r.animate([{ fillOpacity: opacity }, { fillOpacity: Math.min(1, opacity * 1.9) }, { fillOpacity: opacity }], { duration: 1100, easing: 'ease' })
      }
    }

    // Clip each pane's strokes to the pane, so a long price line never runs into the volume bars.
    const defs = document.createElementNS(NS, 'defs')
    for (const surface of ['price', 'volume', 'indicator'] as const) {
      const bx = box(surface)
      if (bx === null) continue
      const cp = document.createElementNS(NS, 'clipPath')
      cp.setAttribute('id', `lesson-clip-${surface}`)
      const r = document.createElementNS(NS, 'rect')
      r.setAttribute('x', String(bx.x)); r.setAttribute('y', String(bx.y))
      r.setAttribute('width', String(bx.w)); r.setAttribute('height', String(bx.h))
      cp.appendChild(r)
      defs.appendChild(cp)
    }
    s.appendChild(defs)

    // Spotlit volume: dim every bar but the ones being talked about.
    const vbox = box('volume')
    if (b.volume !== null && vbox !== null) {
      const half = space() / 2 + 1
      const holes = b.volume.map(t => px({ t, v: 0 }, 'volume')).filter((p): p is Pt => p !== null)
      let d = `M${vbox.x} ${vbox.y}h${vbox.w}v${vbox.h}h${-vbox.w}Z`
      for (const p of holes) d += ` M${(p.x - half).toFixed(1)} ${vbox.y}h${(half * 2).toFixed(1)}v${vbox.h}h${(-half * 2).toFixed(1)}Z`
      const mask = document.createElementNS(NS, 'path')
      mask.setAttribute('d', d)
      mask.setAttribute('fill', ink.dim)
      mask.setAttribute('fill-rule', 'evenodd')
      s.appendChild(mask)
    }

    // Highlighter and tints first, so the pen sits on top of them.
    const order = [...b.marks].sort((m1, m2) => rank(m1) - rank(m2))
    let delay = 0
    for (const m of order) {
      const bx = box(m.surface)
      if (bx === null) continue
      const faint = m.state === 'faint'
      const hot = b.hot === m.id
      const dim = b.hot !== null && !hot && !faint
      const fresh = animate && m.fresh
      const color = m.tone === 'up' ? ink.up : m.tone === 'down' ? ink.down : ink.pen
      const opacity = faint ? 0.3 : dim ? 0.35 : 1
      const width = hot ? 3.2 : faint ? 1.4 : 2.2
      const r = rng(seedOf(m.id))
      const clip = `lesson-clip-${m.surface}`
      const caption = (x: number, y: number, how: 'left' | 'right' | 'center'): void => {
        if (m.label !== undefined && !faint) label(m.label, x, y, dim ? ink.muted : color, how, fresh, hot)
      }
      if (m.type === 'zone' && m.low !== undefined && m.high !== undefined) {
        const top = yOf(m.high, m.surface)
        const bottom = yOf(m.low, m.surface)
        if (top === null || bottom === null) continue
        const y = Math.min(top, bottom) - 1.5
        const h = Math.max(4, Math.abs(bottom - top) + 3)
        rect(bx.x, y, bx.w, h, ink.lime, ink.hlOpacity * (faint ? 0.35 : hot ? 1.6 : 1), { blend: ink.hlBlend, sweep: fresh, flash: animate && m.flash })
        caption(bx.x + 8, y - 10, 'left')
      } else if (m.type === 'span' && m.from !== undefined && m.to !== undefined) {
        const a = px({ t: m.from, v: 0 }, 'price')
        const z = px({ t: m.to, v: 0 }, 'price')
        if (a === null || z === null) continue
        const half = space() / 2
        rect(a.x - half, bx.y, z.x - a.x + half * 2, bx.h, ink.pen, isDark ? 0.06 : 0.045)
        path(stroke({ x: a.x - half, y: bx.y + bx.h - 22 }, { x: z.x + half, y: bx.y + bx.h - 22 }, r, 0.7), color, 1.6, { opacity, fresh, clip })
        caption(a.x - half + 6, bx.y + bx.h - 36, 'left')
      } else if (m.type === 'level' && m.price !== undefined) {
        const y = yOf(m.price, m.surface)
        if (y === null) continue
        path(stroke({ x: bx.x + 4, y }, { x: bx.x + bx.w - 4, y }, r, 0.5), color, width, { opacity, fresh, delay, clip })
        caption(bx.x + 8, y - 11, 'left')
      } else if (m.type === 'circle' && m.at !== undefined) {
        const c = px(m.at, m.surface)
        if (c === null) continue
        const rx = Math.max(10, space() * 0.75)
        const ry = m.surface === 'price' ? 12 : 10
        path(loop(c, rx, ry, r), color, width, { opacity, fresh, delay })
        const bar = list.find(k => k.timestamp === m.at!.t)
        if (m.surface !== 'price') caption(c.x - rx - 6, c.y, 'right')
        else if (bar !== undefined && m.at.v < (bar.high + bar.low) / 2) caption(c.x, c.y + ry + 12, 'center')
        else caption(c.x, c.y - ry - 12, 'center')
      } else if ((m.type === 'path' || m.type === 'arrow') && m.points !== undefined) {
        const pts = m.points.map(p => px(p, m.surface)).filter((p): p is Pt => p !== null)
        if (pts.length < 2) continue
        const projects = m.points.some(p => 'ahead' in p)
        let d = polyline(pts, r, m.type === 'arrow' && !projects)
        if (m.type === 'arrow') d += ` ${arrowHead(pts[pts.length - 2]!, pts[pts.length - 1]!, r)}`
        path(d, color, width, { opacity, dash: projects, fresh, delay: delay + 80 })
        const end = pts[pts.length - 1]!
        caption(end.x + 10, end.y, 'left')
      }
      if (fresh) delay += 160
    }

    // The pointer rests on whatever is being talked about.
    const at = target(b.pointer)
    if (at === null) {
      ptr.hidden = true
    } else {
      ptr.hidden = false
      ptr.style.transition = beatChanged && sameShot && !reducedMotion() ? 'transform .5s cubic-bezier(.16,1,.3,1)' : 'none'
      ptr.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
    }

    function target(t: PointerTarget | null): Pt | null {
      if (t === null || b === null) return null
      if (!('mark' in t)) return px({ t: t.t, v: t.v }, t.surface)
      const m = b.marks.find(x => x.id === t.mark)
      if (m === undefined) return null
      const xr = lastX()
      if (m.type === 'circle' && m.at !== undefined) return px(m.at, m.surface)
      if (m.type === 'level' && m.price !== undefined) {
        const y = yOf(m.price, m.surface)
        return y === null || xr === null ? null : { x: xr - 46, y }
      }
      if (m.type === 'zone' && m.low !== undefined && m.high !== undefined) {
        const a = yOf(m.high, m.surface)
        const z = yOf(m.low, m.surface)
        return a === null || z === null || xr === null ? null : { x: xr - 46, y: (a + z) / 2 }
      }
      if (m.points !== undefined) return px(m.points[m.points.length - 1]!, m.surface)
      if (m.from !== undefined && m.to !== undefined) {
        const a = px({ t: m.from, v: 0 }, 'price')
        const z = px({ t: m.to, v: 0 }, 'price')
        const bx = box('price')
        return a === null || z === null || bx === null ? null : { x: (a.x + z.x) / 2, y: bx.y + bx.h * 0.4 }
      }
      return null
    }
  }

  const ink = dark ? DARK : LIGHT
  return (
    <div ref={root} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 2 }} aria-hidden="true">
      <svg ref={svg} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} />
      <div ref={labels} style={{ position: 'absolute', inset: 0 }} />
      <div ref={pointer} hidden style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }}>
        <span style={{
          position: 'absolute', left: -7, top: -7, width: 14, height: 14, borderRadius: '50%', background: ink.lime,
          boxShadow: `0 0 0 2px ${ink.ring}, 0 0 14px rgba(101,248,79,0.7)`,
        }} />
        <span ref={ring} style={{ position: 'absolute', left: -9, top: -9, width: 18, height: 18, borderRadius: '50%', border: `2px solid ${ink.lime}`, opacity: 0 }} />
      </div>
    </div>
  )
}

/** Run a call on a chart that may already be disposed. */
function safely(run: () => void): void {
  try {
    run()
  } catch {
    // The chart went away first; nothing left to restore.
  }
}

/** Fills before strokes. */
function rank(m: BoardMark): number {
  return m.type === 'zone' || m.type === 'span' ? 0 : 1
}
