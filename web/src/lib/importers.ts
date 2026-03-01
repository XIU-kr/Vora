import * as pdfjs from 'pdfjs-dist'

export type ImportedBitmap = {
  name: string
  dataUrl: string
  width: number
  height: number
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('ERR_IMPORT_READ_FILE'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('ERR_IMPORT_IMAGE_LOAD'))
    img.src = dataUrl
  })
}

export async function importImageFile(file: File): Promise<ImportedBitmap> {
  const dataUrl = await readFileAsDataUrl(file)
  const img = await loadImageFromDataUrl(dataUrl)
  return {
    name: file.name,
    dataUrl,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
  }
}

export async function importPdfFile(file: File): Promise<ImportedBitmap[]> {
  const buf = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: buf }).promise
  const out: ImportedBitmap[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 2 })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('ERR_CANVAS_INIT_FAILED')

    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    const dataUrl = canvas.toDataURL('image/png')

    out.push({
      name: `${file.name}#${i}`,
      dataUrl,
      width: canvas.width,
      height: canvas.height,
    })
  }

  return out
}
