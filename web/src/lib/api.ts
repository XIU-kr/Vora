const API_REQUEST_TIMEOUT_MS = 95_000

const getRequestId = () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = API_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

export async function inpaintViaApi(opts: {
  image: Blob
  mask: Blob
}): Promise<Blob> {
  const body = new FormData()
  body.append('image', opts.image, 'image.png')
  body.append('mask', opts.mask, 'mask.png')

  let res: Response
  try {
    res = await fetchWithTimeout('/api/inpaint', {
      method: 'POST',
      body,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('ERR_INPAINT_HTTP:524:Request timeout while waiting for /api/inpaint. Check backend worker/container readiness.')
    }
    throw e
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const cloudflareTimeout = /error code\s*524|a timeout occurred/i.test(text)
    if (cloudflareTimeout) {
      throw new Error('ERR_INPAINT_HTTP:524:Cloudflare timeout (origin response exceeded proxy timeout). Check backend container health and /api proxy route.')
    }
    throw new Error(`ERR_INPAINT_HTTP:${res.status}:${text}`)
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    const text = await res.text().catch(() => '')
    const snippet = text.slice(0, 140).replace(/\s+/g, ' ').trim()
    throw new Error(`ERR_INPAINT_NON_IMAGE:${snippet}`)
  }

  return await res.blob()
}

export async function segmentPointViaApi(opts: {
  image: Blob
  pointX: number
  pointY: number
}): Promise<Blob> {
  const requestId = getRequestId()
  const startedAt = performance.now()
  if (import.meta.env.DEV) {
    console.debug('[api] segment-point request', {
      requestId,
      pointX: Math.round(opts.pointX),
      pointY: Math.round(opts.pointY),
      imageBytes: opts.image.size,
      imageType: opts.image.type || 'unknown',
    })
  }
  const body = new FormData()
  body.append('image', opts.image, 'image.png')
  body.append('pointX', String(Math.round(opts.pointX)))
  body.append('pointY', String(Math.round(opts.pointY)))

  let res: Response
  try {
    res = await fetchWithTimeout('/api/segment-point', {
      method: 'POST',
      body,
    })
    if (import.meta.env.DEV) {
      console.debug('[api] segment-point response', {
        requestId,
        status: res.status,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      if (import.meta.env.DEV) {
        console.error('[api] segment-point timeout', {
          requestId,
          elapsedMs: Math.round(performance.now() - startedAt),
          timeoutMs: API_REQUEST_TIMEOUT_MS,
        })
      }
      throw new Error('ERR_SEGMENT_HTTP:524:Request timeout while waiting for /api/segment-point. Check backend worker/container readiness.')
    }
    if (import.meta.env.DEV) {
      console.error('[api] segment-point error', { requestId, error: String(e) })
    }
    throw e
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const cloudflareTimeout = /error code\s*524|a timeout occurred/i.test(text)
    if (cloudflareTimeout) {
      if (import.meta.env.DEV) {
        console.error('[api] segment-point response error', {
          requestId,
          status: res.status,
          snippet: text.slice(0, 140),
        })
      }
      throw new Error('ERR_SEGMENT_HTTP:524:Cloudflare timeout (origin response exceeded proxy timeout). Check backend container health and /api proxy route.')
    }
    if (import.meta.env.DEV) {
      console.error('[api] segment-point non-OK', {
        requestId,
        status: res.status,
      })
    }
    throw new Error(`ERR_SEGMENT_HTTP:${res.status}:${text}`)
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    const text = await res.text().catch(() => '')
    const snippet = text.slice(0, 140).replace(/\s+/g, ' ').trim()
    if (import.meta.env.DEV) {
      console.error('[api] segment-point non-image response', {
        requestId,
        contentType,
        snippet,
      })
    }
    throw new Error(`ERR_SEGMENT_NON_IMAGE:${snippet}`)
  }

  const blob = await res.blob()
  if (import.meta.env.DEV) {
    console.debug('[api] segment-point completed', {
      requestId,
      elapsedMs: Math.round(performance.now() - startedAt),
      contentType,
      maskBytes: blob.size,
    })
  }
  return blob
}
