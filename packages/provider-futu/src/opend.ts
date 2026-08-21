/**
 * The only module that touches the Futu SDK or a socket. Everything the
 * provider needs from OpenD goes through here, so the rest of the package
 * stays pure and testable.
 *
 * Two behaviours are carried over from the working TradingDraw integration
 * because they were learned the hard way, not read in a manual:
 *
 *  1. **Probe before connecting.** When OpenD is unreachable the SDK
 *     reconnects on a timer forever and leaves callers hanging with no error.
 *     A one-shot TCP probe turns that into a fast, explainable failure.
 *  2. **Subscribe, then read `Qot_GetKL`** — not `Qot_RequestHistoryKL`.
 *     GetKL rides the subscription quota and serves up to 1000 recent bars;
 *     RequestHistoryKL spends a scarce historical quota that OpenD rations by
 *     account assets over rolling 7-day windows. For regime analysis over
 *     recent bars, GetKL is both cheaper and unmetered.
 * @module
 */

import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { describeVersionSkew } from './protocol.js'

/** The SDK client surface this module uses. */
interface FutuClient {
  /** Success is boolean `true`; on failure `msg` carries the rejected response. */
  onlogin: ((ret: boolean, msg: unknown) => void) | null
  /** Server push sink: `(cmd, decodedResponse)`. Set before subscribing. */
  onPush: ((cmd: number, message: unknown) => void) | null
  start(ip: string, port: number, ssl: boolean, key?: string): void
  stop(): void
  Sub(req: unknown): Promise<unknown>
  RegQotPush(req: unknown): Promise<unknown>
  GetGlobalState(req: unknown): Promise<{ s2c?: { serverVer?: number; serverBuildNo?: number } }>
  GetKL(req: unknown): Promise<{ s2c?: { klList?: unknown[]; name?: string } }>
}

/** `Qot_UpdateKL` — the candlestick push. */
const CMD_UPDATE_KL = 3007

/** One push frame, as much of it as this module reads. */
interface UpdateKLPush {
  s2c?: {
    klType?: number
    security?: { market?: number; code?: string }
    klList?: unknown[]
  }
}

/** Listener fed by the candlestick push. */
export type KLinePushListener = (key: string, bars: readonly unknown[]) => void

/** Cache/route key for one subscribed series. */
export function seriesKeyOf(market: number, code: string, klType: number): string {
  return `${market}.${code}:${klType}`
}

/** Connection settings for a local OpenD. */
export interface OpenDConfig {
  host: string
  /** OpenD's **websocket** port — distinct from the protobuf-over-TCP `api_port`. */
  port: number
  ssl: boolean
  key?: string | undefined
  /** Milliseconds to wait for the login handshake. */
  loginTimeoutMs: number
  /** Called once per connection with anything worth warning the operator about. */
  onWarning?: ((message: string) => void) | undefined
}

/**
 * OpenD refuses a JavaScript client that presents no auth key, and reports it
 * as a bare `retType: -1` with an empty message — so the hint has to carry the
 * diagnosis the protocol withholds.
 */
export const AUTH_HINT =
  "OpenD requires a WebSocket auth key from JavaScript clients (`websocket_key_md5`; the OpenD UI field takes the plaintext, at most 16 characters, and stores its MD5). Set one in OpenD, restart it, and pass the same plaintext as this row's `key` config."

/** Guidance repeated wherever the connection fails; the fix is never obvious. */
export function unreachableMessage(config: OpenDConfig): string {
  return (
    `Futu OpenD is not reachable at ${config.host}:${config.port}. Check that: ` +
    `(1) the Futu OpenD app is running and logged in; ` +
    `(2) its WebSocket listener is enabled — OpenD's default api_port (11111) speaks protobuf over TCP and is NOT the websocket port, ` +
    `so set a websocket port in OpenD (config key 'websocket_port', conventionally 33333) and restart it.`
  )
}

/**
 * One-shot TCP reachability probe.
 * @param host - OpenD host.
 * @param port - OpenD websocket port.
 * @param timeoutMs - probe budget.
 * @returns whether something is listening.
 */
export function probe(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** The installed SDK's version, or '' when it cannot be read. */
function sdkVersion(): string {
  try {
    return String(createRequire(import.meta.url)('futu-api/package.json').version ?? '')
  } catch {
    return ''
  }
}

/** Normalise an SDK rejection — it rejects with a decoded Response, not an Error. */
function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'object' && reason !== null && 'retMsg' in reason) {
    return String((reason as { retMsg: unknown }).retMsg)
  }
  return String(reason)
}

/**
 * A lazily-connected OpenD session that remembers which (security, subType)
 * pairs it has already subscribed. Subscriptions are a metered resource in
 * OpenD, so re-subscribing on every read would burn the quota that funds the
 * reads themselves.
 */
export class OpenDSession {
  #client: FutuClient | null = null
  #connecting: Promise<FutuClient> | null = null
  readonly #subscribed = new Set<string>()
  readonly #listeners = new Set<KLinePushListener>()

  constructor(private readonly config: OpenDConfig) {}

