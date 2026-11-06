/**
 * tradingdraw.celineyu.me front door.
 *
 * The Cloud Run origin runs a gateway that expects a shared header no browser
 * can hold, so the origin URL alone is not a usable back door. This Worker is
 * the only caller that adds it.
 *
 * WebSockets are tunnelled explicitly: the workbench's event stream is a
 * WebSocket, and a plain `return fetch(request)` does not relay frames.
 */
function withGateway(headers, env) {
  const next = new Headers(headers)
  next.set('x-dash-gateway', env.DASH_GATEWAY_TOKEN)
  next.set('x-forwarded-proto', 'https')
  next.delete('cf-connecting-ip')
  next.delete('cf-ray')
  next.delete('cf-visitor')
  return next
}

async function proxyWebSocket(request, env, origin) {
  const url = new URL(request.url)
  const upstream = await fetch(new URL(url.pathname + url.search, origin), {
    headers: withGateway(request.headers, env),
  })
  const socket = upstream.webSocket
  if (upstream.status !== 101 || socket === null) {
    return new Response('WebSocket origin refused the upgrade', { status: 502 })
  }
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  socket.accept()
  socket.addEventListener('message', event => {
    try {
      server.send(event.data)
    } catch {
      socket.close(1011, 'client gone')
    }
  })
  socket.addEventListener('close', event => {
    try {
      server.close(event.code, event.reason)
    } catch {
      /* already closed */
    }
  })
  server.addEventListener('message', event => {
    try {
      socket.send(event.data)
    } catch {
      server.close(1011, 'origin gone')
    }
  })
  server.addEventListener('close', event => {
    try {
      socket.close(event.code, event.reason)
    } catch {
      /* already closed */
    }
  })
  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request, env) {
    const origin = env.DASH_ORIGIN
    if (typeof origin !== 'string' || !origin.startsWith('https://')) {
      return new Response('DASH_ORIGIN is not configured for this Worker', { status: 500 })
    }
    const incoming = new URL(request.url)
    // The old name was a transcription slip; keep every shared link working.
    if (incoming.hostname === 'dash.celineyu.me' || incoming.hostname === 'proofline.celineyu.me') {
      return Response.redirect(`https://tradingdraw.celineyu.me${incoming.pathname}${incoming.search}`, 301)
    }
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return proxyWebSocket(request, env, origin)
    }
    const url = incoming
    const upstream = new Request(new URL(url.pathname + url.search, origin), {
      method: request.method,
      headers: withGateway(request.headers, env),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    })
    const response = await fetch(upstream)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  },
}
