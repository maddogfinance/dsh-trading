/**
 * Ambient types for `futu-api`, which ships JavaScript and no declarations.
 *
 * Deliberately minimal: it describes only the handful of members this package
 * calls, so the SDK's 130-method surface cannot leak into our code untyped and
 * unnoticed. The full request/response shapes stay `unknown` — they are
 * protobuf messages validated by OpenD, and pretending to type them here would
 * be fiction that drifts with every SDK bump.
 */
declare module 'futu-api' {
  /** The websocket client. Construct, `start`, then call protocol methods. */
  class FtWebsocket {
    /** Login callback: `ret` is boolean `true` on success; `msg` carries the rejected response otherwise. Set before `start`. */
    onlogin: ((ret: boolean, msg: unknown) => void) | null
    /** Open the websocket and begin the InitWebSocket handshake. */
    start(ip: string, port: number, ssl: boolean, key?: string): void
    /** Detach push callbacks. */
    stop(): void
    /** `Qot_Sub` — subscribe or unsubscribe securities. */
    Sub(req: unknown): Promise<unknown>
    /** `Qot_GetKL` — recent candles for a subscribed security. */
    GetKL(req: unknown): Promise<{ s2c?: { klList?: unknown[]; name?: string } }>
  }

  export default FtWebsocket
}