  /** Connect (once) and return the live client. */
  async client(): Promise<FutuClient> {
    if (this.#client !== null) return this.#client
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null
    })
    return this.#connecting
  }

  async #connect(): Promise<FutuClient> {
    if (!(await probe(this.config.host, this.config.port))) {
      throw new Error(unreachableMessage(this.config))
    }
    // Imported lazily so a headless profile that never touches Futu does not
    // pay for the SDK's protobuf tree at load time.
    const mod = (await import('futu-api')) as unknown as { default: new () => FutuClient }
    const client = new mod.default()

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Futu OpenD did not complete login within ${this.config.loginTimeoutMs}ms. ${unreachableMessage(this.config)}`))
      }, this.config.loginTimeoutMs)
      // The SDK reports success as boolean `true` (onlogin(true, response)) —
      // not a 0/1 status code. On failure it hands back whatever went wrong,
      // which for a rejected handshake is an InitWebSocket response whose only
      // populated field is `retType: -1`, with no message. The commonest cause
      // is a missing websocket auth key, so say so rather than echoing a bare
      // `-1` the user cannot act on.
      client.onlogin = (ret, msg) => {
        clearTimeout(timer)
        if (ret === true) resolve()
        else reject(new Error(`Futu OpenD rejected the websocket handshake (${describe(msg)}). ${AUTH_HINT}`))
      }
      client.start(this.config.host, this.config.port, this.config.ssl, this.config.key)
    })

    // Route candlestick pushes to whoever is holding a warm series. Installed
    // once per connection, before any subscription, so no push can arrive with
    // nowhere to go.
    client.onPush = (cmd, message) => {
      if (cmd !== CMD_UPDATE_KL) return
      const s2c = (message as UpdateKLPush).s2c
      const market = s2c?.security?.market
      const code = s2c?.security?.code
      const klType = s2c?.klType
      const bars = s2c?.klList
      if (market === undefined || code === undefined || klType === undefined || bars === undefined) return
      const key = seriesKeyOf(market, code, klType)
      for (const listener of this.#listeners) listener(key, bars)
    }

    // Ask OpenD what it is before trusting it with anything. A protocol-line
    // skew between the SDK and OpenD surfaces later as unexplained failures
    // (a rejected handshake, a decode that yields nothing), and the operator
    // has no way to guess the cause from those symptoms.
    if (this.config.onWarning !== undefined) {
      try {
        const state = await client.GetGlobalState({ c2s: { userID: 0 } })
        const skew = describeVersionSkew(sdkVersion(), {
          serverVer: state.s2c?.serverVer ?? 0,
          serverBuildNo: state.s2c?.serverBuildNo ?? 0,
        })
        if (skew !== null) this.config.onWarning(skew)
      } catch {
        // A version probe must never be the reason a working connection fails.
      }
    }

    this.#client = client
    return client
  }

  /**
   * Subscribe to candlestick pushes.
   * @param listener - called for every pushed bar batch.
   * @returns unsubscribe.
   */
  onKLine(listener: KLinePushListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Subscribe one security/subType pair, at most once per session.
   * @param market - QotMarket value.
   * @param code - market-scoped code.
   * @param subType - SubType value funding the read.
   */
  async subscribe(market: number, code: string, subType: number): Promise<void> {
    const key = `${market}.${code}:${subType}`
    if (this.#subscribed.has(key)) return
    const client = await this.client()
    try {
      // `isRegOrUnRegPush` is what turns a subscription into a live feed.
      // Futu's own guidance is that continuous reading belongs on the push
      // (`Qot_UpdateKL`), not on repeated `Qot_GetKL` calls — GetKL is the
      // snapshot that seeds a series, the push is what keeps it current.
      await client.Sub({
        c2s: {
          securityList: [{ market, code }],
          subTypeList: [subType],
          isSubOrUnSub: true,
          isRegOrUnRegPush: true,
          isFirstPush: true,
        },
      })
      await client.RegQotPush({
        c2s: {
          securityList: [{ market, code }],
          subTypeList: [subType],
          rehabTypeList: [1],
          isRegOrUnReg: true,
          isFirstPush: true,
        },
      })
    } catch (reason) {
      throw new Error(`Futu subscribe failed for ${code}: ${describe(reason)}`)
    }
    this.#subscribed.add(key)
  }

  /**
   * Read the most recent bars for a subscribed security.
   * @param market - QotMarket value.
   * @param code - market-scoped code.
   * @param klType - KLType value.
   * @param reqNum - bars requested; OpenD caps this at 1000.
   * @returns the raw KLine list plus the instrument's display name.
   */
  async getKL(market: number, code: string, klType: number, reqNum: number): Promise<{ klList: unknown[]; name: string }> {
    const client = await this.client()
    try {
      const res = await client.GetKL({
        c2s: { rehabType: 1, klType, security: { market, code }, reqNum },
      })
      return { klList: res.s2c?.klList ?? [], name: res.s2c?.name ?? '' }
    } catch (reason) {
      throw new Error(`Futu candle read failed for ${code}: ${describe(reason)}`)
    }
  }

  /** Drop the connection; safe to call when never connected. */
  close(): void {
    this.#client?.stop()
    this.#client = null
    this.#subscribed.clear()
    this.#listeners.clear()
  }
}
