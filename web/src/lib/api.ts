export async function inpaintViaApi(opts: {
  image: Blob
  mask: Blob
}): Promise<Blob> {
  const body = new FormData()
  body.append('image', opts.image, 'image.png')
  body.append('mask', opts.mask, 'mask.png')

  const res = await fetch('/api/inpaint', {
    method: 'POST',
    body,
  })

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
  const body = new FormData()
  body.append('image', opts.image, 'image.png')
  body.append('pointX', String(Math.round(opts.pointX)))
  body.append('pointY', String(Math.round(opts.pointY)))

  const res = await fetch('/api/segment-point', {
    method: 'POST',
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const cloudflareTimeout = /error code\s*524|a timeout occurred/i.test(text)
    if (cloudflareTimeout) {
      throw new Error('ERR_SEGMENT_HTTP:524:Cloudflare timeout (origin response exceeded proxy timeout). Check backend container health and /api proxy route.')
    }
    throw new Error(`ERR_SEGMENT_HTTP:${res.status}:${text}`)
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    const text = await res.text().catch(() => '')
    const snippet = text.slice(0, 140).replace(/\s+/g, ' ').trim()
    throw new Error(`ERR_SEGMENT_NON_IMAGE:${snippet}`)
  }

  return await res.blob()
}
