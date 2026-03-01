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
