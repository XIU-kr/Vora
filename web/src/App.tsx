import { type DragEvent, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import Konva from 'konva'
import { Circle, Ellipse, Image as KonvaImage, Layer, Line, Stage, Text, Group, Rect, Transformer } from 'react-konva'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowsUpDownLeftRight,
  faCropSimple,
  faEraser,
  faFont,
  faMagnifyingGlass,
  faObjectGroup,
  faPlus,
  faRotateLeft,
  faRotateRight,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons'
import { jsPDF } from 'jspdf'
import PptxGenJS from 'pptxgenjs'

import './App.css'
import type { LayerGroup, MaskStroke, PageAsset, TextItem, Tool } from './lib/types'
import { importImageFile, importPdfFile } from './lib/importers'
import { inpaintViaApi, segmentPointViaApi } from './lib/api'
import { dataUrlToBlob, downloadBlob } from './lib/download'

type Size = { w: number; h: number }
const SUPPORTED_LOCALES = ['ko', 'en'] as const
type Locale = (typeof SUPPORTED_LOCALES)[number]
type ExportKind = 'png' | 'jpg' | 'webp' | 'pdf' | 'pptx'
type ExportScope = 'current' | 'selected' | 'all'

type PageSnapshot = {
  width: number
  height: number
  baseDataUrl: string
  texts: TextItem[]
  groups: LayerGroup[]
}

type AssetListSnapshot = {
  assets: PageAsset[]
  activeId: string | null
}

type AssetListHistoryEntry = {
  label: string
  snapshot: AssetListSnapshot
  timestamp: number
}

type CropRect = {
  x: number
  y: number
  width: number
  height: number
}

type InpaintJob = {
  assetId: string
  strokes: MaskStroke[]
  boundsOverride?: CropRect | null
}

type MaskApplyScope = 'full' | 'crop'

type PendingMaskAction = {
  tool: 'restore' | 'eraser'
  assetId: string
  strokes: MaskStroke[]
}

type SelectionAction = 'eraseSelection' | 'transparentBackground' | 'fillBackground' | 'replaceBackground' | 'restoreSelection'

type NormalizedStroke = {
  points: number[]
  strokeWidthRatio: number
}

type UiDensity = 'default' | 'compact'
type SettingsTab = 'general' | 'editing' | 'info'
type RightPanelTab = 'properties' | 'layers' | 'history'
type TooltipDensity = 'simple' | 'detailed'
type AnimationStrength = 'low' | 'default' | 'high'
type TextSnapStrength = 'off' | 'soft' | 'normal' | 'strong'
type ShortcutCategory = 'tools' | 'selection' | 'history'
type MobileQuickAction = 'export' | 'activity' | 'shortcuts' | 'settings'
type CropHandle = 'nw' | 'ne' | 'sw' | 'se'
type CropPreset = 'free' | 'full' | '1:1' | '4:3' | '16:9'
type TextClickEditMode = 'single' | 'double'
type TextFontPresetId = string
type FontCategoryId = 'naverMaruBuri' | 'naverGothic' | 'naverMyeongjo' | 'naverSquare' | 'naverCoding' | 'naverHandwriting' | 'naverOther' | 'googleFree'

type ToastLogItem = {
  id: string
  text: string
  tone: 'error' | 'success' | 'working' | 'info'
  at: number
  assetId?: string | null
  snapshot?: string | null
}

type TextFontPreset = {
  id: TextFontPresetId
  family: string
  weight: number
  label: string
  category: FontCategoryId
}

type ActivityFilter = 'all' | 'error' | 'success' | 'working'

type AutoSavePayload = {
  assets: PageAsset[]
  activeId: string | null
  ts: number
}

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev'
const BRUSH_MIN = 1
const BRUSH_MAX = 2000
const BRUSH_SLIDER_MAX = 1000
const DEFAULT_BRUSH_SIZE = 150
const DEFAULT_AUTOSAVE_SECONDS = 60
const DEFAULT_ACTIVITY_LOG_LIMIT = 10
const DEFAULT_EXPORT_QUALITY = 92
const DEFAULT_ZOOM_WHEEL_SENSITIVITY = 1
const ERASER_COLOR_BUCKET_STEP = 8
const ZOOM_MIN = 0.3
const ZOOM_MAX = 5
const UPSCALE_OPTIONS = [1, 2, 4, 8] as const
const ERR_CANVAS_UNAVAILABLE = 'ERR_CANVAS_UNAVAILABLE'
const ERR_PNG_CONVERT_FAILED = 'ERR_PNG_CONVERT_FAILED'
const ERR_IMAGE_LOAD_FAILED = 'ERR_IMAGE_LOAD_FAILED'
const ERR_DATA_URL_CONVERT_FAILED = 'ERR_DATA_URL_CONVERT_FAILED'
const ERR_SEGMENT_MASK_EMPTY = 'ERR_SEGMENT_MASK_EMPTY'

function uid(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function splitFilename(name: string): { base: string; ext: string } {
  const trimmed = name.trim()
  const idx = trimmed.lastIndexOf('.')
  if (idx <= 0 || idx === trimmed.length - 1) {
    return { base: trimmed || 'image', ext: '' }
  }
  return { base: trimmed.slice(0, idx), ext: trimmed.slice(idx + 1) }
}

function buildVoraFilename(name: string, exportExt: string) {
  const trimmed = name.trim() || 'image'
  const withPageToken = trimmed.replaceAll('#', '_')
  const base = withPageToken.replace(/\.(png|jpe?g|webp|pdf|pptx)$/i, '')
  const safeBase = base.replace(/[\\/:*?"<>|]+/g, '_')
  const safeExt = exportExt.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
  return `${safeBase}_vora.${safeExt}`
}

function buildVoraBundleFilename(name: string, suffix: string, ext: string) {
  const { base } = splitFilename(name)
  const safeBase = base.replace(/[\\/:*?"<>|]+/g, '_').replaceAll('#', '_')
  return `${safeBase}_vora${suffix}.${ext}`
}

function normalizeCropRect(rect: CropRect, maxW: number, maxH: number): CropRect {
  const x = clamp(Math.round(rect.x), 0, Math.max(0, maxW - 1))
  const y = clamp(Math.round(rect.y), 0, Math.max(0, maxH - 1))
  const width = clamp(Math.round(rect.width), 1, Math.max(1, maxW - x))
  const height = clamp(Math.round(rect.height), 1, Math.max(1, maxH - y))
  return { x, y, width, height }
}

function rectFromPoints(startX: number, startY: number, endX: number, endY: number, maxW: number, maxH: number): CropRect {
  const x1 = clamp(startX, 0, maxW)
  const y1 = clamp(startY, 0, maxH)
  const x2 = clamp(endX, 0, maxW)
  const y2 = clamp(endY, 0, maxH)
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  const right = Math.max(x1, x2)
  const bottom = Math.max(y1, y2)
  return normalizeCropRect(
    {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    },
    maxW,
    maxH,
  )
}

function brushToSlider(value: number) {
  const clamped = clamp(value, BRUSH_MIN, BRUSH_MAX)
  const ratio = (clamped - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)
  return Math.round(Math.sqrt(ratio) * BRUSH_SLIDER_MAX)
}

function sliderToBrush(value: number) {
  const ratio = clamp(value, 0, BRUSH_SLIDER_MAX) / BRUSH_SLIDER_MAX
  return Math.round(BRUSH_MIN + ratio * ratio * (BRUSH_MAX - BRUSH_MIN))
}

function toKonvaFontStyle(item: Pick<TextItem, 'fontWeight' | 'fontStyle'>): string {
  const bold = item.fontWeight >= 600
  if (bold && item.fontStyle === 'italic') return 'bold italic'
  if (bold) return 'bold'
  if (item.fontStyle === 'italic') return 'italic'
  return 'normal'
}

function estimateTextBoxForAsset(text: string, item: TextItem, asset: PageAsset): { width: number; height: number } {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return {
      width: clamp(Math.round(item.fontSize * Math.max(2, text.length * 0.62)), 24, asset.width),
      height: clamp(Math.round(item.fontSize * 1.35), 12, asset.height),
    }
  }

  const weight = item.fontWeight >= 600 ? 'bold ' : ''
  const italic = item.fontStyle === 'italic' ? 'italic ' : ''
  const fontSize = clamp(Math.round(item.fontSize), 8, 320)
  ctx.font = `${italic}${weight}${fontSize}px "${item.fontFamily}", "Pretendard", "Noto Sans KR", sans-serif`
  const lines = text.split(/\r?\n/)
  let maxWidth = 0
  for (const line of lines) {
    const w = Math.ceil(ctx.measureText(line || ' ').width)
    if (w > maxWidth) maxWidth = w
  }
  const width = clamp(maxWidth + 12, 24, Math.max(24, asset.width - item.x))
  const lineHeight = Math.max(14, Math.round(fontSize * 1.3))
  const height = clamp(lineHeight * Math.max(1, lines.length), 14, Math.max(14, asset.height - item.y))
  return { width, height }
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ w: 800, h: 600 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      setSize({ w: Math.max(1, Math.floor(cr.width)), h: Math.max(1, Math.floor(cr.height)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, size }
}

async function renderMaskToPng(opts: {
  width: number
  height: number
  strokes: MaskStroke[]
}): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = opts.width
  canvas.height = opts.height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'white'

  for (const stroke of opts.strokes) {
    const pts = stroke.points
    if (pts.length < 4) continue
    ctx.lineWidth = stroke.strokeWidth
    ctx.strokeStyle = 'white'
    ctx.beginPath()
    ctx.moveTo(pts[0], pts[1])
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(pts[i], pts[i + 1])
    }
    ctx.stroke()
  }

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error(ERR_PNG_CONVERT_FAILED)
  return blob
}

function loadHtmlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(ERR_IMAGE_LOAD_FAILED))
    img.src = dataUrl
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = reader.result
      if (typeof value !== 'string') {
        reject(new Error(ERR_DATA_URL_CONVERT_FAILED))
        return
      }
      resolve(value)
    }
    reader.onerror = () => reject(new Error(ERR_DATA_URL_CONVERT_FAILED))
    reader.readAsDataURL(blob)
  })
}

function cloneStrokes(strokes: MaskStroke[]): MaskStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: [...stroke.points],
  }))
}

function cloneTextItems(texts: TextItem[]): TextItem[] {
  return texts.map((text) => ({ ...text }))
}

function cloneLayerGroups(groups: LayerGroup[]): LayerGroup[] {
  return groups.map((group) => ({ ...group }))
}

function snapshotFromAsset(asset: PageAsset): PageSnapshot {
  return {
    width: asset.width,
    height: asset.height,
    baseDataUrl: asset.baseDataUrl,
    texts: cloneTextItems(asset.texts),
    groups: cloneLayerGroups(asset.groups),
  }
}

function normalizeStrokes(strokes: MaskStroke[], width: number, height: number): NormalizedStroke[] {
  const base = Math.max(1, Math.min(width, height))
  return strokes.map((stroke) => ({
    points: stroke.points.map((value, idx) => (idx % 2 === 0 ? value / Math.max(1, width) : value / Math.max(1, height))),
    strokeWidthRatio: stroke.strokeWidth / base,
  }))
}

function denormalizeStrokes(template: NormalizedStroke[], width: number, height: number): MaskStroke[] {
  const base = Math.max(1, Math.min(width, height))
  return template.map((stroke, idx) => ({
    id: uid(`macro-${idx}`),
    points: stroke.points.map((value, pIdx) => (pIdx % 2 === 0 ? value * width : value * height)),
    strokeWidth: Math.max(1, stroke.strokeWidthRatio * base),
  }))
}

function getInpaintBounds(strokes: MaskStroke[], width: number, height: number, padding = 2): CropRect | null {
  if (strokes.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const stroke of strokes) {
    for (let i = 0; i < stroke.points.length; i += 2) {
      const x = stroke.points[i] ?? 0
      const y = stroke.points[i + 1] ?? 0
      minX = Math.min(minX, x - stroke.strokeWidth / 2)
      minY = Math.min(minY, y - stroke.strokeWidth / 2)
      maxX = Math.max(maxX, x + stroke.strokeWidth / 2)
      maxY = Math.max(maxY, y + stroke.strokeWidth / 2)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }

  return normalizeCropRect(
    {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    },
    width,
    height,
  )
}

function intersectCropRects(a: CropRect, b: CropRect, maxW: number, maxH: number): CropRect | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return null
  return normalizeCropRect({ x: left, y: top, width: right - left, height: bottom - top }, maxW, maxH)
}

async function renderAssetRegionToBlob(asset: PageAsset, rect: CropRect): Promise<Blob> {
  const source = await loadHtmlImage(asset.baseDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = rect.width
  canvas.height = rect.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error(ERR_PNG_CONVERT_FAILED)
  return blob
}

async function mergeInpaintResult(baseDataUrl: string, rect: CropRect, patchBlob: Blob): Promise<string> {
  const [baseImage, patchImage] = await Promise.all([
    loadHtmlImage(baseDataUrl),
    blobToDataUrl(patchBlob).then((url) => loadHtmlImage(url)),
  ])
  const canvas = document.createElement('canvas')
  canvas.width = baseImage.width
  canvas.height = baseImage.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)
  ctx.drawImage(baseImage, 0, 0)
  ctx.drawImage(patchImage, rect.x, rect.y, rect.width, rect.height)
  return canvas.toDataURL('image/png')
}

function dominantNeighborColor(ctx: CanvasRenderingContext2D, width: number, height: number, rect: CropRect): string {
  const pad = clamp(Math.round(Math.max(6, Math.min(width, height) * 0.01)), 6, 28)
  const x1 = clamp(rect.x - pad, 0, width)
  const y1 = clamp(rect.y - pad, 0, height)
  const x2 = clamp(rect.x + rect.width + pad, 0, width)
  const y2 = clamp(rect.y + rect.height + pad, 0, height)

  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
  const step = ERASER_COLOR_BUCKET_STEP

  function sampleRegion(sx: number, sy: number, sw: number, sh: number) {
    if (sw <= 0 || sh <= 0) return
    const data = ctx.getImageData(sx, sy, sw, sh).data
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] ?? 0
      if (alpha < 8) continue
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      const qr = Math.floor(r / step)
      const qg = Math.floor(g / step)
      const qb = Math.floor(b / step)
      const key = `${qr},${qg},${qb}`
      const prev = buckets.get(key)
      if (prev) {
        prev.count += 1
        prev.r += r
        prev.g += g
        prev.b += b
      } else {
        buckets.set(key, { count: 1, r, g, b })
      }
    }
  }

  sampleRegion(x1, y1, x2 - x1, Math.max(0, rect.y - y1))
  sampleRegion(x1, rect.y + rect.height, x2 - x1, Math.max(0, y2 - (rect.y + rect.height)))
  sampleRegion(x1, rect.y, Math.max(0, rect.x - x1), rect.height)
  sampleRegion(rect.x + rect.width, rect.y, Math.max(0, x2 - (rect.x + rect.width)), rect.height)

  let best: { count: number; r: number; g: number; b: number } | null = null
  for (const entry of buckets.values()) {
    if (!best || entry.count > best.count) best = entry
  }
  if (!best) return 'rgb(255, 255, 255)'
  return `rgb(${Math.round(best.r / best.count)}, ${Math.round(best.g / best.count)}, ${Math.round(best.b / best.count)})`
}

function drawImageCover(ctx: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number) {
  const sourceW = (image as HTMLImageElement).width ?? width
  const sourceH = (image as HTMLImageElement).height ?? height
  const scale = Math.max(width / Math.max(1, sourceW), height / Math.max(1, sourceH))
  const drawW = sourceW * scale
  const drawH = sourceH * scale
  const dx = (width - drawW) / 2
  const dy = (height - drawH) / 2
  ctx.drawImage(image, dx, dy, drawW, drawH)
}

function resolveFillColorRgb(color: string): [number, number, number] {
  const cv = document.createElement('canvas')
  cv.width = 1
  cv.height = 1
  const cx = cv.getContext('2d')
  if (!cx) return [255, 255, 255]
  cx.clearRect(0, 0, 1, 1)
  cx.fillStyle = color
  cx.fillRect(0, 0, 1, 1)
  const data = cx.getImageData(0, 0, 1, 1).data
  return [data[0] ?? 255, data[1] ?? 255, data[2] ?? 255]
}

async function renderMaskImageToBlob(maskDataUrl: string): Promise<Blob> {
  const img = await loadHtmlImage(maskDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)
  ctx.drawImage(img, 0, 0)
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error(ERR_PNG_CONVERT_FAILED)
  return blob
}

function findNonZeroMaskBounds(maskData: Uint8ClampedArray, width: number, height: number): CropRect | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4
      const value = maskData[idx] ?? 0
      if (value < 8) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

async function renderAssetToDataUrl(
  asset: PageAsset,
  pixelRatio = 2,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
  quality?: number,
): Promise<string> {
  const baseImg = await loadHtmlImage(asset.baseDataUrl)
  const container = document.createElement('div')
  const stage = new Konva.Stage({ container, width: asset.width, height: asset.height })
  const layer = new Konva.Layer()
  stage.add(layer)

  layer.add(new Konva.Image({ image: baseImg, x: 0, y: 0, width: asset.width, height: asset.height }))

  for (const t of asset.texts) {
    if (!t.visible) continue
    const box = estimateTextBoxForAsset(t.text, t, asset)
    const padX = 8
    const padY = 5
    const outlineColor = resolveTextOutlineColor(t)
    const backgroundColor = resolveTextBackgroundColor(t)
    const backgroundOpacity = resolveTextBackgroundOpacity(t)
    if (backgroundOpacity > 0.001) {
      layer.add(
        new Konva.Rect({
          x: t.x - padX,
          y: t.y - padY,
          width: box.width + padX * 2,
          height: box.height + padY * 2,
          fill: backgroundColor,
          opacity: backgroundOpacity,
          rotation: t.rotation,
          listening: false,
        }),
      )
    }
    layer.add(
      new Konva.Text({
        x: t.x,
        y: t.y,
        text: t.text,
        fontFamily: t.fontFamily,
        fontSize: t.fontSize,
        fontStyle: toKonvaFontStyle(t),
        fill: t.fill,
        rotation: t.rotation,
        align: t.align,
        opacity: t.opacity,
        stroke: outlineColor,
        strokeWidth: 1.2,
        paintStrokeEnabled: true,
      }),
    )
  }

  layer.draw()
  const dataUrl = stage.toDataURL({ pixelRatio, mimeType, quality })
  stage.destroy()
  return dataUrl
}

const DEFAULT_TEXT: Omit<TextItem, 'id' | 'x' | 'y'> = {
  text: 'Text',
  fontFamily: 'NanumGothic',
  fontSize: 42,
  fill: '#111111',
  outlineColor: '#ffffff',
  backgroundColor: '#ffffff',
  backgroundOpacity: 0.2,
  fontWeight: 400,
  fontStyle: 'normal',
  rotation: 0,
  align: 'left',
  visible: true,
  locked: false,
  opacity: 1,
  groupId: 'group-default',
}

const NAVER_FREE_FONT_FAMILIES = [
  'MaruBuri',
  'MaruBuriBold',
  'MaruBuriExtraLight',
  'MaruBuriLight',
  'MaruBuriSemiBold',
  'NanumABbaEuiYeonAePyeonJi',
  'NanumABbaGeurSsi',
  'NanumAGiSaRangCe',
  'NanumAInMamSonGeurSsi',
  'NanumAJumMaJaYu',
  'NanumAReumDeuRiGgocNaMu',
  'NanumAmSeuTeReuDam',
  'NanumAnSsangCe',
  'NanumBaReunHiPi',
  'NanumBaReunJeongSin',
  'NanumBaeEunHyeCe',
  'NanumBaegEuiEuiCeonSa',
  'NanumBanJjagBanJjagByeor',
  'NanumBareunGothicLight',
  'NanumBareunGothicUltraLight',
  'NanumBarunGothic',
  'NanumBarunGothicBold',
  'NanumBarunGothicYetHangul',
  'NanumBarunpen',
  'NanumBarunpenB',
  'NanumBbangGuNiMamSonGeurSsi',
  'NanumBeoDeuNaMu',
  'NanumBeomSomCe',
  'NanumBiSangCe',
  'NanumBrush',
  'NanumBuJangNimNunCiCe',
  'NanumBugGeugSeong',
  'NanumCeorPirGeurSsi',
  'NanumCoDingHeuiMang',
  'NanumDaCaeSaRang',
  'NanumDaHaengCe',
  'NanumDaJinCe',
  'NanumDaSiSiJagHae',
  'NanumDaeGwangYuRi',
  'NanumDaeHanMinGugYeorSaCe',
  'NanumDarEuiGweDo',
  'NanumDdaAgDanDan',
  'NanumDdaDdeusHanJagByeor',
  'NanumDdarEGeEomMaGa',
  'NanumDdoBagDdoBag',
  'NanumDongHwaDdoBag',
  'NanumDungGeunInYeon',
  'NanumEomMaSaRang',
  'NanumEongGeongKwiCe',
  'NanumEuiMiIssNeunHanGeur',
  'NanumGaRamYeonGgoc',
  'NanumGangBuJangNimCe',
  'NanumGangInHanWiRo',
  'NanumGarMaesGeur',
  'NanumGeumEunBoHwa',
  'NanumGgeuTeuMeoRiCe',
  'NanumGgocNaeEum',
  'NanumGiBbeumBarkEum',
  'NanumGimYuICe',
  'NanumGoDigANiGoGoDing',
  'NanumGoRyeoGeurGgor',
  'NanumGomSinCe',
  'NanumGothic',
  'NanumGothicBold',
  'NanumGothicCoding',
  'NanumGothicCodingBold',
  'NanumGothicCodingLigature',
  'NanumGothicCodingLigatureBold',
  'NanumGothicEco',
  'NanumGothicEcoBold',
  'NanumGothicEcoExtraBold',
  'NanumGothicExtraBold',
  'NanumGothicLight',
  'NanumGyuRiEuiIrGi',
  'NanumHaNaDoeEoSonGeurSsi',
  'NanumHaNaSonGeurSsi',
  'NanumHaRamCe',
  'NanumHaengBogHanDoBi',
  'NanumHanYunCe',
  'NanumHarABeoJiEuiNaNum',
  'NanumHeuiMangNuRi',
  'NanumHeuinGgoRiSuRi',
  'NanumHimNaeRaNeunMarBoDan',
  'NanumHuman',
  'NanumHumanBold',
  'NanumHumanEB',
  'NanumHumanEL',
  'NanumHumanHeavy',
  'NanumHumanLight',
  'NanumHyeJunCe',
  'NanumHyeogICe',
  'NanumHyoNamNeurHwaITing',
  'NanumJaBuSimJiU',
  'NanumJangMiCe',
  'NanumJarHaGoIssEo',
  'NanumJeomGgorCe',
  'NanumJeongEunCe',
  'NanumJinJuBagGyeongACe',
  'NanumJungHagSaeng',
  'NanumKarGugSu',
  'NanumKoKoCe',
  'NanumMaGoCe',
  'NanumMasIssNeunCe',
  'NanumMiNiSonGeurSsi',
  'NanumMiRaeNaMu',
  'NanumMongDor',
  'NanumMuGungHwa',
  'NanumMuJinJangCe',
  'NanumMyeongjo',
  'NanumMyeongjoBold',
  'NanumMyeongjoEco',
  'NanumMyeongjoEcoBold',
  'NanumMyeongjoEcoExtraBold',
  'NanumMyeongjoExtraBold',
  'NanumMyeongjoYetHangul',
  'NanumNaEuiANaeSonGeurSsi',
  'NanumNaMuJeongWeon',
  'NanumNaNeunIGyeoNaenDa',
  'NanumNeuRisNeuRisCe',
  'NanumNoRyeogHaNeunDongHeui',
  'NanumOeHarMeoNiGeurSsi',
  'NanumOenSonJabIDoYeBbeo',
  'NanumOgBiCe',
  'NanumPen',
  'NanumSaRangHaeADeur',
  'NanumSangHaeCanMiCe',
  'NanumSeACe',
  'NanumSeGyeJeogInHanGeur',
  'NanumSeHwaCe',
  'NanumSeongSirCe',
  'NanumSiUGwiYeoWeo',
  'NanumSinHonBuBu',
  'NanumSoBangGwanEuiGiDo',
  'NanumSoMiCe',
  'NanumSonPyeonJiCe',
  'NanumSquare',
  'NanumSquareAcB',
  'NanumSquareAcEB',
  'NanumSquareAcL',
  'NanumSquareAcR',
  'NanumSquareBold',
  'NanumSquareExtraBold',
  'NanumSquareLight',
  'NanumSquareRound',
  'NanumSquareRoundB',
  'NanumSquareRoundEB',
  'NanumSquareRoundL',
  'NanumSuJubEunDaeHagSaeng',
  'NanumURiDdarSonGeurSsi',
  'NanumWaIrDeu',
  'NanumYaCaeJangSuBaegGeumRye',
  'NanumYaGeunHaNeunGimJuIm',
  'NanumYeBbeunMinGyeongCe',
  'NanumYeDangCe',
  'NanumYeoReumGeurSsi',
  'NanumYeonJiCe',
  'NanumYeorAHobEuiBanJjagIm',
  'NanumYeorIrCe',
  'NanumYuNiDdingDdangDdingDdang',
] as const

const FONT_CATEGORY_ORDER: readonly FontCategoryId[] = [
  'naverMaruBuri',
  'naverGothic',
  'naverMyeongjo',
  'naverSquare',
  'naverCoding',
  'naverHandwriting',
  'naverOther',
  'googleFree',
]

const FONT_CATEGORY_LABELS: Record<FontCategoryId, Record<Locale, string>> = {
  naverMaruBuri: { ko: '네이버 · 마루부리', en: 'Naver · MaruBuri' },
  naverGothic: { ko: '네이버 · 고딕/바른고딕', en: 'Naver · Gothic' },
  naverMyeongjo: { ko: '네이버 · 명조', en: 'Naver · Myeongjo' },
  naverSquare: { ko: '네이버 · 스퀘어', en: 'Naver · Square' },
  naverCoding: { ko: '네이버 · 코딩', en: 'Naver · Coding' },
  naverHandwriting: { ko: '네이버 · 손글씨', en: 'Naver · Handwriting' },
  naverOther: { ko: '네이버 · 기타', en: 'Naver · Others' },
  googleFree: { ko: 'Google · 무료 웹폰트', en: 'Google · Free webfonts' },
}

function getFontCategoryLabel(category: FontCategoryId, locale: Locale): string {
  return FONT_CATEGORY_LABELS[category][locale]
}

const NAVER_GOTHIC_FAMILIES = new Set([
  'NanumGothic',
  'NanumGothicBold',
  'NanumGothicExtraBold',
  'NanumGothicLight',
  'NanumGothicEco',
  'NanumGothicEcoBold',
  'NanumGothicEcoExtraBold',
  'NanumBarunGothic',
  'NanumBarunGothicBold',
  'NanumBareunGothicLight',
  'NanumBareunGothicUltraLight',
  'NanumBarunGothicYetHangul',
  'NanumHuman',
  'NanumHumanBold',
  'NanumHumanLight',
  'NanumHumanEL',
  'NanumHumanEB',
  'NanumHumanHeavy',
])

const NAVER_MYEONGJO_FAMILIES = new Set([
  'NanumMyeongjo',
  'NanumMyeongjoBold',
  'NanumMyeongjoExtraBold',
  'NanumMyeongjoEco',
  'NanumMyeongjoEcoBold',
  'NanumMyeongjoEcoExtraBold',
  'NanumMyeongjoYetHangul',
])

const NAVER_SQUARE_FAMILIES = new Set([
  'NanumSquare',
  'NanumSquareLight',
  'NanumSquareBold',
  'NanumSquareExtraBold',
  'NanumSquareAcR',
  'NanumSquareAcL',
  'NanumSquareAcB',
  'NanumSquareAcEB',
  'NanumSquareRound',
  'NanumSquareRoundL',
  'NanumSquareRoundB',
  'NanumSquareRoundEB',
])

const NAVER_CODING_FAMILIES = new Set([
  'NanumGothicCoding',
  'NanumGothicCodingBold',
  'NanumGothicCodingLigature',
  'NanumGothicCodingLigatureBold',
  'NanumCoDingHeuiMang',
])

const NAVER_HANDWRITING_FAMILIES = new Set([
  'NanumBarunpen',
  'NanumBarunpenB',
  'NanumPen',
  'NanumBrush',
])

function inferNaverFontWeight(family: string): number {
  const lower = family.toLowerCase()
  if (lower.includes('ultralight') || lower.includes('extralight') || lower.endsWith('light') || lower.endsWith('el')) return 300
  if (lower.includes('extrabold') || lower.includes('heavy') || lower.endsWith('eb')) return 800
  if (lower.includes('bold') || lower.endsWith('b')) return 700
  return 400
}

function inferNaverFontCategory(family: string): FontCategoryId {
  if (family.startsWith('MaruBuri')) return 'naverMaruBuri'
  if (NAVER_CODING_FAMILIES.has(family)) return 'naverCoding'
  if (NAVER_SQUARE_FAMILIES.has(family)) return 'naverSquare'
  if (NAVER_MYEONGJO_FAMILIES.has(family)) return 'naverMyeongjo'
  if (NAVER_GOTHIC_FAMILIES.has(family)) return 'naverGothic'
  if (NAVER_HANDWRITING_FAMILIES.has(family) || family.startsWith('Nanum')) return 'naverHandwriting'
  return 'naverOther'
}

const NAVER_FREE_FONT_PRESETS: readonly TextFontPreset[] = NAVER_FREE_FONT_FAMILIES.map((family) => ({
  id: `naver-${family}`,
  family,
  weight: inferNaverFontWeight(family),
  label: family,
  category: inferNaverFontCategory(family),
}))

const GOOGLE_FREE_FONT_FAMILIES = [
  'Arimo', 'Tinos', 'Cousine', 'Carlito', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
  'Manrope', 'Nunito Sans', 'Rubik', 'Work Sans', 'Fira Sans', 'PT Sans', 'Ubuntu', 'Merriweather', 'Source Serif 4', 'Source Sans 3',
  'Playfair Display', 'Inconsolata', 'JetBrains Mono', 'Noto Sans KR', 'Noto Serif KR', 'Noto Sans', 'Noto Serif', 'DM Sans', 'DM Serif Display', 'DM Serif Text',
  'Space Grotesk', 'Space Mono', 'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'Barlow', 'Barlow Condensed', 'Barlow Semi Condensed', 'Cabin', 'Karla',
  'Mulish', 'Heebo', 'Exo 2', 'Titillium Web', 'Hind', 'Hind Madurai', 'Hind Siliguri', 'Quicksand', 'Raleway', 'Oswald',
  'Bebas Neue', 'Anton', 'Fjalla One', 'Archivo', 'Archivo Narrow', 'Assistant', 'Lexend', 'Public Sans', 'Sora', 'Outfit',
  'Urbanist', 'Plus Jakarta Sans', 'Asap', 'Asap Condensed', 'Signika', 'Catamaran', 'Jost', 'Commissioner', 'Prompt', 'Kanit',
  'Teko', 'Rajdhani', 'Orbitron', 'Chakra Petch', 'Righteous', 'Alegreya Sans', 'Alegreya', 'PT Serif', 'Bitter', 'Lora',
  'Arvo', 'Zilla Slab', 'Bree Serif', 'Cormorant Garamond', 'EB Garamond', 'Libre Baskerville', 'Libre Franklin', 'Varela Round', 'M PLUS 1p', 'M PLUS Rounded 1c',
  'M PLUS Code Latin', 'Red Hat Display', 'Red Hat Text', 'Atkinson Hyperlegible', 'Overpass', 'Overpass Mono', 'Spline Sans', 'Saira', 'Saira Condensed', 'Saira Semi Condensed',
  'Mukta', 'Martel Sans', 'Nunito', 'Oxygen', 'Questrial', 'Cairo', 'Tajawal', 'Almarai', 'Noto Sans JP', 'Noto Serif JP',
  'Noto Sans SC', 'Noto Serif SC', 'Noto Sans TC', 'Noto Serif TC', 'Noto Sans HK', 'Noto Sans Devanagari', 'Noto Sans Thai', 'Noto Sans Arabic', 'Noto Kufi Arabic', 'Noto Sans Hebrew',
  'Noto Sans Bengali', 'Noto Sans Tamil', 'Noto Sans Telugu', 'Noto Sans Kannada', 'Noto Sans Malayalam', 'Noto Sans Georgian', 'Noto Sans Armenian', 'Noto Sans Lao', 'Noto Sans Myanmar', 'Noto Sans Ethiopic',
] as const

function familyToPresetToken(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

const BASIC_FREE_FONT_PRESETS: readonly TextFontPreset[] = GOOGLE_FREE_FONT_FAMILIES.flatMap((family) => {
  const token = familyToPresetToken(family)
  return [
    { id: `gf-${token}-regular`, family, weight: 400, label: family, category: 'googleFree' },
    { id: `gf-${token}-bold`, family, weight: 700, label: `${family} Bold`, category: 'googleFree' },
  ]
})

const GOOGLE_FONT_FAMILY_SET = new Set(GOOGLE_FREE_FONT_FAMILIES.map((family) => normalizeFontFamilyName(family)))
const loadedGoogleWebFonts = new Set<string>()

function ensureGoogleWebFontLoaded(family: string) {
  if (typeof document === 'undefined') return
  const normalized = normalizeFontFamilyName(family)
  if (!GOOGLE_FONT_FAMILY_SET.has(normalized)) return
  if (loadedGoogleWebFonts.has(normalized)) return

  const existing = document.querySelector<HTMLLinkElement>(`link[data-google-font-family="${normalized}"]`)
  if (existing) {
    loadedGoogleWebFonts.add(normalized)
    return
  }

  const encodedFamily = encodeURIComponent(family).replace(/%20/g, '+')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodedFamily}:wght@400;700&display=swap`
  link.setAttribute('data-google-font-family', normalized)
  document.head.appendChild(link)
  loadedGoogleWebFonts.add(normalized)
}

const TEXT_FONT_PRESETS: readonly TextFontPreset[] = [...NAVER_FREE_FONT_PRESETS, ...BASIC_FREE_FONT_PRESETS]

function normalizeFontFamilyName(value: string): string {
  return value.split(',')[0]?.replaceAll('"', '').replaceAll("'", '').trim().toLowerCase() ?? ''
}

function fontWeightBucket(weight: number): number {
  if (weight >= 750) return 800
  if (weight >= 550) return 700
  if (weight >= 350) return 400
  return 300
}

function resolveTextFontPreset(item: Pick<TextItem, 'fontFamily' | 'fontWeight'>): TextFontPresetId {
  const family = normalizeFontFamilyName(item.fontFamily)
  const targetWeight = fontWeightBucket(item.fontWeight)
  const familyPresets = TEXT_FONT_PRESETS.filter((preset) => normalizeFontFamilyName(preset.family) === family)
  if (familyPresets.length === 0) return TEXT_FONT_PRESETS[0]?.id ?? ''
  const exact = familyPresets.find((preset) => fontWeightBucket(preset.weight) === targetWeight)
  return (exact ?? familyPresets[0]).id
}

function resolveTextOutlineColor(item: TextItem): string {
  return item.outlineColor ?? '#ffffff'
}

function resolveTextBackgroundColor(item: TextItem): string {
  return item.backgroundColor ?? '#ffffff'
}

function resolveTextBackgroundOpacity(item: TextItem): number {
  const value = item.backgroundOpacity
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.2
  return clamp(value, 0, 1)
}

const LANGUAGE_OPTIONS: Array<{ code: Locale; label: string }> = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: 'English' },
]

const DEFAULT_GROUP: LayerGroup = {
  id: 'group-default',
  name: 'Default',
  collapsed: false,
}

const UI = {
  ko: {
    tag: '이미지/PDF 통합 편집',
    import: '불러오기',
    language: '언어',
    aiEngine: 'AI 엔진',
    aiRestoreEngine: 'AI 복원',
    aiReady: '준비됨',
    aiInit: '준비중',
    aiError: '오류',
    aiSetCpu: 'CPU',
    aiSetGpu: 'GPU',
    gpuUnavailable: 'CUDA를 사용할 수 없습니다',
    available: '사용가능',
    unavailable: '사용불가',
    brush: '브러시',
    aiRestore: 'AI 복원',
    aiEraser: 'AI 지우개',
    aiSelect: 'AI 선택',
    text: '텍스트',
    move: '이동',
    addText: '텍스트 추가',
    clearMask: '브러시 표시 지우기',
    clearTexts: '텍스트 전체 삭제',
    undoRestore: '복원 되돌리기',
    redoRestore: '복원 다시 실행',
    undoAction: '되돌리기',
    redoAction: '다시 실행',
    exportPng: 'PNG 내보내기',
    exportJpg: 'JPG 내보내기',
    exportWebp: 'WEBP 내보내기',
    exportPdf: 'PDF 내보내기',
    exportPptx: 'PPTX 내보내기',
    files: '파일',
    removeAsset: '목록에서 제거',
    selectForExport: '내보내기 선택',
    selectAllFiles: '전체 선택',
    unselectAllFiles: '선택 해제',
    invertSelection: '선택 반전',
    clearAllAssets: '모두 삭제',
    emptyFiles: '이미지/PDF 파일을 불러오거나 여기에 드래그하세요. PDF는 페이지 단위로 자동 분리됩니다.',
    assetMeta: (w: number, h: number, t: number) => `${w}×${h} · 텍스트 ${t}`,
    emptyCanvas: '이미지/PDF 통합 편집 도구',
    heroSubtitle: '이미지/PDF 통합 편집 도구',
    heroRepo: 'xiu-kr/vora',
    controls: '편집 옵션',
    tabLayers: '레이어',
    tabProperties: '속성',
    tabHistory: '히스토리',
    tools: '작업 도구',
    textTools: '텍스트 도구',
    textOptionsSimple: '간단',
    textOptionsAdvanced: '고급',
    toolOptions: '도구 옵션',
    textLayers: '텍스트 레이어',
    addTextLayer: '텍스트 넣기',
    textAddAtCursor: '여기에 텍스트 넣기',
    textInsertArmed: '텍스트 삽입 대기: 캔버스를 클릭하세요',
    canvasMenuToolRestore: 'AI 복원 도구',
    canvasMenuToolEraser: 'AI 지우개 도구',
    canvasMenuToolSelect: 'AI 선택 도구',
    canvasMenuToolText: '텍스트 도구',
    canvasMenuToolMove: '이동 도구',
    canvasMenuZoomReset: '배율 100%로 초기화',
    addGroup: '그룹 추가',
    groupName: '그룹',
    noTextLayers: '텍스트 레이어가 없습니다.',
    showLayer: '레이어 보이기/숨기기',
    lockLayer: '레이어 잠금/해제',
    moveLayerUp: '레이어 위로',
    moveLayerDown: '레이어 아래로',
    moveToGroup: '그룹 이동',
    layerBulkActions: '선택 레이어 작업',
    layerAlignLeft: '좌측 정렬',
    layerAlignCenter: '가로 중앙',
    layerAlignRight: '우측 정렬',
    layerAlignTop: '상단 정렬',
    layerAlignMiddle: '세로 중앙',
    layerAlignBottom: '하단 정렬',
    layerLockSelected: '선택 잠금',
    layerUnlockSelected: '선택 잠금 해제',
    layerDuplicateSelected: '선택 복제',
    layerHidden: '숨김',
    layerLocked: '잠금',
    historyPanel: '히스토리',
    historySearchPlaceholder: '히스토리 검색',
    historyAddCheckpoint: '체크포인트 저장',
    noHistory: '히스토리 항목이 없습니다.',
    historyCurrent: '현재 상태',
    historyAddText: '텍스트 레이어 추가',
    historyUpdateText: '텍스트 수정',
    historyEditInline: '텍스트 인라인 편집',
    historyDeleteText: '텍스트 레이어 삭제',
    historyMoveText: '텍스트 이동',
    historyTransformText: '텍스트 변형',
    historyClearTexts: '텍스트 전체 삭제',
    historyToggleVisible: '레이어 표시/숨김',
    historyToggleLock: '레이어 잠금/해제',
    historyMoveLayer: '레이어 순서 이동',
    historyCrop: '잘라내기',
    historyAiRestore: 'AI 복원',
    historyAiEraser: 'AI 지우개',
    historyRemoveAsset: '파일 제거',
    historyReorderAssets: '파일 순서 변경',
    historyClearAssets: '파일 전체 삭제',
    historyJumpCheckpoint: '히스토리 이동 기준점',
    historyUndoCheckpoint: '되돌리기 기준점',
    historyRedoCheckpoint: '다시 실행 기준점',
    historyManualCheckpoint: '수동 체크포인트',
    deleteHistory: '히스토리 삭제',
    fontWeightLabel: '굵기',
    fontWeightRegular: '기본',
    fontWeightBold: '굵게',
    fontPresetLabel: '글꼴 프리셋',
    fontSearchPlaceholder: '글꼴 검색 (이름/카테고리)',
    fontPresetGothic: '고딕체',
    fontPresetGothicBold: '굵은 고딕체',
    fontPresetMyeongjo: '명조체',
    fontPresetMyeongjoBold: '굵은 명조체',
    italicLabel: '기울임',
    opacity: '불투명도',
    restoreHint: '브러시로 칠하고 마우스를 떼면 즉시 AI 복원이 실행됩니다.',
    eraserHint: '브러시로 칠하면 주변 색을 즉시 채워 지웁니다.',
    selectionToolHint: '대상을 클릭하면 SAM으로 자동 분할 선택합니다.',
    selectionToolHintHasSelection: '클릭하여 영역 추가, Alt+클릭으로 영역 빼기',
    selectionMaskEmpty: '선택 마스크가 없습니다',
    selectionRunning: 'AI 선택 실행 중…',
    selectionDone: '선택 마스크 생성 완료',
    selectionFillColor: '배경 채우기 색상',
    selectionPickBackgroundImage: '배경 이미지 선택',
    selectionBackgroundImageReady: '배경 이미지 준비됨',
    selectionActionErase: '선택 삭제',
    selectionActionTransparentBg: '투명 배경 만들기',
    selectionActionFillBg: '단색 배경 채우기',
    selectionActionReplaceBg: '이미지 배경 교체',
    selectionActionRestore: 'AI 복원 실행',
    selectionActionClear: '선택 초기화',
    selectionModify: '선택 영역 수정',
    selectionInvert: '반전',
    selectionExpand: '확장',
    selectionContract: '축소',
    selectionFeather: '페더',
    autoBgRemove: '배경 자동 제거',
    imageTransform: '이미지 변환',
    flipH: '좌우 반전',
    flipV: '상하 반전',
    imageResize: '이미지 크기 조정',
    lockAspect: '비율 고정',
    applyResize: '적용',
    resizing: '크기 조정 중…',
    selectModeAI: 'AI 선택',
    selectModeRect: '사각형',
    selectModeEllipse: '타원',
    selectModeLasso: '올가미',
    shortcutZoomIn: '줌 인 (+)',
    shortcutZoomOut: '줌 아웃 (-)',
    shortcutZoomReset: '줌 초기화 (Ctrl+0)',
    shortcutFitSelection: '선택 영역 맞춤 (F)',
    toggleGrid: '그리드 토글 (G)',
    aiPreviewTitle: 'AI 실행 미리보기',
    aiPreviewConfirm: '선택 영역에 실행할까요?',
    aiPreviewArea: '대상 영역',
    aiPreviewScope: '적용 범위',
    aiPreviewScopeFull: '마스크 전체',
    aiPreviewScopeCrop: '자르기 영역과 교집합',
    aiPreviewNoCrop: '자르기 영역이 없어 전체 범위를 사용합니다.',
    aiPreviewMaskOpacity: '마스크 표시 강도',
    aiPreviewApply: '실행',
    aiPreviewCancel: '취소',
    brushSize: '브러시 크기',
    exportQuality: '내보내기 품질',
    exportQualityHint: '값이 높을수록 선명하지만 CPU/메모리 사용량이 증가합니다.',
    exportDialogTitle: '내보내기 설정',
    exportDialogDesc: '형식과 품질을 선택하세요.',
    exportFormat: '형식',
    exportFormatHintPng: 'PNG · 무손실 · 용량 큼',
    exportFormatHintJpg: 'JPG · 작은 용량 · 투명 배경 미지원',
    exportFormatHintWebp: 'WEBP · 고효율 압축 · 최신 브라우저 권장',
    exportFormatHintPdf: 'PDF · 문서 전달용 · 다중 페이지',
    exportFormatHintPptx: 'PPTX · 슬라이드 편집용 · 텍스트 보존',
    exportImageQuality: '이미지 품질',
    exportScope: '저장 범위',
    exportScopeCurrent: '현재 파일',
    exportScopeSelected: '선택한 파일',
    exportScopeAll: '전체 파일',
    exportNoSelected: '선택한 파일이 없습니다',
    exportNow: '내보내기(저장하기)',
    exportResetRecent: '최근값 초기화',
    exportPresetWeb: '웹 공유',
    exportPresetPrint: '고해상도',
    exportPresetSlides: '슬라이드',
    exportPresetWebHint: '예상 용량: 작음',
    exportPresetPrintHint: '예상 용량: 큼',
    exportPresetSlidesHint: '예상 용량: 중간',
    exportPresetSpeedFast: '처리: 빠름',
    exportPresetSpeedBalanced: '처리: 보통',
    exportPresetSpeedSlow: '처리: 느림',
    cancel: '취소',
    selectedText: '선택한 텍스트',
    noSelectedText: '텍스트를 선택하면 상세 설정이 표시됩니다.',
    modeRestore: '모드: AI 복원',
    modeEraser: '모드: AI 지우개',
    modeSelect: '모드: AI 선택',
    modeText: '모드: 텍스트 입력',
    modeCrop: '모드: 잘라내기',
    modeMove: '모드: 이동',
    textSelectMode: '텍스트 선택',
    crop: '잘라내기',
    zoomIn: '확대',
    zoomOut: '축소',
    zoomReset: '배율 초기화',
    zoomSlider: '확대/축소 스크롤',
    zoomHintCtrlWheel: '캔버스 위에서 Ctrl/Shift/Alt + 휠로 확대/축소',
    minimap: '미니맵',
    cropSelection: '잘라내기 영역',
    cropX: 'X',
    cropY: 'Y',
    cropWidth: '너비',
    cropHeight: '높이',
    applyCrop: '잘라내기 적용',
    previewCrop: '잘라내기 미리보기',
    cropPreviewTitle: '잘라내기 미리보기',
    cropPreviewHint: '미리보기는 저장되지 않습니다.',
    cropPreviewSize: '크기',
    cropPreviewArea: '면적',
    cropCompareBefore: '원본',
    cropCompareAfter: '잘라낸 결과',
    cropCompareFocusLeft: '왼쪽 보기',
    cropCompareFocusCenter: '중앙 보기',
    cropCompareFocusRight: '오른쪽 보기',
    cropCompareReset: '비교 초기화',
    cropComparePercent: '비교 비율',
    cropCompareControlHint: '비교 프레임에서 드래그/휠/방향키/Home/End 사용',
    cropCompareDoubleClickHint: '더블클릭으로 55%로 초기화',
    cropPreset: '비율 프리셋',
    cropPresetFull: '전체',
    cropPresetFree: '자유',
    cropPresetSquare: '1:1',
    cropPresetFourThree: '4:3',
    cropPresetSixteenNine: '16:9',
    cropNudgeMove: '미세 이동',
    cropNudgeResize: '미세 크기',
    cropMoveLeft: '왼쪽 이동',
    cropMoveRight: '오른쪽 이동',
    cropMoveUp: '위로 이동',
    cropMoveDown: '아래로 이동',
    cropShrinkWidth: '너비 줄이기',
    cropGrowWidth: '너비 늘리기',
    cropShrinkHeight: '높이 줄이기',
    cropGrowHeight: '높이 늘리기',
    cancelCrop: '영역 취소',
    cropHint: '드래그 또는 수치 입력 · Enter 적용 · P 미리보기 · 0 전체영역 · Esc 취소 · 방향키 이동(Shift 가속) · Alt+방향키 크기 조절 · [/] 비교 이동 · 1/2/3/R 비교 프리셋 · Home/End 극단 이동',
    cropDone: '잘라내기를 적용했습니다',
    macroCount: '반복 횟수',
    macroRunAll: '전체 파일 적용',
    macroRunSelected: '선택 파일 적용',
    macroHint: '최근 브러시 영역을 같은 위치에 반복 적용합니다.',
    macroSelectHint: 'Shift+클릭으로 여러 파일을 선택할 수 있습니다.',
    macroNoStrokeRestore: '반복할 AI 복원 브러시 기록이 없습니다',
    macroNoStrokeEraser: '반복할 AI 지우개 브러시 기록이 없습니다',
    macroNoSelectedFiles: '선택된 파일이 없습니다',
    font: '글꼴',
    size: '크기',
    color: '색상',
    textColor: '글자 색상',
    textBorderColor: '테두리 색상',
    textBackgroundColor: '배경 색상',
    textBackgroundOpacity: '배경 투명도',
    rotation: '회전',
    align: '정렬',
    alignLeft: '왼쪽',
    alignCenter: '가운데',
    alignRight: '오른쪽',
    deleteText: '텍스트 삭제',
    selectTextHint: '텍스트를 만들려면 캔버스를 더블클릭하거나 좌측 텍스트 넣기를 누르세요. 텍스트 선택 후 드래그/방향키로 이동할 수 있습니다.',
    ready: '준비됨',
    importing: '가져오는 중…',
    importingStatus: '파일을 가져오는 중입니다',
    imported: (n: number) => `${n}개 페이지를 불러왔습니다`,
    maskEmpty: '브러시 표시가 없습니다',
    inpainting: 'AI 복원 실행 중…',
    done: '완료',
    exporting: '내보내는 중…',
    exportedPng: 'PNG로 내보냈습니다',
    exportedFile: (name: string) => `저장 완료: ${name}`,
    exportedBatch: (success: number, fail: number) => `내보내기 완료 (성공 ${success}, 실패 ${fail})`,
    exportingPdf: 'PDF 내보내는 중…',
    noPages: '내보낼 페이지가 없습니다',
    exportedPdf: 'PDF로 내보냈습니다',
    dropHint: '이미지/PDF 파일을 놓으면 바로 불러옵니다',
    reorderHint: '파일 카드를 드래그해서 순서를 바꿀 수 있습니다.',
    selectionHint: '파일 클릭: 편집 전환 · Shift+클릭 범위선택 · Ctrl/Cmd+클릭 토글선택',
    selectedFilesCount: (count: number) => `선택 ${count}개`,
    selectionCleared: '선택된 파일을 해제했습니다',
    guideTitle: '빠른 시작 가이드',
    guideStepImport: '왼쪽 파일 패널에서 이미지를 불러오거나 드래그하세요.',
    guideStepTool: '왼쪽 도구에서 AI 복원/AI 지우개/텍스트/잘라내기/이동을 선택하세요.',
    guideStepRun: '브러시로 칠하고 마우스를 떼면 즉시 AI 복원이 실행됩니다.',
    guideStepExport: '히스토리 패널 아래의 내보내기(저장하기)로 결과를 저장하세요.',
    guideMetaImport: '파일 패널 · 드래그 앤 드롭',
    guideMetaTool: '단축키: B / E / T / C / M',
    guideMetaRun: '드래그 후 마우스를 놓아 실행',
    guideMetaExport: '히스토리 패널 하단 버튼',
    guideClose: '가이드 닫기',
    guideShow: '가이드 보기',
    settings: '설정',
    settingsTitle: '설정',
    settingsClose: '닫기',
    settingsGuide: '가이드 표시',
    settingsLanguage: '언어',
    settingsAiDefault: 'AI 엔진 기본값',
    settingsAiRestoreDefault: 'AI 복원 엔진 기본값',
    settingsBrushDefault: '기본 브러시 크기',
    settingsAutoSave: '자동 저장 주기(초)',
    settingsActivityLogLimit: '작업 로그 표시 개수',
    settingsCropHideDocks: '잘라내기 중 하단 도크 숨김',
    settingsResetDefaults: '기본값으로 초기화',
    settingsResetConfirm: '설정을 기본값으로 초기화할까요?',
    settingsResetDone: '설정을 기본값으로 초기화했습니다',
    settingsResetGeneral: '일반 초기화',
    settingsResetEditing: '편집 초기화',
    settingsResetExport: '내보내기 초기화',
    settingsShortcutTips: '단축키 툴팁 표시',
    settingsTextClickEditMode: '텍스트 클릭 편집 방식',
    settingsTextClickEditSingle: '한 번 클릭 시 바로 편집',
    settingsTextClickEditDouble: '한 번 클릭 선택, 두 번 클릭 편집',
    settingsZoomWheelSensitivity: '휠 확대 감도',
    settingsTextSnapStrength: '텍스트 스냅 강도',
    settingsTextSnapOff: '끄기',
    settingsTextSnapSoft: '약함',
    settingsTextSnapNormal: '기본',
    settingsTextSnapStrong: '강함',
    settingsTooltipDensity: '툴팁 밀도',
    settingsTooltipSimple: '간단',
    settingsTooltipDetailed: '상세',
    settingsAnimationStrength: '애니메이션 강도',
    settingsAnimationLow: '낮음',
    settingsAnimationDefault: '기본',
    settingsAnimationHigh: '강함',
    settingsUiDensity: 'UI 밀도',
    settingsDensityDefault: '기본',
    settingsDensityCompact: '컴팩트',
    settingsAutoSaveOff: '사용 안함',
    settingsTabGeneral: '일반',
    settingsTabEditing: '편집',
    settingsTabInfo: '정보',
    settingsExportDefaults: '내보내기 기본 설정',
    settingsExportDefaultPreset: '기본 프리셋',
    settingsExportDefaultCustom: '현재값 유지',
    settingsExportDefaultApply: '기본값 적용',
    settingsExportDefaultDone: '내보내기 기본 설정을 적용했습니다',
    settingsMobileQuickActions: '모바일 퀵 액션 바',
    settingsMobileQuickOrder: '퀵 액션 순서',
    settingsMobileActionExport: '내보내기',
    settingsMobileActionActivity: '로그',
    settingsMobileActionShortcuts: '단축키',
    settingsMobileActionSettings: '설정',
    settingsMoveUp: '위로',
    settingsMoveDown: '아래로',
    settingsLastAutoSave: '마지막 자동 저장',
    settingsNoAutoSave: '자동 저장 꺼짐',
    activityLog: '작업 로그',
    activityShow: '로그 보기',
    activityHide: '로그 닫기',
    activityCopy: '로그 복사',
    activityCopyItem: '항목 복사',
    activityJumpItem: '이 파일로 이동',
    activityPreviewOpen: '시점 미리보기',
    activityPreviewUnavailable: '이 로그는 미리보기를 지원하지 않습니다',
    activityPreviewTitle: '작업 시점 미리보기',
    activityPreviewClose: '닫기',
    activityPreviewCompare: '비교 슬라이더',
    activityPreviewBefore: '스냅샷',
    activityPreviewAfter: '현재',
    activityApplySnapshot: '스냅샷 적용',
    activityApplyCurrent: '현재 상태 복원',
    activityDownload: '로그 저장',
    activityDownloadFiltered: '필터만 저장',
    activityDownloadAll: '전체 저장',
    activityClear: '로그 비우기',
    activityCopied: '작업 로그를 복사했습니다',
    activityDownloaded: (name: string) => `로그 저장 완료: ${name}`,
    activityCleared: '작업 로그를 비웠습니다',
    activityEmpty: '아직 작업 로그가 없습니다.',
    activityFilterAll: '전체',
    activityFilterError: '오류',
    activityFilterSuccess: '완료',
    activityFilterWorking: '진행',
    activitySortLatest: '최신순',
    activitySortOldest: '오래된순',
    activityLegendError: '오류',
    activityLegendSuccess: '완료',
    activityLegendWorking: '진행',
    activityKindAi: 'AI',
    activityKindExport: '내보내기',
    activityKindText: '텍스트',
    activityKindSystem: '시스템',
    activitySummary: (target: number, success: number, fail: number) => `대상 ${target} · 성공 ${success} · 실패 ${fail}`,
    quickBarMove: '퀵바 이동',
    quickBarToggle: '퀵바 접기/펼치기',
    cancelTask: '작업 취소',
    taskCancelled: '작업을 취소했습니다',
    settingsInfo: '개발자 정보',
    settingsVersion: '버전',
    settingsDockerHub: 'Docker Hub',
    settingsGitHub: 'GitHub',
    settingsDocs: '개발자',
    settingsCopyDockerHub: '링크 복사',
    settingsCopiedDockerHub: 'Docker Hub 링크를 복사했습니다',
    settingsDeveloper: '개발자',
    settingsRepo: '저장소',
    externalOpened: (label: string) => `${label}를 새 탭에서 열었습니다`,
    settingsCopyDiagnostics: '환경 진단 복사',
    settingsCopiedDiagnostics: '환경 진단을 복사했습니다',
    unsavedWarn: '저장되지 않은 변경사항이 있습니다.',
    unsavedBadge: '미저장 변경',
    unsavedBadgeCount: (count: number) => `미저장 변경 (${count})`,
    unsavedUpdatedAt: (time: string) => `마지막 변경: ${time}`,
    unsavedRecentChanges: '최근 변경',
    errCanvasUnavailable: '캔버스를 사용할 수 없습니다.',
    errPngConvertFailed: 'PNG로 변환하지 못했습니다.',
    errImageLoadFailed: '이미지를 불러오지 못했습니다.',
    errDataUrlConvertFailed: '데이터 URL로 변환하지 못했습니다.',
    errImportReadFile: '파일을 읽지 못했습니다.',
    errCanvasInitFailed: '캔버스를 초기화하지 못했습니다.',
    errInpaintHttp: (status: string, detail: string) => `AI 지우기에 실패했습니다 (${status}). ${detail}`,
    errInpaintNonImage: (snippet: string) => `AI 복원 API 응답이 이미지가 아닙니다. (/api 경로/프록시 확인) ${snippet}`,
    errApiBadJson: 'AI API 응답 형식 오류 (/api 경로/프록시 확인)',
    errApiBadJsonWithSnippet: (snippet: string) => `AI API 응답 형식이 올바르지 않습니다. (/api 경로/프록시 확인) ${snippet}`,
    errApiActionHint: '백엔드 컨테이너와 /api 프록시 연결 상태를 확인하세요.',
    aiRuntimeDetail: (runtime: string, requested: string, selectedCount: number) => `실행: ${runtime} · 요청: ${requested} · 선택: ${selectedCount}개`,
    shortcutsHelp: '단축키 도움말',
    shortcutsToggleHint: '? 키로 열기/닫기',
    shortcutsCategoryAll: '전체',
    shortcutsCategoryTools: '도구',
    shortcutsCategorySelection: '선택',
    shortcutsCategoryHistory: '히스토리',
    shortcutsSearchPlaceholder: '단축키 검색',
    shortcutsNoMatch: '검색 결과가 없습니다.',
    shortcutCopied: (keyLabel: string) => `단축키 복사: ${keyLabel}`,
    shortcutsClose: '닫기',
    shortcutsList: 'B 복원 · E 지우개 · T 텍스트 · N 텍스트삽입 대기 · C 자르기 · M 이동 · Ctrl/Shift/Alt+휠 확대/축소 · Space+드래그/휠클릭드래그 팬 · Ctrl/Cmd+Z 되돌리기 · Shift+Ctrl/Cmd+Z 다시실행 · Shift+클릭 다중선택 · Ctrl/Cmd+D 선택 텍스트 복제 · Enter(텍스트/이동 모드) 편집 진입 · I 선택 반전 · Alt+L 로그 비우기 · 방향키(텍스트/이동 모드) 텍스트 이동 · Alt+방향키(자르기 모드) 영역 크기조절 · Enter 자르기 적용 · P 자르기 미리보기 · 0 전체영역 · [/] 비교 이동 · 1/2/3/R 비교 프리셋 · Home/End 극단 이동 · Esc 선택/자르기 해제',
    topVersionTag: (version: string, track: string) => `v${version} · ${track}`,
    macroConfirmAll: (count: number) => `전체 파일 ${count}개에 적용할까요?`,
    macroConfirmSelected: (count: number) => `선택 파일 ${count}개에 적용할까요?`,
    macroRunningAll: '전체 파일 적용 중…',
    macroRunningSelected: '선택 파일 적용 중…',
    restorePromptTitle: '자동 저장된 작업을 찾았습니다',
    restorePromptBody: '이전 편집 상태를 복원할까요?',
    restorePromptRestore: '복원하기',
    restorePromptDiscard: '건너뛰기',
    settingsName: 'XIU-kr',
  },
  en: {
    tag: 'Image/PDF editor',
    import: 'Import',
    language: 'Language',
    aiEngine: 'AI Engine',
    aiRestoreEngine: 'AI Restore',
    aiReady: 'Ready',
    aiInit: 'Starting',
    aiError: 'Error',
    aiSetCpu: 'CPU',
    aiSetGpu: 'GPU',
    gpuUnavailable: 'CUDA is unavailable',
    available: 'Available',
    unavailable: 'Unavailable',
    brush: 'Brush',
    aiRestore: 'AI Restore',
    aiEraser: 'AI Eraser',
    aiSelect: 'AI Select',
    text: 'Text',
    move: 'Move',
    addText: 'Add text',
    clearMask: 'Clear brush trace',
    clearTexts: 'Clear texts',
    undoRestore: 'Undo restore',
    redoRestore: 'Redo restore',
    undoAction: 'Undo',
    redoAction: 'Redo',
    exportPng: 'Export PNG',
    exportJpg: 'Export JPG',
    exportWebp: 'Export WEBP',
    exportPdf: 'Export PDF',
    exportPptx: 'Export PPTX',
    files: 'Files',
    removeAsset: 'Remove from list',
    selectForExport: 'Select for export',
    selectAllFiles: 'Select all',
    unselectAllFiles: 'Unselect all',
    invertSelection: 'Invert selection',
    clearAllAssets: 'Clear all',
    emptyFiles: 'Import images/PDF or drag files here. PDF pages are automatically split.',
    assetMeta: (w: number, h: number, t: number) => `${w}×${h} · text ${t}`,
    emptyCanvas: 'Image/PDF integrated editing tool',
    heroSubtitle: 'Image/PDF integrated editing tool',
    heroRepo: 'xiu-kr/vora',
    controls: 'Controls',
    tabLayers: 'Layers',
    tabProperties: 'Properties',
    tabHistory: 'History',
    tools: 'Work tools',
    textTools: 'Text tools',
    textOptionsSimple: 'Simple',
    textOptionsAdvanced: 'Advanced',
    toolOptions: 'Tool options',
    textLayers: 'Text layers',
    addTextLayer: 'Insert text',
    textAddAtCursor: 'Insert text here',
    textInsertArmed: 'Text insert armed: click canvas',
    canvasMenuToolRestore: 'Use AI Restore tool',
    canvasMenuToolEraser: 'Use AI Eraser tool',
    canvasMenuToolSelect: 'Use AI Select tool',
    canvasMenuToolText: 'Use Text tool',
    canvasMenuToolMove: 'Use Move tool',
    canvasMenuZoomReset: 'Reset zoom to 100%',
    addGroup: 'Add group',
    groupName: 'Group',
    noTextLayers: 'No text layers',
    showLayer: 'Show or hide layer',
    lockLayer: 'Lock or unlock layer',
    moveLayerUp: 'Move layer up',
    moveLayerDown: 'Move layer down',
    moveToGroup: 'Move to group',
    layerBulkActions: 'Selected layer actions',
    layerAlignLeft: 'Align left',
    layerAlignCenter: 'Align center',
    layerAlignRight: 'Align right',
    layerAlignTop: 'Align top',
    layerAlignMiddle: 'Align middle',
    layerAlignBottom: 'Align bottom',
    layerLockSelected: 'Lock selected',
    layerUnlockSelected: 'Unlock selected',
    layerDuplicateSelected: 'Duplicate selected',
    layerHidden: 'Hidden',
    layerLocked: 'Locked',
    historyPanel: 'History',
    historySearchPlaceholder: 'Search history',
    historyAddCheckpoint: 'Save checkpoint',
    noHistory: 'No history entries.',
    historyCurrent: 'Current',
    historyAddText: 'Add text layer',
    historyUpdateText: 'Update text',
    historyEditInline: 'Edit text inline',
    historyDeleteText: 'Delete text layer',
    historyMoveText: 'Move text layer',
    historyTransformText: 'Transform text layer',
    historyClearTexts: 'Clear texts',
    historyToggleVisible: 'Toggle layer visibility',
    historyToggleLock: 'Toggle layer lock',
    historyMoveLayer: 'Move layer',
    historyCrop: 'Crop asset',
    historyAiRestore: 'AI restore',
    historyAiEraser: 'AI eraser',
    historyRemoveAsset: 'Remove asset',
    historyReorderAssets: 'Reorder assets',
    historyClearAssets: 'Clear all assets',
    historyJumpCheckpoint: 'Jump checkpoint',
    historyUndoCheckpoint: 'Undo checkpoint',
    historyRedoCheckpoint: 'Redo checkpoint',
    historyManualCheckpoint: 'Manual checkpoint',
    deleteHistory: 'Delete history',
    fontWeightLabel: 'Weight',
    fontWeightRegular: 'Regular',
    fontWeightBold: 'Bold',
    fontPresetLabel: 'Font preset',
    fontSearchPlaceholder: 'Search fonts (name/category)',
    fontPresetGothic: 'Gothic',
    fontPresetGothicBold: 'Gothic Bold',
    fontPresetMyeongjo: 'Myeongjo',
    fontPresetMyeongjoBold: 'Myeongjo Bold',
    italicLabel: 'Italic',
    opacity: 'Opacity',
    restoreHint: 'Paint with brush and release mouse to run AI restore automatically.',
    eraserHint: 'Paint with brush to instantly fill using nearby colors.',
    selectionToolHint: 'Click a subject to create a SAM selection mask.',
    selectionToolHintHasSelection: 'Click to add · Alt+click to subtract',
    selectionMaskEmpty: 'No selection mask',
    selectionRunning: 'Running AI selection…',
    selectionDone: 'Selection mask created',
    selectionFillColor: 'Background fill color',
    selectionPickBackgroundImage: 'Choose background image',
    selectionBackgroundImageReady: 'Background image ready',
    selectionActionErase: 'Delete selection',
    selectionActionTransparentBg: 'Make transparent background',
    selectionActionFillBg: 'Fill solid background',
    selectionActionReplaceBg: 'Replace with image background',
    selectionActionRestore: 'Run AI restore',
    selectionActionClear: 'Clear selection',
    selectionModify: 'Modify Selection',
    selectionInvert: 'Invert',
    selectionExpand: 'Expand',
    selectionContract: 'Contract',
    selectionFeather: 'Feather',
    autoBgRemove: 'Auto Remove BG',
    imageTransform: 'Image Transform',
    flipH: 'Flip H',
    flipV: 'Flip V',
    imageResize: 'Image Resize',
    lockAspect: 'Lock aspect ratio',
    applyResize: 'Apply Resize',
    resizing: 'Resizing…',
    selectModeAI: 'AI Select',
    selectModeRect: 'Rectangle',
    selectModeEllipse: 'Ellipse',
    selectModeLasso: 'Lasso',
    shortcutZoomIn: 'Zoom in (+)',
    shortcutZoomOut: 'Zoom out (-)',
    shortcutZoomReset: 'Reset zoom (Ctrl+0)',
    shortcutFitSelection: 'Fit to selection (F)',
    toggleGrid: 'Toggle grid (G)',
    aiPreviewTitle: 'AI action preview',
    aiPreviewConfirm: 'Run on selected area?',
    aiPreviewArea: 'Target area',
    aiPreviewScope: 'Apply scope',
    aiPreviewScopeFull: 'Full mask',
    aiPreviewScopeCrop: 'Intersect with crop area',
    aiPreviewNoCrop: 'No crop area. Full mask scope will be used.',
    aiPreviewMaskOpacity: 'Mask visibility',
    aiPreviewApply: 'Run',
    aiPreviewCancel: 'Cancel',
    brushSize: 'Brush size',
    exportQuality: 'Export quality',
    exportQualityHint: 'Higher = sharper exports, more CPU/memory.',
    exportDialogTitle: 'Export settings',
    exportDialogDesc: 'Choose format and quality.',
    exportFormat: 'Format',
    exportFormatHintPng: 'PNG · lossless · larger size',
    exportFormatHintJpg: 'JPG · smaller size · no transparency',
    exportFormatHintWebp: 'WEBP · high efficiency · modern browsers',
    exportFormatHintPdf: 'PDF · share-ready document · multipage',
    exportFormatHintPptx: 'PPTX · slide editing · keeps text layers',
    exportImageQuality: 'Image quality',
    exportScope: 'Save scope',
    exportScopeCurrent: 'Current file',
    exportScopeSelected: 'Selected files',
    exportScopeAll: 'All files',
    exportNoSelected: 'No selected files',
    exportNow: 'Export (Save)',
    exportResetRecent: 'Reset recent values',
    exportPresetWeb: 'Web share',
    exportPresetPrint: 'High quality',
    exportPresetSlides: 'Slides',
    exportPresetWebHint: 'Estimated size: small',
    exportPresetPrintHint: 'Estimated size: large',
    exportPresetSlidesHint: 'Estimated size: medium',
    exportPresetSpeedFast: 'Processing: fast',
    exportPresetSpeedBalanced: 'Processing: balanced',
    exportPresetSpeedSlow: 'Processing: slow',
    cancel: 'Cancel',
    selectedText: 'Selected text',
    noSelectedText: 'Select text to see detailed controls.',
    modeRestore: 'Mode: AI Restore',
    modeEraser: 'Mode: AI Eraser',
    modeSelect: 'Mode: AI Select',
    modeText: 'Mode: Text Insert',
    modeCrop: 'Mode: Crop',
    modeMove: 'Mode: Move',
    textSelectMode: 'Text select',
    crop: 'Crop',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Reset zoom',
    zoomSlider: 'Zoom slider',
    zoomHintCtrlWheel: 'Use Ctrl/Shift/Alt + wheel over canvas to zoom',
    minimap: 'Minimap',
    cropSelection: 'Crop area',
    cropX: 'X',
    cropY: 'Y',
    cropWidth: 'Width',
    cropHeight: 'Height',
    applyCrop: 'Apply crop',
    previewCrop: 'Preview crop',
    cropPreviewTitle: 'Crop preview',
    cropPreviewHint: 'Preview is not saved until apply.',
    cropPreviewSize: 'Size',
    cropPreviewArea: 'Area',
    cropCompareBefore: 'Before',
    cropCompareAfter: 'After crop',
    cropCompareFocusLeft: 'Focus left',
    cropCompareFocusCenter: 'Focus center',
    cropCompareFocusRight: 'Focus right',
    cropCompareReset: 'Reset compare',
    cropComparePercent: 'Compare ratio',
    cropCompareControlHint: 'Use drag/wheel/arrow/Home/End on compare frame',
    cropCompareDoubleClickHint: 'Double click resets to 55%',
    cropPreset: 'Ratio preset',
    cropPresetFull: 'Full',
    cropPresetFree: 'Free',
    cropPresetSquare: '1:1',
    cropPresetFourThree: '4:3',
    cropPresetSixteenNine: '16:9',
    cropNudgeMove: 'Nudge move',
    cropNudgeResize: 'Nudge size',
    cropMoveLeft: 'Move left',
    cropMoveRight: 'Move right',
    cropMoveUp: 'Move up',
    cropMoveDown: 'Move down',
    cropShrinkWidth: 'Shrink width',
    cropGrowWidth: 'Grow width',
    cropShrinkHeight: 'Shrink height',
    cropGrowHeight: 'Grow height',
    cancelCrop: 'Clear area',
    cropHint: 'Drag or type values · Enter apply · P preview · 0 full frame · Esc clear · Arrows move (Shift faster) · Alt+arrows resize · [/] compare shift · 1/2/3/R compare presets · Home/End to extremes',
    cropDone: 'Crop applied',
    macroCount: 'Repeat count',
    macroRunAll: 'Apply to all files',
    macroRunSelected: 'Apply to selected files',
    macroHint: 'Repeat the latest brush region at the same position.',
    macroSelectHint: 'Use Shift+click to select multiple files.',
    macroNoStrokeRestore: 'No recent AI restore brush region to repeat',
    macroNoStrokeEraser: 'No recent AI eraser brush region to repeat',
    macroNoSelectedFiles: 'No selected files',
    font: 'Font',
    size: 'Size',
    color: 'Color',
    textColor: 'Text color',
    textBorderColor: 'Border color',
    textBackgroundColor: 'Background color',
    textBackgroundOpacity: 'Background opacity',
    rotation: 'Rotation',
    align: 'Align',
    alignLeft: 'Left',
    alignCenter: 'Center',
    alignRight: 'Right',
    deleteText: 'Delete text',
    selectTextHint: 'Create text by double-clicking canvas or using Insert text. Then drag or use arrow keys to reposition.',
    ready: 'Ready',
    importing: 'Importing…',
    importingStatus: 'Importing files',
    imported: (n: number) => `Imported ${n} page(s)`,
    maskEmpty: 'No brush trace',
    inpainting: 'Running AI restore…',
    done: 'Done',
    exporting: 'Exporting…',
    exportedPng: 'Exported PNG',
    exportedFile: (name: string) => `Saved: ${name}`,
    exportedBatch: (success: number, fail: number) => `Export finished (success ${success}, failed ${fail})`,
    exportingPdf: 'Exporting PDF…',
    noPages: 'No pages to export',
    exportedPdf: 'Exported PDF',
    dropHint: 'Drop image/PDF files to import instantly',
    reorderHint: 'Drag file cards to reorder pages.',
    selectionHint: 'Click file: edit target · Shift+click range select · Ctrl/Cmd+click toggle',
    selectedFilesCount: (count: number) => `${count} selected`,
    selectionCleared: 'Cleared selected files',
    guideTitle: 'Quick Start Guide',
    guideStepImport: 'Import files from the left panel or drag and drop.',
    guideStepTool: 'Pick AI Restore / AI Eraser / Text / Crop / Move from the left tool dock.',
    guideStepRun: 'Paint with brush and release to run AI restore instantly.',
    guideStepExport: 'Save results with Export (Save) under the history panel.',
    guideMetaImport: 'Files panel · drag and drop',
    guideMetaTool: 'Shortcut: B / E / T / C / M',
    guideMetaRun: 'Drag brush and release to run',
    guideMetaExport: 'Bottom of history panel',
    guideClose: 'Close guide',
    guideShow: 'Show guide',
    settings: 'Settings',
    settingsTitle: 'Settings',
    settingsClose: 'Close',
    settingsGuide: 'Show guide',
    settingsLanguage: 'Language',
    settingsAiDefault: 'Default AI engine',
    settingsAiRestoreDefault: 'Default AI Restore engine',
    settingsBrushDefault: 'Default brush size',
    settingsAutoSave: 'Autosave interval (sec)',
    settingsActivityLogLimit: 'Activity log item count',
    settingsCropHideDocks: 'Hide bottom docks while cropping',
    settingsResetDefaults: 'Reset to defaults',
    settingsResetConfirm: 'Reset settings to defaults?',
    settingsResetDone: 'Settings reset to defaults',
    settingsResetGeneral: 'Reset general',
    settingsResetEditing: 'Reset editing',
    settingsResetExport: 'Reset export',
    settingsShortcutTips: 'Show shortcut tooltips',
    settingsTextClickEditMode: 'Text click edit mode',
    settingsTextClickEditSingle: 'Single click edits immediately',
    settingsTextClickEditDouble: 'Single click selects, double click edits',
    settingsZoomWheelSensitivity: 'Wheel zoom sensitivity',
    settingsTextSnapStrength: 'Text snap strength',
    settingsTextSnapOff: 'Off',
    settingsTextSnapSoft: 'Soft',
    settingsTextSnapNormal: 'Normal',
    settingsTextSnapStrong: 'Strong',
    settingsTooltipDensity: 'Tooltip density',
    settingsTooltipSimple: 'Simple',
    settingsTooltipDetailed: 'Detailed',
    settingsAnimationStrength: 'Animation strength',
    settingsAnimationLow: 'Low',
    settingsAnimationDefault: 'Default',
    settingsAnimationHigh: 'High',
    settingsUiDensity: 'UI density',
    settingsDensityDefault: 'Default',
    settingsDensityCompact: 'Compact',
    settingsAutoSaveOff: 'Off',
    settingsTabGeneral: 'General',
    settingsTabEditing: 'Editing',
    settingsTabInfo: 'Info',
    settingsExportDefaults: 'Export defaults',
    settingsExportDefaultPreset: 'Default preset',
    settingsExportDefaultCustom: 'Keep current values',
    settingsExportDefaultApply: 'Apply defaults',
    settingsExportDefaultDone: 'Applied export defaults',
    settingsMobileQuickActions: 'Mobile quick action rail',
    settingsMobileQuickOrder: 'Quick action order',
    settingsMobileActionExport: 'Export',
    settingsMobileActionActivity: 'Log',
    settingsMobileActionShortcuts: 'Shortcuts',
    settingsMobileActionSettings: 'Settings',
    settingsMoveUp: 'Up',
    settingsMoveDown: 'Down',
    settingsLastAutoSave: 'Last autosave',
    settingsNoAutoSave: 'Autosave off',
    activityLog: 'Activity log',
    activityShow: 'Show log',
    activityHide: 'Hide log',
    activityCopy: 'Copy log',
    activityCopyItem: 'Copy item',
    activityJumpItem: 'Jump to file',
    activityPreviewOpen: 'Preview snapshot',
    activityPreviewUnavailable: 'This log has no preview snapshot',
    activityPreviewTitle: 'Activity snapshot preview',
    activityPreviewClose: 'Close',
    activityPreviewCompare: 'Compare slider',
    activityPreviewBefore: 'Snapshot',
    activityPreviewAfter: 'Current',
    activityApplySnapshot: 'Apply snapshot',
    activityApplyCurrent: 'Restore current',
    activityDownload: 'Save log',
    activityDownloadFiltered: 'Save filtered',
    activityDownloadAll: 'Save all',
    activityClear: 'Clear log',
    activityCopied: 'Activity log copied',
    activityDownloaded: (name: string) => `Log saved: ${name}`,
    activityCleared: 'Activity log cleared',
    activityEmpty: 'No activity logs yet.',
    activityFilterAll: 'All',
    activityFilterError: 'Error',
    activityFilterSuccess: 'Done',
    activityFilterWorking: 'Working',
    activitySortLatest: 'Latest first',
    activitySortOldest: 'Oldest first',
    activityLegendError: 'Error',
    activityLegendSuccess: 'Done',
    activityLegendWorking: 'Working',
    activityKindAi: 'AI',
    activityKindExport: 'Export',
    activityKindText: 'Text',
    activityKindSystem: 'System',
    activitySummary: (target: number, success: number, fail: number) => `Target ${target} · Success ${success} · Failed ${fail}`,
    quickBarMove: 'Move quick bar',
    quickBarToggle: 'Toggle quick bar',
    cancelTask: 'Cancel task',
    taskCancelled: 'Task cancelled',
    settingsInfo: 'Developer info',
    settingsVersion: 'Version',
    settingsDockerHub: 'Docker Hub',
    settingsGitHub: 'GitHub',
    settingsDocs: 'Developer',
    settingsCopyDockerHub: 'Copy link',
    settingsCopiedDockerHub: 'Docker Hub link copied',
    settingsDeveloper: 'Developer',
    settingsRepo: 'Repository',
    externalOpened: (label: string) => `Opened ${label} in a new tab`,
    settingsCopyDiagnostics: 'Copy diagnostics',
    settingsCopiedDiagnostics: 'Diagnostics copied',
    unsavedWarn: 'You have unsaved changes.',
    unsavedBadge: 'Unsaved changes',
    unsavedBadgeCount: (count: number) => `Unsaved changes (${count})`,
    unsavedUpdatedAt: (time: string) => `Last updated: ${time}`,
    unsavedRecentChanges: 'Recent changes',
    errCanvasUnavailable: 'Canvas is unavailable.',
    errPngConvertFailed: 'Failed to convert to PNG.',
    errImageLoadFailed: 'Failed to load image.',
    errDataUrlConvertFailed: 'Failed to convert to data URL.',
    errImportReadFile: 'Failed to read file.',
    errCanvasInitFailed: 'Failed to initialize canvas.',
    errInpaintHttp: (status: string, detail: string) => `AI erase request failed (${status}). ${detail}`,
    errInpaintNonImage: (snippet: string) => `AI restore API response is not an image. (check /api path/proxy) ${snippet}`,
    errApiBadJson: 'AI API response format error (check /api path/proxy)',
    errApiBadJsonWithSnippet: (snippet: string) => `AI API response format is invalid. (check /api path/proxy) ${snippet}`,
    errApiActionHint: 'Check backend container status and /api proxy routing.',
    aiRuntimeDetail: (runtime: string, requested: string, selectedCount: number) => `Runtime: ${runtime} · Requested: ${requested} · Selected: ${selectedCount}`,
    shortcutsHelp: 'Shortcuts',
    shortcutsToggleHint: 'Toggle with ? key',
    shortcutsCategoryAll: 'All',
    shortcutsCategoryTools: 'Tools',
    shortcutsCategorySelection: 'Selection',
    shortcutsCategoryHistory: 'History',
    shortcutsSearchPlaceholder: 'Search shortcuts',
    shortcutsNoMatch: 'No matching shortcuts.',
    shortcutCopied: (keyLabel: string) => `Shortcut copied: ${keyLabel}`,
    shortcutsClose: 'Close',
    shortcutsList: 'B Restore · E Eraser · T Text · N Arm text insert · C Crop · M Move · Ctrl/Shift/Alt+wheel Zoom · Space+drag / middle-drag Pan · Ctrl/Cmd+Z Undo · Shift+Ctrl/Cmd+Z Redo · Shift+click Multi-select · Ctrl/Cmd+D Duplicate selected text · Enter (Text/Move) start edit · I Invert selection · Alt+L Clear log · Arrows (Text/Move mode) move selected text · Alt+arrows (Crop mode) resize area · Enter Apply crop · P Preview crop · 0 Full frame · [/] Compare shift · 1/2/3/R Compare presets · Home/End extremes · Esc Clear selection/crop',
    topVersionTag: (version: string, track: string) => `v${version} · ${track}`,
    macroConfirmAll: (count: number) => `Apply to all ${count} files?`,
    macroConfirmSelected: (count: number) => `Apply to ${count} selected files?`,
    macroRunningAll: 'Applying to all files…',
    macroRunningSelected: 'Applying to selected files…',
    restorePromptTitle: 'Autosaved work found',
    restorePromptBody: 'Do you want to restore your previous editing state?',
    restorePromptRestore: 'Restore',
    restorePromptDiscard: 'Skip',
    settingsName: 'XIU-kr',
  },
} as const

function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      const saved = window.localStorage.getItem('vora-locale')
      if (saved && SUPPORTED_LOCALES.includes(saved as Locale)) return saved as Locale
    } catch {
      // ignore
    }
    return 'ko'
  })
  const ui = UI[locale]

  function localizeErrorMessage(message: string): string {
    const [code, ...rest] = message.split(':')
    const detail = rest.join(':').trim()
    if (code === ERR_CANVAS_UNAVAILABLE) return ui.errCanvasUnavailable
    if (code === ERR_PNG_CONVERT_FAILED) return ui.errPngConvertFailed
    if (code === ERR_IMAGE_LOAD_FAILED) return ui.errImageLoadFailed
    if (code === ERR_DATA_URL_CONVERT_FAILED) return ui.errDataUrlConvertFailed
    if (code === 'ERR_IMPORT_READ_FILE') return ui.errImportReadFile
    if (code === 'ERR_IMPORT_IMAGE_LOAD') return ui.errImageLoadFailed
    if (code === 'ERR_CANVAS_INIT_FAILED') return ui.errCanvasInitFailed
    if (code === 'ERR_INPAINT_NON_IMAGE') return `${ui.errInpaintNonImage(detail)} ${ui.errApiActionHint}`
    if (code === 'ERR_API_BAD_JSON') return `${ui.errApiBadJsonWithSnippet(detail)} ${ui.errApiActionHint}`
    if (code === 'ERR_INPAINT_HTTP') {
      const [status = '', ...tail] = rest
      return `${ui.errInpaintHttp(status, tail.join(':').trim())} ${ui.errApiActionHint}`
    }
    if (code === 'ERR_SEGMENT_NON_IMAGE') return `${ui.errInpaintNonImage(detail)} ${ui.errApiActionHint}`
    if (code === 'ERR_SEGMENT_HTTP') {
      const [status = '', ...tail] = rest
      return `${ui.errInpaintHttp(status, tail.join(':').trim())} ${ui.errApiActionHint}`
    }
    return message
  }
  const [assets, setAssets] = useState<PageAsset[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [assetListHistoryPast, setAssetListHistoryPast] = useState<AssetListHistoryEntry[]>([])
  const [assetListHistoryFuture, setAssetListHistoryFuture] = useState<AssetListHistoryEntry[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const [selectionMaskDataUrl, setSelectionMaskDataUrl] = useState<string | null>(null)
  const [selectionMaskImage, setSelectionMaskImage] = useState<HTMLImageElement | null>(null)
  const [selectionMaskBounds, setSelectionMaskBounds] = useState<CropRect | null>(null)
  const [antsDashOffset, setAntsDashOffset] = useState(0)
  const [expandContractRadius, setExpandContractRadius] = useState(5)
  const [featherRadius, setFeatherRadius] = useState(5)
  const [selectMode, setSelectMode] = useState<'ai' | 'rect' | 'ellipse' | 'lasso'>('ai')
  const [showGrid, setShowGrid] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [gridSpacing, _setGridSpacing] = useState(100)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)
  const [marqueeRect, setMarqueeRect] = useState<CropRect | null>(null)
  const [lassoPoints, setLassoPoints] = useState<number[]>([])
  const lassoActiveRef = useRef(false)
  const [resizeWidth, setResizeWidth] = useState(0)
  const [resizeHeight, setResizeHeight] = useState(0)
  const [resizeLockAspect, setResizeLockAspect] = useState(true)
  const [selectionFillColor, setSelectionFillColor] = useState('#ffffff')
  const [selectionBackgroundImageUrl, setSelectionBackgroundImageUrl] = useState<string | null>(null)
  const [fontSearchQuery, setFontSearchQuery] = useState('')
  const [accordionState, setAccordionState] = useState<Record<string, boolean>>({
    files: true,
    properties: true,
    layers: true,
    history: false,
  })
  const toggleAccordion = (key: string) => setAccordionState((prev) => ({ ...prev, [key]: !prev[key] }))
  const active = useMemo(() => assets.find((a) => a.id === activeId) ?? null, [assets, activeId])

  useEffect(() => {
    const families = new Set<string>()
    for (const asset of assets) {
      for (const text of asset.texts) {
        families.add(text.fontFamily)
      }
    }
    for (const family of families) {
      ensureGoogleWebFontLoaded(family)
    }
  }, [assets])

  const [tool, setTool] = useState<Tool>('restore')
  const [canvasZoom, setCanvasZoom] = useState(1)
  const [canvasOffset, setCanvasOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [brushSize, setBrushSize] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('vora-brush-size'))
      if (Number.isFinite(saved)) return clamp(Math.round(saved), BRUSH_MIN, BRUSH_MAX)
    } catch {
      // ignore
    }
    return DEFAULT_BRUSH_SIZE
  })
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null)
  const [selectedTextIds, setSelectedTextIds] = useState<string[]>([])
  const [textInsertArmed, setTextInsertArmed] = useState(false)
  const [pendingMaskAction, setPendingMaskAction] = useState<PendingMaskAction | null>(null)
  const [maskApplyScope, setMaskApplyScope] = useState<MaskApplyScope>('full')
  const [maskPreviewOpacity, setMaskPreviewOpacity] = useState(0.58)
  const selectedText = useMemo(
    () => active?.texts.find((t) => t.id === selectedTextId) ?? null,
    [active, selectedTextId],
  )

  const selectedFontPresetId = useMemo(
    () => (selectedText ? resolveTextFontPreset(selectedText) : null),
    [selectedText],
  )

  const groupedTextFontPresets = useMemo(() => {
    const query = fontSearchQuery.trim().toLowerCase()
    const selectedPreset = selectedFontPresetId
      ? TEXT_FONT_PRESETS.find((preset) => preset.id === selectedFontPresetId) ?? null
      : null

    const filtered = TEXT_FONT_PRESETS.filter((preset) => {
      if (!query) return true
      const categoryLabel = getFontCategoryLabel(preset.category, locale)
      const haystack = `${preset.label} ${preset.family} ${categoryLabel}`.toLowerCase()
      return haystack.includes(query)
    })

    if (selectedPreset && !filtered.some((preset) => preset.id === selectedPreset.id)) {
      filtered.unshift(selectedPreset)
    }

    const grouped = new Map<FontCategoryId, TextFontPreset[]>()
    for (const preset of filtered) {
      const prev = grouped.get(preset.category)
      if (prev) {
        prev.push(preset)
      } else {
        grouped.set(preset.category, [preset])
      }
    }

    return FONT_CATEGORY_ORDER
      .map((category) => ({
        category,
        label: getFontCategoryLabel(category, locale),
        presets: grouped.get(category) ?? [],
      }))
      .filter((group) => group.presets.length > 0)
  }, [fontSearchQuery, locale, selectedFontPresetId])

  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string>(ui.ready)
  const [toast, setToast] = useState<string | null>(null)
  const [toastAt, setToastAt] = useState<number | null>(null)
  const [aiDevice, setAiDevice] = useState<string>('initializing')
  const [aiReady, setAiReady] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiRequestedDevice, setAiRequestedDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto')
  const [cudaAvailable, setCudaAvailable] = useState<boolean | null>(null)
  const [switchingDevice, setSwitchingDevice] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [highlightExportFormat, setHighlightExportFormat] = useState(false)
  const [pendingExportFormat, setPendingExportFormat] = useState<ExportKind>(() => {
    try {
      const saved = window.localStorage.getItem('vora-export-format')
      return saved === 'png' || saved === 'jpg' || saved === 'webp' || saved === 'pdf' || saved === 'pptx' ? saved : 'png'
    } catch {
      return 'png'
    }
  })
  const [pendingExportRatio, setPendingExportRatio] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('vora-export-ratio'))
      return Number.isFinite(saved) ? normalizeExportRatio(saved) : 2
    } catch {
      return 2
    }
  })
  const [pendingExportScope, setPendingExportScope] = useState<ExportScope>(() => {
    try {
      const saved = window.localStorage.getItem('vora-export-scope')
      return saved === 'current' || saved === 'selected' || saved === 'all' ? saved : 'current'
    } catch {
      return 'current'
    }
  })
  const [pendingExportQuality, setPendingExportQuality] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('vora-export-quality'))
      return Number.isFinite(saved) ? clamp(Math.round(saved), 50, 100) : 92
    } catch {
    return DEFAULT_EXPORT_QUALITY
    }
  })
  const [macroRepeatCount, setMacroRepeatCount] = useState(1)
  const [dragAssetId, setDragAssetId] = useState<string | null>(null)
  const [dragOverAssetId, setDragOverAssetId] = useState<string | null>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [flashAssetId, setFlashAssetId] = useState<string | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [dirtyChangeCount, setDirtyChangeCount] = useState(0)
  const [lastDirtyAt, setLastDirtyAt] = useState<number | null>(null)
  const [showGuide, setShowGuide] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('vora-show-guide') !== '0'
    } catch {
      return true
    }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_rightPanelTab, _setRightPanelTab] = useState<RightPanelTab>('properties')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_filesCollapsed, _setFilesCollapsed] = useState(false)
  const [showMobileQuickActions, setShowMobileQuickActions] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('vora-mobile-quick-actions') !== '0'
    } catch {
      return true
    }
  })
  const [mobileQuickOrder, setMobileQuickOrder] = useState<MobileQuickAction[]>(() => {
    try {
      const raw = window.localStorage.getItem('vora-mobile-quick-order')
      const parsed = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed) && parsed.length === 4) {
        const filtered = parsed.filter((v): v is MobileQuickAction => v === 'export' || v === 'activity' || v === 'shortcuts' || v === 'settings')
        if (new Set(filtered).size === 4) return filtered
      }
    } catch {
      // ignore
    }
    return ['export', 'activity', 'shortcuts', 'settings']
  })
  const [mobileQuickPressed, setMobileQuickPressed] = useState<MobileQuickAction | null>(null)
  const [mobileQuickDrag, setMobileQuickDrag] = useState<MobileQuickAction | null>(null)
  const [cropHideDocksOnCrop, setCropHideDocksOnCrop] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('vora-crop-hide-docks') !== '0'
    } catch {
      return true
    }
  })
  const [showActivityLog, setShowActivityLog] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('vora-activity-open') === '1'
    } catch {
      return false
    }
  })
  const [toastLog, setToastLog] = useState<ToastLogItem[]>([])
  const [activityMenu, setActivityMenu] = useState<{ x: number; y: number; item: ToastLogItem } | null>(null)
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number; imageX: number; imageY: number } | null>(null)
  const [activityPreview, setActivityPreview] = useState<{ item: ToastLogItem; snapshot: PageSnapshot | null; current: PageSnapshot | null } | null>(null)
  const [activityPreviewCompare, setActivityPreviewCompare] = useState(50)
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(() => {
    try {
      const saved = window.localStorage.getItem('vora-activity-filter')
      if (saved === 'all' || saved === 'error' || saved === 'success' || saved === 'working') return saved
    } catch {
      // ignore
    }
    return 'all'
  })
  const [activitySort, setActivitySort] = useState<'latest' | 'oldest'>(() => {
    try {
      return window.localStorage.getItem('vora-activity-sort') === 'oldest' ? 'oldest' : 'latest'
    } catch {
      return 'latest'
    }
  })
  const [activityDownloadMode, setActivityDownloadMode] = useState<'filtered' | 'all'>(() => {
    try {
      return window.localStorage.getItem('vora-activity-download-mode') === 'all' ? 'all' : 'filtered'
    } catch {
      return 'filtered'
    }
  })
  const [exportDefaultPreset, setExportDefaultPreset] = useState<'web' | 'print' | 'slides' | 'custom'>(() => {
    try {
      const saved = window.localStorage.getItem('vora-export-default-preset')
      return saved === 'web' || saved === 'print' || saved === 'slides' || saved === 'custom' ? saved : 'custom'
    } catch {
      return 'custom'
    }
  })
  const [exportDefaultFormat, setExportDefaultFormat] = useState<ExportKind>(() => {
    try {
      const saved = window.localStorage.getItem('vora-export-default-format')
      return saved === 'png' || saved === 'jpg' || saved === 'webp' || saved === 'pdf' || saved === 'pptx' ? saved : 'png'
    } catch {
      return 'png'
    }
  })
  const [exportDefaultScope, setExportDefaultScope] = useState<ExportScope>(() => {
    try {
      const saved = window.localStorage.getItem('vora-export-default-scope')
      return saved === 'current' || saved === 'selected' || saved === 'all' ? saved : 'current'
    } catch {
      return 'current'
    }
  })
  const [activityLogLimit, setActivityLogLimit] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('vora-activity-limit'))
      if (saved === 5 || saved === 10 || saved === 20) return saved
    } catch {
      // ignore
    }
    return DEFAULT_ACTIVITY_LOG_LIMIT
  })
  const [activityNow, setActivityNow] = useState<number>(() => Date.now())
  const [preferredDevice, setPreferredDevice] = useState<'cpu' | 'cuda'>(() => {
    try {
      const saved = window.localStorage.getItem('vora-preferred-device-restore')
      if (saved === 'cuda' || saved === 'cpu') return saved
      // No saved preference — default will be resolved after cudaAvailable is known
      return 'cpu'
    } catch {
      return 'cpu'
    }
  })
  const hasExplicitDevicePref = (() => {
    try { return window.localStorage.getItem('vora-preferred-device-restore') !== null } catch { return false }
  })()
  const [autoSaveSeconds, setAutoSaveSeconds] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('vora-autosave-sec'))
      if (Number.isFinite(saved)) return clamp(Math.round(saved), 0, 300)
    } catch {
      // ignore
    }
    return DEFAULT_AUTOSAVE_SECONDS
  })
  const [showShortcutTips, setShowShortcutTips] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('vora-shortcut-tips') !== '0'
    } catch {
      return true
    }
  })
  const [textClickEditMode, setTextClickEditMode] = useState<TextClickEditMode>(() => {
    try {
      return window.localStorage.getItem('vora-text-click-edit-mode') === 'double' ? 'double' : 'single'
    } catch {
      return 'single'
    }
  })
  const [zoomWheelSensitivity, setZoomWheelSensitivity] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('vora-zoom-wheel-sensitivity'))
      if (Number.isFinite(saved)) return clamp(saved, 0.4, 2)
    } catch {
      // ignore
    }
    return DEFAULT_ZOOM_WHEEL_SENSITIVITY
  })
  const [textSnapStrength, setTextSnapStrength] = useState<TextSnapStrength>(() => {
    try {
      const saved = window.localStorage.getItem('vora-text-snap-strength')
      if (saved === 'off' || saved === 'soft' || saved === 'normal' || saved === 'strong') return saved
    } catch {
      // ignore
    }
    return 'normal'
  })
  const [tooltipsMuted, setTooltipsMuted] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const [shortcutsQuery, setShortcutsQuery] = useState('')
  const [shortcutsCategory, setShortcutsCategory] = useState<'all' | ShortcutCategory>('all')
  const [macroRunningMode, setMacroRunningMode] = useState<'all' | 'selected' | null>(null)
  const [macroRunningTool, setMacroRunningTool] = useState<'restore' | 'eraser' | null>(null)
  const [tooltipDensity, setTooltipDensity] = useState<TooltipDensity>(() => {
    try {
      return window.localStorage.getItem('vora-tooltip-density') === 'simple' ? 'simple' : 'detailed'
    } catch {
      return 'detailed'
    }
  })
  const [animationStrength, setAnimationStrength] = useState<AnimationStrength>(() => {
    try {
      const saved = window.localStorage.getItem('vora-animation-strength')
      if (saved === 'low' || saved === 'high' || saved === 'default') return saved
    } catch {
      // ignore
    }
    return 'high'
  })
  const [uiDensity, setUiDensity] = useState<UiDensity>(() => {
    try {
      return window.localStorage.getItem('vora-ui-density') === 'compact' ? 'compact' : 'default'
    } catch {
      return 'default'
    }
  })

  const stageRef = useRef<Konva.Stage | null>(null)
  const transformerRef = useRef<Konva.Transformer | null>(null)
  const textNodeRefs = useRef<Record<string, Konva.Text>>({})

  const { ref: wrapRef, size: wrapSize } = useElementSize<HTMLDivElement>()
  const [baseImg, setBaseImg] = useState<HTMLImageElement | null>(null)

  const [dragGuides, setDragGuides] = useState<{ x?: number; y?: number }>({})
  const [dragMetrics, setDragMetrics] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null)
  const [guidePulse, setGuidePulse] = useState(0.82)
  const [cropRect, setCropRect] = useState<CropRect | null>(null)
  const [cropPreset, setCropPreset] = useState<CropPreset>('free')
  const [cropPreviewDataUrl, setCropPreviewDataUrl] = useState<string | null>(null)
  const [cropPreviewCompare, setCropPreviewCompare] = useState(55)
  const [cropCompareDragging, setCropCompareDragging] = useState(false)
  const [cropHoverHandle, setCropHoverHandle] = useState<CropHandle | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  })
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const inpaintQueueRef = useRef<InpaintJob[]>([])
  const inpaintRunningRef = useRef(false)
  const selectionBackgroundInputRef = useRef<HTMLInputElement | null>(null)
  const debounceTimerRef = useRef<number | null>(null)
  const cropStartRef = useRef<{ x: number; y: number } | null>(null)
  const cropResizeRef = useRef<{ handle: CropHandle; rect: CropRect } | null>(null)
  const cropCompareFrameRef = useRef<HTMLDivElement | null>(null)
  const lastRestoreMacroTemplateRef = useRef<NormalizedStroke[] | null>(null)
  const lastEraserMacroTemplateRef = useRef<NormalizedStroke[] | null>(null)
  const lastSelectionAnchorIdRef = useRef<string | null>(null)
  const activeRef = useRef<PageAsset | null>(null)
  const assetsRef = useRef<PageAsset[]>([])
  const textTransformBaseRef = useRef<{ textId: string; fontSize: number; rectHeight: number } | null>(null)
  const preferredAppliedRef = useRef(false)
  const guideFlashTimerRef = useRef<number | null>(null)
  const tooltipMuteTimerRef = useRef<number | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const activityQueryInitRef = useRef(false)
  const quickBarOffsetsRef = useRef<Record<string, { x: number; y: number }>>({})
  const [guideFocusTarget, setGuideFocusTarget] = useState<'files' | 'tools' | 'canvas' | 'export' | null>(null)
  const cancelRequestedRef = useRef(false)
  const [lastAutoSaveAt, setLastAutoSaveAt] = useState<number | null>(null)
  const [pendingAutoRestore, setPendingAutoRestore] = useState<AutoSavePayload | null>(null)
  const [cancelableTask, setCancelableTask] = useState(false)
  const [progressState, setProgressState] = useState<{
    label: string
    value: number
    total: number
    indeterminate?: boolean
  } | null>(null)
  const [quickBarOffset, setQuickBarOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [draggingQuickBar, setDraggingQuickBar] = useState(false)
  const [quickBarCollapsed, setQuickBarCollapsed] = useState(false)
  const [spacePanActive, setSpacePanActive] = useState(false)
  const quickBarDragRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | null>(null)
  const movePanRef = useRef<{ x: number; y: number; ts: number } | null>(null)
  const moveMomentumRef = useRef<{ vx: number; vy: number } | null>(null)
  const moveMomentumRafRef = useRef<number | null>(null)
  const spacePanPressedRef = useRef(false)
  const lastTextDragAtRef = useRef(0)
  const textDragMovedRef = useRef<Record<string, boolean>>({})
  const assetCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const exportDialogRef = useRef<HTMLDivElement | null>(null)
  const dirtyInitRef = useRef(false)

  const selectedAssets = useMemo(
    () => assets.filter((a) => selectedAssetIds.includes(a.id)),
    [assets, selectedAssetIds],
  )

  function setZoom(next: number) {
    setCanvasZoom(clamp(Number(next.toFixed(2)), ZOOM_MIN, ZOOM_MAX))
  }

  function zoomBy(delta: number) {
    setCanvasZoom((prev) => clamp(Number((prev + delta).toFixed(2)), ZOOM_MIN, ZOOM_MAX))
  }

  function fitViewToRect(rect: CropRect) {
    if (!active || !wrapSize.w || !wrapSize.h) return
    const padding = 48
    const cw = Math.max(1, wrapSize.w - padding * 2)
    const ch = Math.max(1, wrapSize.h - padding * 2)
    const scaleX = cw / Math.max(1, rect.width)
    const scaleY = ch / Math.max(1, rect.height)
    const targetScale = Math.min(scaleX, scaleY)
    const basePadding = 24
    const bcw = Math.max(1, wrapSize.w - basePadding * 2)
    const bch = Math.max(1, wrapSize.h - basePadding * 2)
    const baseScale = Math.min(bcw / active.width, bch / active.height)
    const newCanvasZoom = clamp(targetScale / baseScale, ZOOM_MIN, ZOOM_MAX)
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    const newOffsetX = wrapSize.w / 2 - centerX * targetScale - (wrapSize.w - active.width * targetScale) / 2
    const newOffsetY = wrapSize.h / 2 - centerY * targetScale - (wrapSize.h - active.height * targetScale) / 2
    setCanvasZoom(newCanvasZoom)
    setCanvasOffset({ x: newOffsetX, y: newOffsetY })
  }

  function zoomFromWheelAtClient(deltaY: number, clientX: number, clientY: number) {
    if (!active) return
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return

    const pointerX = clientX - rect.left
    const pointerY = clientY - rect.top
    const magnitude = clamp(Math.abs(deltaY) / 120, 0.25, 3)
    const step = (deltaY > 0 ? -1 : 1) * 0.07 * magnitude * zoomWheelSensitivity
    const nextZoom = clamp(Number((canvasZoom + step).toFixed(2)), ZOOM_MIN, ZOOM_MAX)
    if (Math.abs(nextZoom - canvasZoom) < 0.0001) return

    const padding = 24
    const cw = Math.max(1, wrapSize.w - padding * 2)
    const ch = Math.max(1, wrapSize.h - padding * 2)
    const baseScale = Math.min(cw / active.width, ch / active.height)
    const currentScale = baseScale * canvasZoom
    const nextScale = baseScale * nextZoom
    if (!Number.isFinite(currentScale) || !Number.isFinite(nextScale) || currentScale <= 0 || nextScale <= 0) return

    const imageX = (pointerX - fit.ox) / currentScale
    const imageY = (pointerY - fit.oy) / currentScale

    const centeredOx = (wrapSize.w - active.width * nextScale) / 2
    const centeredOy = (wrapSize.h - active.height * nextScale) / 2
    const nextOffsetX = pointerX - imageX * nextScale - centeredOx
    const nextOffsetY = pointerY - imageY * nextScale - centeredOy

    setCanvasZoom(nextZoom)
    setCanvasOffset({ x: nextOffsetX, y: nextOffsetY })
  }

  function stopMoveMomentum() {
    if (moveMomentumRafRef.current !== null) {
      window.cancelAnimationFrame(moveMomentumRafRef.current)
      moveMomentumRafRef.current = null
    }
    moveMomentumRef.current = null
  }

  function startMoveMomentum() {
    if (tool !== 'move') return
    const velocity = moveMomentumRef.current
    if (!velocity) return
    stopMoveMomentum()
    let lastTs = performance.now()

    const tick = (now: number) => {
      const dt = Math.max(1, now - lastTs)
      lastTs = now
      const vel = moveMomentumRef.current
      if (!vel) {
        moveMomentumRafRef.current = null
        return
      }

      const friction = Math.pow(0.9, dt / 16)
      vel.vx *= friction
      vel.vy *= friction

      if (Math.abs(vel.vx) < 0.01 && Math.abs(vel.vy) < 0.01) {
        stopMoveMomentum()
        return
      }

      setCanvasOffset((prev) => ({ x: prev.x + vel.vx * dt, y: prev.y + vel.vy * dt }))
      moveMomentumRafRef.current = window.requestAnimationFrame(tick)
    }

    moveMomentumRafRef.current = window.requestAnimationFrame(tick)
  }

  function addSelectedAssetRange(anchorId: string, targetId: string) {
    const anchorIdx = assets.findIndex((a) => a.id === anchorId)
    const targetIdx = assets.findIndex((a) => a.id === targetId)
    if (anchorIdx < 0 || targetIdx < 0) return
    const [start, end] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
    const rangeIds = assets.slice(start, end + 1).map((a) => a.id)
    setSelectedAssetIds((prev) => Array.from(new Set([...prev, ...rangeIds])))
  }

  function onAssetCardClick(e: ReactMouseEvent<HTMLDivElement>, assetId: string) {
    const anchorId = lastSelectionAnchorIdRef.current ?? activeId ?? assetId
    setActiveId(assetId)
    if (e.shiftKey) {
      addSelectedAssetRange(anchorId, assetId)
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedAssetIds((prev) => {
        if (prev.includes(assetId)) return prev.filter((id) => id !== assetId)
        return [...prev, assetId]
      })
    }
    lastSelectionAnchorIdRef.current = assetId
  }

  function invertAssetSelection() {
    setSelectedAssetIds((prev) => assets.map((a) => a.id).filter((id) => !prev.includes(id)))
  }

  function scrollToAsset(assetId: string) {
    const node = assetCardRefs.current[assetId]
    if (!node) return
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  function exportTargets(scope: ExportScope): PageAsset[] {
    if (scope === 'current') return active ? [active] : []
    if (scope === 'selected') return selectedAssets
    return assets
  }

  function normalizeExportRatio(value: number) {
    const nearest = UPSCALE_OPTIONS.reduce((best, option) => {
      const bestDist = Math.abs(best - value)
      const nextDist = Math.abs(option - value)
      return nextDist < bestDist ? option : best
    }, UPSCALE_OPTIONS[0])
    return nearest
  }

  const fit = useMemo(() => {
    if (!active) return { scale: 1, ox: 0, oy: 0 }
    const padding = 24
    const cw = Math.max(1, wrapSize.w - padding * 2)
    const ch = Math.max(1, wrapSize.h - padding * 2)
    const baseScale = Math.min(cw / active.width, ch / active.height)
    const scale = baseScale * canvasZoom
    const w = active.width * scale
    const h = active.height * scale
    const ox = (wrapSize.w - w) / 2 + canvasOffset.x
    const oy = (wrapSize.h - h) / 2 + canvasOffset.y
    return { scale, ox, oy }
  }, [active, wrapSize, canvasZoom, canvasOffset])

  useEffect(() => {
    clearTextSelection()
    setCropRect(null)
    setCropPreset('free')
    setCropPreviewDataUrl(null)
    setCropPreviewCompare(55)
    setCropCompareDragging(false)
    setCropHoverHandle(null)
    cropStartRef.current = null
    cropResizeRef.current = null
    setCanvasOffset({ x: 0, y: 0 })
  }, [activeId])

  useEffect(() => {
    if (active) { setResizeWidth(active.width); setResizeHeight(active.height) }
  }, [active?.id])

  useEffect(() => {
    if (!active) {
      setBaseImg(null)
      return
    }
    loadHtmlImage(active.baseDataUrl)
      .then((img) => setBaseImg(img))
      .catch(() => setBaseImg(null))
  }, [active?.baseDataUrl])

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    assetsRef.current = assets
  }, [assets])

  useEffect(() => {
    setSelectedAssetIds((prev) => prev.filter((id) => assets.some((a) => a.id === id)))
  }, [assets])

  useEffect(() => {
    if (!dirtyInitRef.current) {
      dirtyInitRef.current = true
      return
    }
    setHasUnsavedChanges(true)
    setDirtyChangeCount((prev) => prev + 1)
    setLastDirtyAt(Date.now())
  }, [assets])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return
      event.preventDefault()
      event.returnValue = ui.unsavedWarn
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedChanges, ui.unsavedWarn])

  useEffect(() => {
    if (!flashAssetId) return
    const timer = window.setTimeout(() => setFlashAssetId(null), 1200)
    return () => window.clearTimeout(timer)
  }, [flashAssetId])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-locale', locale)
    } catch {
      // ignore
    }
  }, [locale])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-mobile-quick-actions', showMobileQuickActions ? '1' : '0')
    } catch {
      // ignore
    }
  }, [showMobileQuickActions])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-crop-hide-docks', cropHideDocksOnCrop ? '1' : '0')
    } catch {
      // ignore
    }
  }, [cropHideDocksOnCrop])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-mobile-quick-order', JSON.stringify(mobileQuickOrder))
    } catch {
      // ignore
    }
  }, [mobileQuickOrder])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-export-default-preset', exportDefaultPreset)
    } catch {
      // ignore
    }
  }, [exportDefaultPreset])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-export-default-format', exportDefaultFormat)
    } catch {
      // ignore
    }
  }, [exportDefaultFormat])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-export-default-scope', exportDefaultScope)
    } catch {
      // ignore
    }
  }, [exportDefaultScope])

  useEffect(() => {
    if (activityQueryInitRef.current) return
    activityQueryInitRef.current = true
    try {
      const params = new URLSearchParams(window.location.search)
      const open = params.get('activityOpen')
      const filter = params.get('activityFilter')
      const sort = params.get('activitySort')
      const exportFormat = params.get('exportFormat')
      const exportRatio = Number(params.get('exportRatio'))
      const exportScope = params.get('exportScope')
      const exportQuality = Number(params.get('exportQuality'))
      if (open === '1' || open === '0') setShowActivityLog(open === '1')
      if (filter === 'all' || filter === 'error' || filter === 'success' || filter === 'working') setActivityFilter(filter)
      if (sort === 'latest' || sort === 'oldest') setActivitySort(sort)
      if (exportFormat === 'png' || exportFormat === 'jpg' || exportFormat === 'webp' || exportFormat === 'pdf' || exportFormat === 'pptx') setPendingExportFormat(exportFormat)
      if (Number.isFinite(exportRatio)) setPendingExportRatio(normalizeExportRatio(exportRatio))
      if (exportScope === 'current' || exportScope === 'selected' || exportScope === 'all') setPendingExportScope(exportScope)
      if (Number.isFinite(exportQuality)) setPendingExportQuality(clamp(Math.round(exportQuality), 50, 100))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      params.set('activityOpen', showActivityLog ? '1' : '0')
      params.set('activityFilter', activityFilter)
      params.set('activitySort', activitySort)
      const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`
      window.history.replaceState(null, '', next)
    } catch {
      // ignore
    }
  }, [showActivityLog, activityFilter, activitySort])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-show-guide', showGuide ? '1' : '0')
    } catch {
      // ignore
    }
  }, [showGuide])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-brush-size', String(clamp(Math.round(brushSize), BRUSH_MIN, BRUSH_MAX)))
    } catch {
      // ignore
    }
  }, [brushSize])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-autosave-sec', String(clamp(Math.round(autoSaveSeconds), 0, 300)))
    } catch {
      // ignore
    }
  }, [autoSaveSeconds])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-shortcut-tips', showShortcutTips ? '1' : '0')
    } catch {
      // ignore
    }
  }, [showShortcutTips])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-text-click-edit-mode', textClickEditMode)
    } catch {
      // ignore
    }
  }, [textClickEditMode])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-zoom-wheel-sensitivity', String(clamp(zoomWheelSensitivity, 0.4, 2)))
    } catch {
      // ignore
    }
  }, [zoomWheelSensitivity])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-text-snap-strength', textSnapStrength)
    } catch {
      // ignore
    }
  }, [textSnapStrength])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-export-format', pendingExportFormat)
      window.localStorage.setItem('vora-export-ratio', String(pendingExportRatio))
      window.localStorage.setItem('vora-export-scope', pendingExportScope)
      window.localStorage.setItem('vora-export-quality', String(clamp(Math.round(pendingExportQuality), 50, 100)))
    } catch {
      // ignore
    }
  }, [pendingExportFormat, pendingExportRatio, pendingExportScope, pendingExportQuality])

  useEffect(() => {
    if (!exportDialogOpen) return
    const root = exportDialogRef.current
    if (!root) return
    const first = root.querySelector<HTMLElement>('button,select,input,[tabindex]:not([tabindex="-1"])')
    first?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (!exportDialogOpen) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setExportDialogOpen(false)
        return
      }
      if (event.key === 'Enter') {
        const target = event.target as HTMLElement | null
        if (target && target.tagName === 'BUTTON') return
        event.preventDefault()
        void confirmExport()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'),
      )
      if (focusables.length === 0) return
      const current = document.activeElement as HTMLElement | null
      const idx = focusables.indexOf(current ?? focusables[0]!)
      if (event.shiftKey && idx <= 0) {
        event.preventDefault()
        focusables[focusables.length - 1]?.focus()
      } else if (!event.shiftKey && idx >= focusables.length - 1) {
        event.preventDefault()
        focusables[0]?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exportDialogOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setTooltipsMuted(true)
      if (tooltipMuteTimerRef.current !== null) {
        window.clearTimeout(tooltipMuteTimerRef.current)
      }
      tooltipMuteTimerRef.current = window.setTimeout(() => {
        setTooltipsMuted(false)
        tooltipMuteTimerRef.current = null
      }, 1800)
    }
    const onPointerMove = () => {
      if (!tooltipsMuted) return
      setTooltipsMuted(false)
      if (tooltipMuteTimerRef.current !== null) {
        window.clearTimeout(tooltipMuteTimerRef.current)
        tooltipMuteTimerRef.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointermove', onPointerMove)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointermove', onPointerMove)
    }
  }, [tooltipsMuted])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-tooltip-density', tooltipDensity)
    } catch {
      // ignore
    }
  }, [tooltipDensity])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-animation-strength', animationStrength)
    } catch {
      // ignore
    }
  }, [animationStrength])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-ui-density', uiDensity)
    } catch {
      // ignore
    }
  }, [uiDensity])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('vora-autosave')
      if (!raw) return
      const parsed = JSON.parse(raw) as { assets?: PageAsset[]; activeId?: string | null; ts?: number }
      if (!Array.isArray(parsed.assets) || parsed.assets.length === 0) return
      const ts = typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : Date.now()
      setPendingAutoRestore({
        assets: parsed.assets,
        activeId: parsed.activeId ?? parsed.assets[0]?.id ?? null,
        ts,
      })
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (autoSaveSeconds <= 0) return
    const timer = window.setInterval(() => {
      try {
        window.localStorage.setItem(
          'vora-autosave',
          JSON.stringify({
            ts: Date.now(),
            activeId,
            assets,
          }),
        )
        setLastAutoSaveAt(Date.now())
      } catch {
        // ignore
      }
    }, autoSaveSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [autoSaveSeconds, assets, activeId])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-preferred-device-restore', preferredDevice)
    } catch {
      // ignore
    }
  }, [preferredDevice])

  useEffect(() => {
    if (preferredAppliedRef.current) return
    // Auto-select GPU when available and user has no explicit saved preference
    const effectiveDevice = (!hasExplicitDevicePref && cudaAvailable === true) ? 'cuda' : preferredDevice
    if (aiRequestedDevice !== 'auto' && aiRequestedDevice === effectiveDevice) {
      preferredAppliedRef.current = true
      return
    }
    if (effectiveDevice === 'cuda' && cudaAvailable === false) {
      preferredAppliedRef.current = true
      return
    }
    if (cudaAvailable === null) return // wait for health check
    preferredAppliedRef.current = true
    void setDeviceMode(effectiveDevice)
  }, [aiRequestedDevice, preferredDevice, cudaAvailable])

  useEffect(() => {
    return () => {
      if (guideFlashTimerRef.current !== null) {
        window.clearTimeout(guideFlashTimerRef.current)
      }
      if (tooltipMuteTimerRef.current !== null) {
        window.clearTimeout(tooltipMuteTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!showActivityLog) return
    const timer = window.setInterval(() => setActivityNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [showActivityLog])

  useEffect(() => {
    if (!showShortcutsHelp) {
      setShortcutsQuery('')
      setShortcutsCategory('all')
    }
  }, [showShortcutsHelp])

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!activityMenu && !canvasMenu) return
    const close = () => {
      setActivityMenu(null)
      setCanvasMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [activityMenu, canvasMenu])

  useEffect(() => {
    if (!highlightExportFormat) return
    const timer = window.setTimeout(() => setHighlightExportFormat(false), 1400)
    return () => window.clearTimeout(timer)
  }, [highlightExportFormat])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-activity-open', showActivityLog ? '1' : '0')
    } catch {
      // ignore
    }
  }, [showActivityLog])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-activity-filter', activityFilter)
    } catch {
      // ignore
    }
  }, [activityFilter])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-activity-sort', activitySort)
    } catch {
      // ignore
    }
  }, [activitySort])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-activity-download-mode', activityDownloadMode)
    } catch {
      // ignore
    }
  }, [activityDownloadMode])

  useEffect(() => {
    try {
      window.localStorage.setItem('vora-activity-limit', String(activityLogLimit))
    } catch {
      // ignore
    }
  }, [activityLogLimit])

  useEffect(() => {
    const saved = selectedTextId ? quickBarOffsetsRef.current[selectedTextId] : null
    setQuickBarOffset(saved ?? { x: 0, y: 0 })
    setDraggingQuickBar(false)
    setQuickBarCollapsed(false)
    quickBarDragRef.current = null
  }, [selectedTextId, activeId, tool])

  useEffect(() => {
    setCanvasZoom(1)
  }, [activeId])

  useEffect(() => {
    if (!draggingQuickBar) return
    const onMove = (event: MouseEvent) => {
      const drag = quickBarDragRef.current
      if (!drag) return
      setQuickBarOffset({
        x: drag.originX + (event.clientX - drag.pointerX),
        y: drag.originY + (event.clientY - drag.pointerY),
      })
    }
    const onUp = () => {
      if (selectedTextId) {
        quickBarOffsetsRef.current[selectedTextId] = quickBarOffset
      }
      setDraggingQuickBar(false)
      quickBarDragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [draggingQuickBar, quickBarOffset, selectedTextId])

  useEffect(() => {
    if (busy) {
      setToast(busy)
      setToastAt(Date.now())
      return
    }
    if (!status || status === ui.ready) return
    setToast(status)
    setToastAt(Date.now())
    const timer = window.setTimeout(() => setToast(null), 2300)
    return () => window.clearTimeout(timer)
  }, [busy, status, ui.ready])

  useEffect(() => {
    if (!toast) return
    setToastLog((prev) => {
      const next: ToastLogItem = {
        id: uid('log'),
        text: toast,
        tone: statusTone(toast),
        at: Date.now(),
        assetId: activeRef.current?.id ?? null,
        snapshot: activeRef.current ? serializeSnapshot(snapshotFrom(activeRef.current)) : null,
      }
      return [next, ...prev].slice(0, activityLogLimit)
    })
  }, [toast, activityLogLimit])

  useEffect(() => {
    let cancelled = false
    async function loadHealth() {
      try {
        const res = await fetch('/api/health')
        if (!res.ok) return
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
        if (!contentType.includes('application/json')) {
          if (!cancelled) {
            setAiReady(false)
            setAiError(`${ui.errApiBadJson}. ${ui.errApiActionHint}`)
          }
          return
        }
        const data = (await res.json()) as {
          worker?: {
            device?: string
            ready?: boolean
            error?: string | null
            warning?: string | null
            requestedDevice?: 'auto' | 'cpu' | 'cuda'
            cudaAvailable?: boolean | null
          }
        }
        const device = data.worker?.device
        const ready = data.worker?.ready
        const error = data.worker?.error
        const requestedDevice = data.worker?.requestedDevice
        const cudaAvail = data.worker?.cudaAvailable
        if (!cancelled && device) {
          setAiDevice(device)
        }
        if (!cancelled && typeof ready === 'boolean') {
          setAiReady(ready)
        }
        if (!cancelled) {
          setAiError(error ?? null)
          if (requestedDevice === 'auto' || requestedDevice === 'cpu' || requestedDevice === 'cuda') {
            setAiRequestedDevice(requestedDevice)
          }
          if (typeof cudaAvail === 'boolean' || cudaAvail === null) {
            setCudaAvailable(cudaAvail ?? null)
          }
        }
      } catch {
        // ignore
      }
    }
    void loadHealth()
    const t = window.setInterval(loadHealth, 7000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [])

  useEffect(() => {
    const tr = transformerRef.current
    if (!tr) return
    if (!active || selectedTextIds.length === 0 || !!editingTextId || tool !== 'text') {
      tr.nodes([])
      tr.getLayer()?.batchDraw()
      return
    }
    const nodes = selectedTextIds
      .map((id) => textNodeRefs.current[id])
      .filter((node): node is Konva.Text => !!node)
    if (nodes.length > 0) {
      tr.nodes(nodes)
      tr.getLayer()?.batchDraw()
    } else {
      tr.nodes([])
      tr.getLayer()?.batchDraw()
    }
  }, [activeId, selectedTextId, selectedTextIds, active, editingTextId, tool])

  useEffect(() => {
    if (!active) {
      clearTextSelection()
      setSelectionMaskDataUrl(null)
      setSelectionMaskImage(null)
      setSelectionMaskBounds(null)
      return
    }
    setSelectedTextIds((prev) => prev.filter((id) => active.texts.some((t) => t.id === id)))
    if (selectedTextId && !active.texts.some((t) => t.id === selectedTextId)) {
      clearTextSelection()
    }
  }, [active, selectedTextId])

  useEffect(() => {
    if (!active || !selectionMaskDataUrl) {
      setSelectionMaskImage(null)
      setSelectionMaskBounds(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const maskImage = await loadHtmlImage(selectionMaskDataUrl)
        if (cancelled) return

        const canvas = document.createElement('canvas')
        canvas.width = active.width
        canvas.height = active.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)
        ctx.drawImage(maskImage, 0, 0, active.width, active.height)
        const imageData = ctx.getImageData(0, 0, active.width, active.height)
        const bounds = findNonZeroMaskBounds(imageData.data, active.width, active.height)
        setSelectionMaskBounds(bounds)

        // Recolor mask to blue overlay (dodger blue, alpha=160 for selected pixels)
        const colored = ctx.createImageData(active.width, active.height)
        for (let i = 0; i < imageData.data.length; i += 4) {
          if ((imageData.data[i] ?? 0) > 8) {
            colored.data[i] = 30; colored.data[i + 1] = 144; colored.data[i + 2] = 255; colored.data[i + 3] = 160
          } else {
            colored.data[i + 3] = 0
          }
        }
        const displayCanvas = document.createElement('canvas')
        displayCanvas.width = active.width
        displayCanvas.height = active.height
        const displayCtx = displayCanvas.getContext('2d')
        if (!displayCtx) throw new Error(ERR_CANVAS_UNAVAILABLE)
        displayCtx.putImageData(colored, 0, 0)
        const coloredImg = await loadHtmlImage(displayCanvas.toDataURL('image/png'))
        if (cancelled) return
        setSelectionMaskImage(coloredImg)
      } catch {
        if (cancelled) return
        setSelectionMaskImage(null)
        setSelectionMaskBounds(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, selectionMaskDataUrl])

  useEffect(() => {
    const hasSelection = !!selectionMaskBounds || !!marqueeRect
    if (tool !== 'select' || !hasSelection) { setAntsDashOffset(0); return }
    const id = setInterval(() => setAntsDashOffset((d) => (d + 1) % 16), 60)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, !!selectionMaskBounds, !!marqueeRect])

  useEffect(() => {
    if (tool === 'crop') return
    setCropPreset('free')
    setCropPreviewDataUrl(null)
    setCropCompareDragging(false)
    setCropHoverHandle(null)
    cropStartRef.current = null
    cropResizeRef.current = null
  }, [tool])

  useEffect(() => {
    if (!pendingMaskAction) return
    if (!active || pendingMaskAction.assetId !== active.id) {
      setPendingMaskAction(null)
      return
    }
    if (tool !== 'restore' && tool !== 'eraser') {
      setPendingMaskAction(null)
      updateActive((a) => ({ ...a, maskStrokes: [] }))
    }
  }, [pendingMaskAction, active, tool])

  useEffect(() => {
    if (tool !== 'text' && textInsertArmed) setTextInsertArmed(false)
  }, [tool, textInsertArmed])

  useEffect(() => {
    if (tool === 'move') return
    movePanRef.current = null
    stopMoveMomentum()
  }, [tool])

  useEffect(() => {
    if (!cropCompareDragging) return
    const onMove = (event: PointerEvent) => {
      const frame = cropCompareFrameRef.current
      if (!frame) return
      const box = frame.getBoundingClientRect()
      const ratio = clamp(((event.clientX - box.left) / Math.max(1, box.width)) * 100, 0, 100)
      setCropPreviewCompare(Math.round(ratio))
    }
    const onUp = () => setCropCompareDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [cropCompareDragging])

  useEffect(() => {
    if (dragGuides.x === undefined && dragGuides.y === undefined) {
      setGuidePulse(0.82)
      return
    }
    let raf = 0
    const animate = () => {
      const t = performance.now()
      const wave = (Math.sin(t / 210) + 1) / 2
      setGuidePulse(0.66 + wave * 0.32)
      raf = window.requestAnimationFrame(animate)
    }
    raf = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(raf)
  }, [dragGuides.x, dragGuides.y])

  useEffect(() => {
    if (!editingTextId) return
    const raf = window.requestAnimationFrame(() => {
      inlineEditorRef.current?.focus()
      inlineEditorRef.current?.select()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [editingTextId])

  useEffect(() => {
    return () => {
      stopMoveMomentum()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      if (e.code !== 'Space') return
      e.preventDefault()
      if (!spacePanPressedRef.current) {
        spacePanPressedRef.current = true
        setSpacePanActive(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spacePanPressedRef.current = false
      setSpacePanActive(false)
    }
    const onBlur = () => {
      spacePanPressedRef.current = false
      setSpacePanActive(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return
      }

      const key = e.key.toLowerCase()
      const meta = e.metaKey || e.ctrlKey

      if (exportDialogOpen && key === 'escape') {
        e.preventDefault()
        setExportDialogOpen(false)
        return
      }

      if (showShortcutsHelp && key === 'escape') {
        e.preventDefault()
        setShowShortcutsHelp(false)
        return
      }

      if (key === '?' || key === 'f1') {
        e.preventDefault()
        setShowShortcutsHelp((prev) => !prev)
        return
      }

      if (key === 'i') {
        e.preventDefault()
        invertAssetSelection()
        return
      }

      if (e.altKey && key === 'l') {
        e.preventDefault()
        clearActivityLog()
        return
      }

      if ((tool === 'text' || tool === 'move') && selectedText && !editingTextId && key === 'enter') {
        e.preventDefault()
        if (!selectedText.locked) beginInlineEdit(selectedText)
        return
      }

      if ((tool === 'text' || tool === 'move') && active && selectedTextIds.length > 0 && !editingTextId) {
        if (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown') {
          e.preventDefault()
          const step = e.shiftKey ? 10 : 1
          let dx = 0
          let dy = 0
          if (key === 'arrowleft') dx = -step
          if (key === 'arrowright') dx = step
          if (key === 'arrowup') dy = -step
          if (key === 'arrowdown') dy = step
          updateActiveWithHistory('Move text layer', (a) => ({
            ...a,
            texts: a.texts.map((t) =>
              selectedTextIds.includes(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t,
            ),
          }))
          return
        }
      }

      if (tool === 'crop' && active && cropRect) {
        if (key === 'escape') {
          e.preventDefault()
          clearCropSelection(ui.cancelCrop)
          return
        }
        if (key === 'enter' && !busy) {
          e.preventDefault()
          void applyCrop()
          return
        }
        if (key === 'p' && !busy) {
          e.preventDefault()
          void previewCrop()
          return
        }
        if (key === '0') {
          e.preventDefault()
          applyCropPreset('full')
          return
        }
        if (cropPreviewDataUrl && (key === '[' || key === ']')) {
          e.preventDefault()
          const delta = key === '[' ? -(e.shiftKey ? 10 : 2) : (e.shiftKey ? 10 : 2)
          adjustCropPreviewCompare(delta)
          return
        }
        if (cropPreviewDataUrl && (key === '1' || key === '2' || key === '3' || key === 'r')) {
          e.preventDefault()
          if (key === '1') setCropPreviewCompare(25)
          else if (key === '2') setCropPreviewCompare(50)
          else if (key === '3') setCropPreviewCompare(75)
          else setCropPreviewCompare(55)
          return
        }
        if (cropPreviewDataUrl && (key === 'home' || key === 'end')) {
          e.preventDefault()
          setCropPreviewCompare(key === 'home' ? 0 : 100)
          return
        }
        if (cropPreviewDataUrl && (key === '-' || key === '=' || key === '+')) {
          e.preventDefault()
          const delta = key === '-' ? -(e.shiftKey ? 15 : 5) : (e.shiftKey ? 15 : 5)
          adjustCropPreviewCompare(delta)
          return
        }

        const step = e.shiftKey ? 10 : 1
        if (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown') {
          e.preventDefault()
          if (e.altKey) {
            let dw = 0
            let dh = 0
            if (key === 'arrowleft') dw = -step
            if (key === 'arrowright') dw = step
            if (key === 'arrowup') dh = -step
            if (key === 'arrowdown') dh = step
            nudgeCropSize(dw, dh)
          } else {
            let dx = 0
            let dy = 0
            if (key === 'arrowleft') dx = -step
            if (key === 'arrowright') dx = step
            if (key === 'arrowup') dy = -step
            if (key === 'arrowdown') dy = step
            nudgeCropPosition(dx, dy)
          }
          return
        }
      }

      if (key === 'escape' && selectedAssetIds.length > 0) {
        e.preventDefault()
        setSelectedAssetIds([])
        setStatus(ui.selectionCleared)
        return
      }

      if (meta && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoRestore()
        return
      }
      if (meta && ((key === 'z' && e.shiftKey) || key === 'y')) {
        e.preventDefault()
        redoRestore()
        return
      }
      if (meta && key === 'd' && selectedTextIds.length > 0) {
        e.preventDefault()
        duplicateSelectedTextLayers()
        return
      }
      if (key === 'g') {
        e.preventDefault()
        setShowGrid((p) => !p)
        return
      }
      if ((key === '=' || key === '+') && tool !== 'crop') {
        e.preventDefault()
        zoomBy(0.1)
        return
      }
      if (key === '-' && tool !== 'crop') {
        e.preventDefault()
        zoomBy(-0.1)
        return
      }
      if ((e.ctrlKey || e.metaKey) && key === '0') {
        e.preventDefault()
        setZoom(1); setCanvasOffset({ x: 0, y: 0 })
        return
      }
      if (key === 'f' && selectionMaskBounds) {
        e.preventDefault()
        fitViewToRect(selectionMaskBounds)
        return
      }
      if (key === 't') {
        e.preventDefault()
        setTool('text')
        return
      }
      if (key === 'n') {
        e.preventDefault()
        setTool('text')
        setTextInsertArmed(true)
        setStatus(ui.textInsertArmed)
        return
      }
      if (key === 'b') {
        e.preventDefault()
        setTool('restore')
        return
      }
      if (key === 's') {
        e.preventDefault()
        setTool('select')
        return
      }
      if (key === 'c') {
        e.preventDefault()
        setTool('crop')
        return
      }
      if (key === 'm') {
        e.preventDefault()
        setTool('move')
        return
      }
      if (key === 'e') {
        e.preventDefault()
        setTool('eraser')
        return
      }
      if ((key === 'delete' || key === 'backspace') && selectedText) {
        if (selectedText.locked) return
        e.preventDefault()
        const id = selectedText.id
        updateActiveWithHistory('Delete text layer', (a) => ({ ...a, texts: a.texts.filter((t) => t.id !== id) }))
        clearTextSelection()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedText, selectedTextIds, active, cropRect, cropPreviewDataUrl, tool, busy, selectedAssetIds.length, ui.selectionCleared, ui.cancelCrop, ui.textInsertArmed, exportDialogOpen, showShortcutsHelp, selectionMaskBounds])

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const handleFilesRef = useRef<(files: FileList | null) => Promise<void>>(async () => { /* noop */ })

  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length === 0) return
      e.preventDefault()
      const list = new DataTransfer()
      files.forEach((f) => list.items.add(f))
      await handleFilesRef.current(list.files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(ui.importing)
    setStatus(ui.importingStatus)
    try {
      const imported: PageAsset[] = []
      for (const file of Array.from(files)) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pages = await importPdfFile(file)
          for (const p of pages) {
            imported.push({
              id: uid('page'),
              name: p.name,
              width: p.width,
              height: p.height,
              baseDataUrl: p.dataUrl,
              maskStrokes: [],
              groups: [{ ...DEFAULT_GROUP }],
              texts: [],
            })
          }
        } else if (file.type.startsWith('image/')) {
          const img = await importImageFile(file)
          imported.push({
            id: uid('img'),
            name: img.name,
            width: img.width,
            height: img.height,
            baseDataUrl: img.dataUrl,
            maskStrokes: [],
            groups: [{ ...DEFAULT_GROUP }],
            texts: [],
          })
        }
      }

      setAssets((prev) => {
        const next = [...prev, ...imported]
        return next
      })
      if (!activeId && imported[0]) setActiveId(imported[0].id)
      setStatus(ui.imported(imported.length))
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
    } finally {
      setBusy(null)
    }
  }

  handleFilesRef.current = handleFiles

  function cloneAsset(asset: PageAsset): PageAsset {
    return {
      ...asset,
      maskStrokes: asset.maskStrokes.map((stroke) => ({
        ...stroke,
        points: [...stroke.points],
      })),
      groups: asset.groups.map((group) => ({ ...group })),
      texts: asset.texts.map((text) => ({ ...text })),
    }
  }

  function snapshotAssetList(sourceAssets = assets, sourceActiveId = activeId): AssetListSnapshot {
    return {
      assets: sourceAssets.map(cloneAsset),
      activeId: sourceActiveId,
    }
  }

  function pushAssetListHistory(label: string, snapshot: AssetListSnapshot) {
    const entry: AssetListHistoryEntry = {
      label,
      snapshot,
      timestamp: Date.now(),
    }
    setAssetListHistoryPast((prev) => [...prev, entry].slice(-80))
    setAssetListHistoryFuture([])
  }

  function restoreAssetListSnapshot(snapshot: AssetListSnapshot) {
    setAssets(snapshot.assets.map(cloneAsset))
    setActiveId(snapshot.activeId)
    clearTextSelection()
  }

  function undoAssetListChange() {
    const prev = assetListHistoryPast[assetListHistoryPast.length - 1]
    if (!prev) return false
    const current = snapshotAssetList()
    restoreAssetListSnapshot(prev.snapshot)
    setAssetListHistoryPast((past) => past.slice(0, -1))
    setAssetListHistoryFuture((future) => [...future, { label: prev.label, snapshot: current, timestamp: Date.now() }].slice(-80))
    return true
  }

  function redoAssetListChange() {
    const next = assetListHistoryFuture[assetListHistoryFuture.length - 1]
    if (!next) return false
    const current = snapshotAssetList()
    restoreAssetListSnapshot(next.snapshot)
    setAssetListHistoryFuture((future) => future.slice(0, -1))
    setAssetListHistoryPast((past) => [...past, { label: next.label, snapshot: current, timestamp: Date.now() }].slice(-80))
    return true
  }

  function removeAsset(id: string) {
    const currentIndex = assets.findIndex((a) => a.id === id)
    if (currentIndex < 0) return
    pushAssetListHistory('Remove asset', snapshotAssetList())
    const next = assets.filter((a) => a.id !== id)
    setAssets(next)
    if (activeId === id) {
      const fallback = next[currentIndex] ?? next[currentIndex - 1] ?? null
      setActiveId(fallback ? fallback.id : null)
    }
  }

  function clearAllAssets() {
    if (assets.length === 0) return
    pushAssetListHistory('Clear all assets', snapshotAssetList())
    setAssets([])
    setActiveId(null)
    clearTextSelection()
    setStatus(ui.done)
  }

  function reorderAssets(sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    const sourceIndex = assets.findIndex((a) => a.id === sourceId)
    const targetIndex = assets.findIndex((a) => a.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    pushAssetListHistory('Reorder assets', snapshotAssetList())
    const next = [...assets]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved)
    setAssets(next)
  }

  function updateCropField(field: 'x' | 'y' | 'width' | 'height', value: number) {
    if (!active) return
    const base = cropRect ?? {
      x: Math.round(active.width * 0.1),
      y: Math.round(active.height * 0.1),
      width: Math.round(active.width * 0.8),
      height: Math.round(active.height * 0.8),
    }
    const next = normalizeCropRect({ ...base, [field]: Number.isFinite(value) ? value : 0 }, active.width, active.height)
    setCropRect(next)
    setCropPreset('free')
    setCropPreviewDataUrl(null)
  }

  function applyCropPreset(nextPreset: CropPreset) {
    if (!active) return
    if (nextPreset === 'full') {
      setCropRect({ x: 0, y: 0, width: active.width, height: active.height })
      setCropPreset('full')
      setCropPreviewDataUrl(null)
      return
    }
    if (nextPreset === 'free') {
      setCropRect({
        x: Math.round(active.width * 0.1),
        y: Math.round(active.height * 0.1),
        width: Math.max(1, Math.round(active.width * 0.8)),
        height: Math.max(1, Math.round(active.height * 0.8)),
      })
      setCropPreset('free')
      setCropPreviewDataUrl(null)
      return
    }
    const ratio = nextPreset === '1:1' ? 1 : nextPreset === '4:3' ? 4 / 3 : 16 / 9
    const base = activeCropRect ?? {
      x: Math.round(active.width * 0.1),
      y: Math.round(active.height * 0.1),
      width: Math.round(active.width * 0.8),
      height: Math.round(active.height * 0.8),
    }
    const centerX = base.x + base.width / 2
    const centerY = base.y + base.height / 2

    let width = clamp(Math.round(base.width), 1, active.width)
    let height = Math.max(1, Math.round(width / ratio))
    if (height > active.height) {
      height = active.height
      width = Math.max(1, Math.round(height * ratio))
    }
    if (width > active.width) {
      width = active.width
      height = Math.max(1, Math.round(width / ratio))
    }

    const x = clamp(Math.round(centerX - width / 2), 0, Math.max(0, active.width - width))
    const y = clamp(Math.round(centerY - height / 2), 0, Math.max(0, active.height - height))
    setCropRect(normalizeCropRect({ x, y, width, height }, active.width, active.height))
    setCropPreset(nextPreset)
    setCropPreviewDataUrl(null)
  }

  function nudgeCropPosition(dx: number, dy: number) {
    if (!active || !activeCropRect) return
    setCropRect(normalizeCropRect({ ...activeCropRect, x: activeCropRect.x + dx, y: activeCropRect.y + dy }, active.width, active.height))
    setCropPreset('free')
    setCropPreviewDataUrl(null)
  }

  function nudgeCropSize(dw: number, dh: number) {
    if (!active || !activeCropRect) return
    setCropRect(
      normalizeCropRect(
        {
          ...activeCropRect,
          width: clamp(activeCropRect.width + dw, 1, active.width - activeCropRect.x),
          height: clamp(activeCropRect.height + dh, 1, active.height - activeCropRect.y),
        },
        active.width,
        active.height,
      ),
    )
    setCropPreset('free')
    setCropPreviewDataUrl(null)
  }

  function onCropComparePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const frame = cropCompareFrameRef.current
    if (!frame) return
    const box = frame.getBoundingClientRect()
    const ratio = clamp(((event.clientX - box.left) / Math.max(1, box.width)) * 100, 0, 100)
    setCropPreviewCompare(Math.round(ratio))
    setCropCompareDragging(true)
  }

  function onCropCompareDoubleClick() {
    setCropPreviewCompare(55)
  }

  function adjustCropPreviewCompare(delta: number) {
    setCropPreviewCompare((prev) => clamp(prev + delta, 0, 100))
  }

  function onCropCompareWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    const delta = event.deltaY > 0 ? -2 : 2
    adjustCropPreviewCompare(event.shiftKey ? delta * 3 : delta)
  }

  function onCropCompareKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const key = event.key
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault()
      adjustCropPreviewCompare((key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 3))
      return
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault()
      setCropPreviewCompare(key === 'Home' ? 0 : 100)
    }
  }

  function clearCropSelection(nextStatus?: string) {
    setCropRect(null)
    setCropPreset('free')
    setCropPreviewDataUrl(null)
    setCropPreviewCompare(55)
    setCropCompareDragging(false)
    setCropHoverHandle(null)
    cropStartRef.current = null
    cropResizeRef.current = null
    if (nextStatus) setStatus(nextStatus)
  }

  async function applyCrop() {
    if (!active || !cropRect) return
    const rect = normalizeCropRect(cropRect, active.width, active.height)
    if (rect.width < 2 || rect.height < 2) return
    setBusy(ui.applyCrop)
    try {
      const source = await loadHtmlImage(active.baseDataUrl)
      const canvas = document.createElement('canvas')
      canvas.width = rect.width
      canvas.height = rect.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.drawImage(
        source,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      )

      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error(ERR_PNG_CONVERT_FAILED)
      const nextUrl = await blobToDataUrl(blob)

      updateActiveWithHistory('Crop asset', (a) => {
        const right = rect.x + rect.width
        const bottom = rect.y + rect.height
        const nextTexts = a.texts
          .filter((t) => t.x >= rect.x && t.x <= right && t.y >= rect.y && t.y <= bottom)
          .map((t) => ({ ...t, x: t.x - rect.x, y: t.y - rect.y }))
        const usedGroups = new Set(nextTexts.map((t) => t.groupId))
        const nextGroups = a.groups.filter((g) => g.id === DEFAULT_GROUP.id || usedGroups.has(g.id))
        return {
          ...a,
          width: rect.width,
          height: rect.height,
          baseDataUrl: nextUrl,
          texts: nextTexts,
          groups: nextGroups.length > 0 ? nextGroups : [{ ...DEFAULT_GROUP }],
          maskStrokes: [],
        }
      })

      clearTextSelection()
      setDragGuides({})
      setDragMetrics(null)
      clearCropSelection()
      setStatus(ui.cropDone)
    } finally {
      setBusy(null)
    }
  }

  async function previewCrop() {
    if (!active || !cropRect) return
    const rect = normalizeCropRect(cropRect, active.width, active.height)
    if (rect.width < 2 || rect.height < 2) return
    try {
      const source = await loadHtmlImage(active.baseDataUrl)
      const canvas = document.createElement('canvas')
      canvas.width = rect.width
      canvas.height = rect.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.drawImage(
        source,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      )
      setCropPreviewDataUrl(canvas.toDataURL('image/png'))
      setCropPreviewCompare(55)
      setStatus(ui.cropPreviewTitle)
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
    }
  }

  function hasFilePayload(dt: DataTransfer): boolean {
    return Array.from(dt.types).includes('Files')
  }

  function onDragOverRoot(e: DragEvent<HTMLDivElement>) {
    if (!hasFilePayload(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!isFileDragOver) setIsFileDragOver(true)
  }

  function onDragLeaveRoot(e: DragEvent<HTMLDivElement>) {
    if (!hasFilePayload(e.dataTransfer)) return
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    setIsFileDragOver(false)
  }

  function onDropRoot(e: DragEvent<HTMLDivElement>) {
    if (!hasFilePayload(e.dataTransfer)) return
    e.preventDefault()
    setIsFileDragOver(false)
    void handleFiles(e.dataTransfer.files)
  }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) return
      event.preventDefault()
      zoomFromWheelAtClient(event.deltaY, event.clientX, event.clientY)
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [wrapRef, active, canvasZoom, fit.ox, fit.oy, wrapSize.w, wrapSize.h, zoomWheelSensitivity])

  function onAssetDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    setDragAssetId(id)
    setDragOverAssetId(id)
    e.dataTransfer.effectAllowed = 'move'
  }

  function onAssetDragEnter(e: DragEvent<HTMLDivElement>, targetId: string) {
    e.preventDefault()
    if (!dragAssetId || dragAssetId === targetId) return
    setDragOverAssetId(targetId)
  }

  function onAssetDrop(e: DragEvent<HTMLDivElement>, targetId: string) {
    e.preventDefault()
    if (!dragAssetId) return
    reorderAssets(dragAssetId, targetId)
    setDragAssetId(null)
    setDragOverAssetId(null)
  }

  function updateActive(mutator: (a: PageAsset) => PageAsset) {
    if (!active) return
    setAssets((prev) => prev.map((a) => (a.id === active.id ? mutator(a) : a)))
  }

  function snapshotFrom(a: PageAsset): PageSnapshot {
    return {
      width: a.width,
      height: a.height,
      baseDataUrl: a.baseDataUrl,
      texts: a.texts.map((t) => ({ ...t })),
      groups: a.groups.map((g) => ({ ...g })),
    }
  }

  function serializeSnapshot(s: PageSnapshot): string {
    return JSON.stringify(s)
  }

  function parseSnapshot(raw: string): PageSnapshot | null {
    try {
      const parsed = JSON.parse(raw) as PageSnapshot
      if (
        !parsed ||
        typeof parsed.baseDataUrl !== 'string' ||
        typeof parsed.width !== 'number' ||
        typeof parsed.height !== 'number' ||
        !Array.isArray(parsed.texts) ||
        !Array.isArray(parsed.groups)
      ) {
        return null
      }
      return {
        width: parsed.width,
        height: parsed.height,
        baseDataUrl: parsed.baseDataUrl,
        texts: parsed.texts.map((t) => ({ ...t })),
        groups: parsed.groups.map((g) => ({ ...g })),
      }
    } catch {
      return null
    }
  }

  function updateAssetByIdWithHistory(assetId: string, label: string, mutator: (a: PageAsset) => PageAsset) {
    pushAssetListHistory(label, snapshotAssetList())
    setAssets((prev) => prev.map((a) => (a.id === assetId ? mutator(a) : a)))
  }

  function updateActiveWithHistory(label: string, mutator: (a: PageAsset) => PageAsset) {
    if (!active) return
    updateAssetByIdWithHistory(active.id, label, mutator)
  }

  function toggleLayerVisible(id: string) {
    updateActiveWithHistory('Toggle layer visibility', (a) => ({
      ...a,
      texts: a.texts.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t)),
    }))
  }

  function toggleLayerLocked(id: string) {
    updateActiveWithHistory('Toggle layer lock', (a) => ({
      ...a,
      texts: a.texts.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)),
    }))
  }

  function moveLayer(id: string, direction: 'up' | 'down') {
    updateActiveWithHistory('Move layer', (a) => {
      const idx = a.texts.findIndex((t) => t.id === id)
      if (idx < 0) return a
      const target = direction === 'up' ? idx - 1 : idx + 1
      if (target < 0 || target >= a.texts.length) return a
      const texts = [...a.texts]
      const [item] = texts.splice(idx, 1)
      texts.splice(target, 0, item)
      return { ...a, texts }
    })
  }

  const historyTimeline = useMemo(() => {
    if (assets.length === 0 && assetListHistoryPast.length === 0 && assetListHistoryFuture.length === 0) {
      return [] as { key: string; label: string; active: boolean; snapshot: AssetListSnapshot | null; kind: 'past' | 'current' | 'future'; sourceIndex: number }[]
    }
    const past = assetListHistoryPast.map((h, idx) => ({
      key: `p-${idx}-${h.timestamp}`,
      label: h.label,
      active: false,
      snapshot: h.snapshot,
      kind: 'past' as const,
      sourceIndex: idx,
    }))
    const currentSnapshot = snapshotAssetList()
    const current = [{ key: 'current', label: 'Current', active: true, snapshot: currentSnapshot, kind: 'current' as const, sourceIndex: -1 }]
    const future = [...assetListHistoryFuture]
      .reverse()
      .map((h, idx) => ({
        key: `f-${idx}-${h.timestamp}`,
        label: h.label,
        active: false,
        snapshot: h.snapshot,
        kind: 'future' as const,
        sourceIndex: assetListHistoryFuture.length - 1 - idx,
      }))
    return [...past, ...current, ...future]
  }, [assets, activeId, assetListHistoryPast, assetListHistoryFuture])

  const filteredHistoryTimeline = useMemo(() => {
    const query = historyQuery.trim().toLowerCase()
    if (!query) return historyTimeline.map((item, index) => ({ item, index }))
    return historyTimeline
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => localizeHistoryLabel(item.label).toLowerCase().includes(query))
  }, [historyTimeline, historyQuery])

  function addHistoryCheckpoint() {
    pushAssetListHistory('Manual checkpoint', snapshotAssetList())
    setStatus(ui.historyManualCheckpoint)
  }

  function localizeHistoryLabel(label: string) {
    const map: Record<string, string> = {
      Current: ui.historyCurrent,
      'Add text layer': ui.historyAddText,
      'Update text': ui.historyUpdateText,
      'Edit text inline': ui.historyEditInline,
      'Delete text layer': ui.historyDeleteText,
      'Move text layer': ui.historyMoveText,
      'Transform text layer': ui.historyTransformText,
      'Clear texts': ui.historyClearTexts,
      'Toggle layer visibility': ui.historyToggleVisible,
      'Toggle layer lock': ui.historyToggleLock,
      'Move layer': ui.historyMoveLayer,
      'Crop asset': ui.historyCrop,
      'AI restore': ui.historyAiRestore,
      'AI eraser': ui.historyAiEraser,
      'Remove asset': ui.historyRemoveAsset,
      'Reorder assets': ui.historyReorderAssets,
      'Clear all assets': ui.historyClearAssets,
      'Jump checkpoint': ui.historyJumpCheckpoint,
      'Undo checkpoint': ui.historyUndoCheckpoint,
      'Redo checkpoint': ui.historyRedoCheckpoint,
      'Manual checkpoint': ui.historyManualCheckpoint,
    }
    return map[label] ?? label
  }

  function deleteHistoryEntry(index: number) {
    const item = historyTimeline[index]
    if (!item || item.kind === 'current') return
    if (item.kind === 'past') {
      setAssetListHistoryPast((prev) => prev.filter((_, idx) => idx !== item.sourceIndex))
      return
    }
    setAssetListHistoryFuture((prev) => prev.filter((_, idx) => idx !== item.sourceIndex))
  }

  function jumpToHistory(index: number) {
    const currentIndex = assetListHistoryPast.length
    if (index === currentIndex) return
    if (index < 0 || index >= historyTimeline.length) return

    const target = historyTimeline[index]
    const targetSnapshot = target?.snapshot
    if (!targetSnapshot) return

    const current = snapshotAssetList()
    const merged = [
      ...assetListHistoryPast,
      { label: 'Jump checkpoint', snapshot: current, timestamp: Date.now() },
      ...[...assetListHistoryFuture].reverse(),
    ]
    const nextPast = merged.slice(0, index)
    const nextFuture = merged.slice(index + 1).reverse()
    restoreAssetListSnapshot(targetSnapshot)
    setAssetListHistoryPast(nextPast)
    setAssetListHistoryFuture(nextFuture)
  }

  function undoRestore() {
    if (undoAssetListChange()) {
      setStatus(ui.undoAction)
    }
  }

  function redoRestore() {
    if (redoAssetListChange()) {
      setStatus(ui.redoAction)
    }
  }

  function addTextAt(x: number, y: number): TextItem | null {
    if (!active) return null
    const item: TextItem = {
      id: uid('text'),
      x,
      y,
      ...DEFAULT_TEXT,
      groupId: DEFAULT_GROUP.id,
    }
    updateActiveWithHistory('Add text layer', (a) => ({ ...a, texts: [...a.texts, item] }))
    selectTextLayer(item.id)
    return item
  }

  function clearTextSelection() {
    setSelectedTextId(null)
    setSelectedTextIds([])
  }

  function selectTextLayer(id: string, additive = false) {
    if (!additive) {
      setSelectedTextId(id)
      setSelectedTextIds([id])
      return
    }
    setSelectedTextIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((v) => v !== id)
        if (selectedTextId === id) setSelectedTextId(next[0] ?? null)
        return next
      }
      const next = [...prev, id]
      setSelectedTextId(id)
      return next
    })
  }

  function addTextFromMenu() {
    if (!active) return
    const x = clamp(Math.round(active.width * 0.5), 0, active.width - 1)
    const y = clamp(Math.round(active.height * 0.5), 0, active.height - 1)
    const created = addTextAt(x, y)
    if (created && !created.locked) beginInlineEdit(created)
  }

  function duplicateSelectedTextLayers() {
    if (!active || selectedTextIds.length === 0) return
    const selectedSet = new Set(selectedTextIds)
    updateActiveWithHistory('Add text layer', (a) => {
      const clones = a.texts
        .filter((t) => selectedSet.has(t.id))
        .map((t) => ({ ...t, id: uid('text'), x: t.x + 24, y: t.y + 24, locked: false }))
      return { ...a, texts: [...a.texts, ...clones] }
    })
  }

  function alignSelectedTextLayers(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    if (!active || selectedTextIds.length === 0) return
    const selectedSet = new Set(selectedTextIds)
    const selected = active.texts.filter((t) => selectedSet.has(t.id))
    if (selected.length === 0) return

    const minX = Math.min(...selected.map((t) => t.x))
    const maxX = Math.max(...selected.map((t) => t.x))
    const minY = Math.min(...selected.map((t) => t.y))
    const maxY = Math.max(...selected.map((t) => t.y))
    const midX = (minX + maxX) / 2
    const midY = (minY + maxY) / 2

    updateActiveWithHistory('Move text layer', (a) => ({
      ...a,
      texts: a.texts.map((t) => {
        if (!selectedSet.has(t.id) || t.locked) return t
        if (mode === 'left') return { ...t, x: minX }
        if (mode === 'center') return { ...t, x: midX }
        if (mode === 'right') return { ...t, x: maxX }
        if (mode === 'top') return { ...t, y: minY }
        if (mode === 'middle') return { ...t, y: midY }
        return { ...t, y: maxY }
      }),
    }))
  }

  function resolveMaskActionBounds(asset: PageAsset, strokes: MaskStroke[], scope: MaskApplyScope): CropRect | null {
    const full = getInpaintBounds(strokes, asset.width, asset.height)
    if (!full) return null
    if (scope !== 'crop') return full
    const crop = cropRect ? normalizeCropRect(cropRect, asset.width, asset.height) : null
    if (!crop) return full
    return intersectCropRects(full, crop, asset.width, asset.height)
  }

  function cancelPendingMaskAction() {
    if (!active) {
      setPendingMaskAction(null)
      return
    }
    updateActive((a) => ({ ...a, maskStrokes: [] }))
    setPendingMaskAction(null)
  }

  function queueMaskAction(toolKind: 'restore' | 'eraser', strokes: MaskStroke[]) {
    if (!active) return
    const cloned = cloneStrokes(strokes)
    setPendingMaskAction({ tool: toolKind, assetId: active.id, strokes: cloned })
  }

  async function applyPendingMaskAction() {
    if (!pendingMaskAction || !active) return
    const asset = assetsRef.current.find((a) => a.id === pendingMaskAction.assetId)
    if (!asset) {
      setPendingMaskAction(null)
      return
    }
    const boundsOverride = resolveMaskActionBounds(asset, pendingMaskAction.strokes, maskApplyScope)
    if (!boundsOverride) {
      setStatus(ui.maskEmpty)
      setPendingMaskAction(null)
      updateActive((a) => ({ ...a, maskStrokes: [] }))
      return
    }
    if (pendingMaskAction.tool === 'restore') {
      enqueueInpaint(pendingMaskAction.strokes, boundsOverride)
    } else {
      lastEraserMacroTemplateRef.current = normalizeStrokes(pendingMaskAction.strokes, asset.width, asset.height)
      await applyLocalEraserForAsset(asset.id, pendingMaskAction.strokes, boundsOverride)
    }
    setPendingMaskAction(null)
  }

  function updateSelectedText(patch: Partial<TextItem>) {
    if (!active || !selectedTextId) return
    const current = active.texts.find((t) => t.id === selectedTextId)
    if (!current || current.locked) return
    updateActiveWithHistory('Update text', (a) => ({
      ...a,
      texts: a.texts.map((t) => (t.id === selectedTextId ? { ...t, ...patch } : t)),
    }))
  }

function cssColorToPptHex(color: string): string {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const raw = hex[1]!
    if (raw.length === 3) return raw.split('').map((c) => `${c}${c}`).join('').toUpperCase()
    return raw.toUpperCase()
  }
  const rgb = color.match(/\d+/g)?.map(Number)
  if (rgb && rgb.length >= 3) {
    const r = clamp(Math.round(rgb[0] ?? 0), 0, 255)
    const g = clamp(Math.round(rgb[1] ?? 0), 0, 255)
    const b = clamp(Math.round(rgb[2] ?? 0), 0, 255)
    return [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  return '111827'
}

function estimateTextBoxPx(text: string, item: TextItem, asset: PageAsset): { width: number; height: number } {
  return estimateTextBoxForAsset(text, item, asset)
}

function pointInRotatedRect(
  pointX: number,
  pointY: number,
  rectX: number,
  rectY: number,
  rectW: number,
  rectH: number,
  rotationDeg: number,
): boolean {
  if (Math.abs(rotationDeg) < 0.001) {
    return pointX >= rectX && pointX <= rectX + rectW && pointY >= rectY && pointY <= rectY + rectH
  }

  const rad = (-rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = pointX - rectX
  const dy = pointY - rectY
  const localX = dx * cos - dy * sin
  const localY = dx * sin + dy * cos
  return localX >= 0 && localX <= rectW && localY >= 0 && localY <= rectH
}

function findTextAtPoint(asset: PageAsset, x: number, y: number): TextItem | null {
  const padX = 8
  const padY = 5
  const candidates = [...asset.texts].reverse()
  for (const item of candidates) {
    if (!item.visible) continue
    const box = estimateTextBoxPx(item.text, item, asset)
    const rectX = item.x - padX
    const rectY = item.y - padY
    const rectW = box.width + padX * 2
    const rectH = box.height + padY * 2
    if (pointInRotatedRect(x, y, rectX, rectY, rectW, rectH, item.rotation)) return item
  }
  return null
}

  // Drawing state
  const drawing = useRef<MaskStroke | null>(null)
  const inlineEditorRef = useRef<HTMLTextAreaElement | null>(null)
  const inlineEditOpenedAtRef = useRef(0)
  const inlineEditBlurGuardRef = useRef(false)

  function pointerToImageXY(stage: Konva.Stage, clampToBounds = true) {
    const p = stage.getPointerPosition()
    if (!p || !active) return null
    const x = (p.x - fit.ox) / fit.scale
    const y = (p.y - fit.oy) / fit.scale
    if (!clampToBounds) return { x, y }
    return { x: clamp(x, 0, active.width), y: clamp(y, 0, active.height) }
  }

  function updateBrushCursor(stage: Konva.Stage) {
    if (!active || (tool !== 'restore' && tool !== 'eraser')) {
      if (brushCursor.visible) {
        setBrushCursor((prev) => ({ ...prev, visible: false }))
      }
      return
    }
    const raw = pointerToImageXY(stage, false)
    if (!raw) {
      setBrushCursor((prev) => ({ ...prev, visible: false }))
      return
    }
    const inside = raw.x >= 0 && raw.y >= 0 && raw.x <= active.width && raw.y <= active.height
    setBrushCursor({
      x: clamp(raw.x, 0, active.width),
      y: clamp(raw.y, 0, active.height),
      visible: inside,
    })
  }

  function detectCropHandle(point: { x: number; y: number }, rect: CropRect): CropHandle | null {
    const handles: Array<{ key: CropHandle; x: number; y: number }> = [
      { key: 'nw', x: rect.x, y: rect.y },
      { key: 'ne', x: rect.x + rect.width, y: rect.y },
      { key: 'sw', x: rect.x, y: rect.y + rect.height },
      { key: 'se', x: rect.x + rect.width, y: rect.y + rect.height },
    ]
    const threshold = 12
    for (const handle of handles) {
      if (Math.hypot(point.x - handle.x, point.y - handle.y) <= threshold) return handle.key
    }
    return null
  }

  function resizeCropRectFromHandle(startRect: CropRect, handle: CropHandle, current: { x: number; y: number }, maxW: number, maxH: number): CropRect {
    let left = startRect.x
    let top = startRect.y
    let right = startRect.x + startRect.width
    let bottom = startRect.y + startRect.height

    if (handle === 'nw' || handle === 'sw') {
      left = clamp(current.x, 0, right - 1)
    }
    if (handle === 'ne' || handle === 'se') {
      right = clamp(current.x, left + 1, maxW)
    }
    if (handle === 'nw' || handle === 'ne') {
      top = clamp(current.y, 0, bottom - 1)
    }
    if (handle === 'sw' || handle === 'se') {
      bottom = clamp(current.y, top + 1, maxH)
    }

    return normalizeCropRect(
      {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      maxW,
      maxH,
    )
  }

  function autoPanDuringCrop(stage: Konva.Stage) {
    const pointer = stage.getPointerPosition()
    if (!pointer) return
    const edge = 26
    let dx = 0
    let dy = 0
    if (pointer.x <= edge) dx = 7
    else if (pointer.x >= wrapSize.w - edge) dx = -7
    if (pointer.y <= edge) dy = 7
    else if (pointer.y >= wrapSize.h - edge) dy = -7
    if (dx === 0 && dy === 0) return
    setCanvasOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
  }

  function onStageMouseDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const stage = stageRef.current
    if (!stage || !active || busy) return
    setDragMetrics(null)

    const isMouseEvent = e.evt instanceof MouseEvent
    const mouseButton = 'button' in e.evt ? e.evt.button : 0
    if (mouseButton === 2) return

    const panByModifier = mouseButton === 1 || spacePanPressedRef.current
    if (panByModifier) {
      if (isMouseEvent) e.evt.preventDefault()
      const pointer = stage.getPointerPosition()
      if (!pointer) return
      stopMoveMomentum()
      movePanRef.current = { x: pointer.x, y: pointer.y, ts: performance.now() }
      return
    }

    if (editingTextId) {
      commitInlineEdit()
      return
    }

    const targetClass = e.target.getClassName?.()
    const targetId = e.target.id()

    if (tool === 'move') {
      const textTargetId = targetClass === 'Text'
        ? targetId
        : targetClass === 'Rect' && targetId.startsWith('text-bg:')
          ? targetId.slice('text-bg:'.length)
          : null
      if (textTargetId) {
        const targetText = active.texts.find((t) => t.id === textTargetId)
        if (targetText) {
          const additive = !!(e.evt instanceof MouseEvent && e.evt.shiftKey)
          selectTextLayer(targetText.id, additive)
        }
        return
      }
      const pointer = stage.getPointerPosition()
      if (!pointer) return
      stopMoveMomentum()
      movePanRef.current = { x: pointer.x, y: pointer.y, ts: performance.now() }
      return
    }

    if (targetClass === 'Text' && tool === 'text') {
      const textId = e.target.id()
      const targetText = active.texts.find((t) => t.id === textId)
      if (targetText) {
        const additive = !!(e.evt instanceof MouseEvent && e.evt.shiftKey)
        selectTextLayer(targetText.id, additive)
      }
      return
    }
    if (tool === 'text' && targetClass === 'Rect') {
      const targetId = e.target.id()
      if (targetId.startsWith('text-bg:')) {
        const textId = targetId.slice('text-bg:'.length)
        const targetText = active.texts.find((t) => t.id === textId)
        if (targetText) {
          const additive = !!(e.evt instanceof MouseEvent && e.evt.shiftKey)
          selectTextLayer(targetText.id, additive)
          return
        }
      }
    }

    if (tool === 'crop') {
      const xy = pointerToImageXY(stage)
      if (!xy) return
      const currentRect = activeCropRect
      if (currentRect) {
        const handle = detectCropHandle(xy, currentRect)
        if (handle) {
          setCropPreviewDataUrl(null)
          cropResizeRef.current = {
            handle,
            rect: currentRect,
          }
          return
        }
      }
      cropStartRef.current = { x: xy.x, y: xy.y }
      setCropPreviewDataUrl(null)
      setCropPreset('free')
      setCropRect({ x: xy.x, y: xy.y, width: 1, height: 1 })
      return
    }

    if (tool === 'select') {
      const xy = pointerToImageXY(stage)
      if (!xy) return
      if (selectMode === 'ai') {
        const mode = e.evt.altKey ? 'subtract' : 'add'
        void runSelectionAtPoint(xy.x, xy.y, mode)
      } else if (selectMode === 'lasso') {
        lassoActiveRef.current = true
        setLassoPoints([xy.x, xy.y])
      } else {
        marqueeStartRef.current = { x: xy.x, y: xy.y }
        setMarqueeRect({ x: xy.x, y: xy.y, width: 1, height: 1 })
      }
      return
    }

    if (tool === 'text') {
      const pointer = stage.getPointerPosition()
      let hitText: TextItem | null = null
      if (pointer) {
        const xPad = 8 * fit.scale
        const yPad = 5 * fit.scale
        const ordered = [...active.texts].reverse()
        for (const candidate of ordered) {
          if (!candidate.visible) continue
          const node = textNodeRefs.current[candidate.id]
          if (!node) continue
          const rect = node.getClientRect({ relativeTo: stage })
          const inside =
            pointer.x >= rect.x - xPad &&
            pointer.x <= rect.x + rect.width + xPad &&
            pointer.y >= rect.y - yPad &&
            pointer.y <= rect.y + rect.height + yPad
          if (!inside) continue
          hitText = candidate
          break
        }
      }

      if (!hitText) {
        const xy = pointerToImageXY(stage)
        if (!xy) return
        hitText = findTextAtPoint(active, xy.x, xy.y)
      }

      if (hitText) {
        const additive = !!(e.evt instanceof MouseEvent && e.evt.shiftKey)
        selectTextLayer(hitText.id, additive)
        return
      }

      if (textInsertArmed) {
        const xy = pointerToImageXY(stage)
        if (!xy) return
        const created = addTextAt(xy.x, xy.y)
        setTextInsertArmed(false)
        if (created && !created.locked) beginInlineEdit(created)
        return
      }
      clearTextSelection()
      return
    }

    const xy = pointerToImageXY(stage)
    if (!xy) return
    const id = uid('stroke')
    const stroke: MaskStroke = { id, points: [xy.x, xy.y], strokeWidth: brushSize }
    drawing.current = stroke
    updateActive((a) => ({ ...a, maskStrokes: [stroke] }))
  }

  function onStageDblClick(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const stage = stageRef.current
    if (!stage || !active || busy || tool !== 'text' || !!editingTextId) return

    const targetClass = e.target.getClassName?.()
    const targetId = e.target.id()
    if (targetClass === 'Text') return
    if (targetClass === 'Rect' && targetId.startsWith('text-bg:')) return

    const xy = pointerToImageXY(stage)
    if (!xy) return
    const created = addTextAt(xy.x, xy.y)
    if (created && !created.locked) beginInlineEdit(created)
  }

  function onStageContextMenu(e: Konva.KonvaEventObject<PointerEvent>) {
    const stage = stageRef.current
    if (!stage || !active) return
    e.evt.preventDefault()
    const xy = pointerToImageXY(stage)
    const imageX = xy ? xy.x : Math.round(active.width / 2)
    const imageY = xy ? xy.y : Math.round(active.height / 2)
    setCanvasMenu({ x: e.evt.clientX, y: e.evt.clientY, imageX, imageY })
  }

  function onStageMouseMove() {
    const stage = stageRef.current
    if (!stage || !active) return

    if (movePanRef.current) {
      const pointer = stage.getPointerPosition()
      if (!pointer) return
      const dx = pointer.x - movePanRef.current.x
      const dy = pointer.y - movePanRef.current.y
      const now = performance.now()
      const dt = Math.max(1, now - movePanRef.current.ts)
      moveMomentumRef.current = { vx: dx / dt, vy: dy / dt }
      movePanRef.current = { x: pointer.x, y: pointer.y, ts: now }
      setCanvasOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
      return
    }

    updateBrushCursor(stage)

    if (tool === 'select') {
      if ((selectMode === 'rect' || selectMode === 'ellipse') && marqueeStartRef.current && active) {
        const xy = pointerToImageXY(stage)
        if (!xy) return
        setMarqueeRect(rectFromPoints(marqueeStartRef.current.x, marqueeStartRef.current.y, xy.x, xy.y, active.width, active.height))
        return
      }
      if (selectMode === 'lasso' && lassoActiveRef.current) {
        const xy = pointerToImageXY(stage)
        if (!xy) return
        setLassoPoints((pts) => [...pts, xy.x, xy.y])
        return
      }
    }

    if (tool === 'crop') {
      autoPanDuringCrop(stage)
      const resize = cropResizeRef.current
      if (resize) {
        setCropHoverHandle(resize.handle)
        const xy = pointerToImageXY(stage)
        if (!xy) return
        setCropPreset('free')
        setCropRect(resizeCropRectFromHandle(resize.rect, resize.handle, xy, active.width, active.height))
        return
      }
      if (activeCropRect) {
        const xy = pointerToImageXY(stage)
        if (xy) setCropHoverHandle(detectCropHandle(xy, activeCropRect))
        else setCropHoverHandle(null)
      } else {
        setCropHoverHandle(null)
      }
      const start = cropStartRef.current
      if (start) {
        const xy = pointerToImageXY(stage)
        if (!xy) return
        setCropPreset('free')
        setCropRect(rectFromPoints(start.x, start.y, xy.x, xy.y, active.width, active.height))
      }
      return
    }

    const d = drawing.current
    if (!d || (tool !== 'restore' && tool !== 'eraser')) return
    const xy = pointerToImageXY(stage)
    if (!xy) return
    d.points = [...d.points, xy.x, xy.y]
    drawing.current = d
    updateActive((a) => ({
      ...a,
      maskStrokes: a.maskStrokes.map((s) =>
        s.id === d.id ? { ...s, points: [...s.points, xy.x, xy.y] } : s,
      ),
    }))
  }

  async function onStageMouseUp() {
    const hadMovePan = !!movePanRef.current
    movePanRef.current = null
    if (hadMovePan) startMoveMomentum()

    if (tool === 'select' && marqueeStartRef.current) {
      marqueeStartRef.current = null
      const rect = marqueeRect
      setMarqueeRect(null)
      if (!rect || !active || rect.width < 2 || rect.height < 2) return
      const canvas = document.createElement('canvas')
      canvas.width = active.width; canvas.height = active.height
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'white'
      if (selectMode === 'rect') {
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      } else {
        ctx.beginPath()
        ctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2)
        ctx.fill()
      }
      const newMaskUrl = canvas.toDataURL('image/png')
      setSelectionMaskDataUrl(newMaskUrl)
      const imgData = ctx.getImageData(0, 0, active.width, active.height)
      const bounds = findNonZeroMaskBounds(imgData.data, active.width, active.height)
      setSelectionMaskBounds(bounds)
      return
    }

    if (tool === 'select' && lassoActiveRef.current) {
      lassoActiveRef.current = false
      const points = lassoPoints
      setLassoPoints([])
      if (!active || points.length < 6) return
      const canvas = document.createElement('canvas')
      canvas.width = active.width; canvas.height = active.height
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'white'
      ctx.beginPath()
      ctx.moveTo(points[0]!, points[1]!)
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i]!, points[i + 1]!)
      ctx.closePath()
      ctx.fill()
      const newMaskUrl = canvas.toDataURL('image/png')
      setSelectionMaskDataUrl(newMaskUrl)
      const imgData = ctx.getImageData(0, 0, active.width, active.height)
      const bounds = findNonZeroMaskBounds(imgData.data, active.width, active.height)
      setSelectionMaskBounds(bounds)
      return
    }

    if (tool === 'crop') {
      cropStartRef.current = null
      cropResizeRef.current = null
      setCropHoverHandle(null)
      return
    }
    const stroke = drawing.current
    drawing.current = null
    if (!stroke) return
    if (tool === 'restore') {
      queueMaskAction('restore', [stroke])
      return
    }
    if (tool === 'eraser') {
      if (!active) return
      queueMaskAction('eraser', [stroke])
    }
  }

  function onStageMouseLeave() {
    drawing.current = null
    cropStartRef.current = null
    cropResizeRef.current = null
    setCropHoverHandle(null)
    const hadMovePan = !!movePanRef.current
    movePanRef.current = null
    if (hadMovePan) startMoveMomentum()
    setBrushCursor((prev) => ({ ...prev, visible: false }))
    setDragMetrics(null)
  }

  async function runSelectionAtPoint(pointX: number, pointY: number, mode: 'add' | 'subtract' = 'add') {
    if (!active) return
    const requestStart = performance.now()
    if (import.meta.env.DEV) {
      console.debug('[Vora] AI select start', {
        pointX: Math.round(pointX),
        pointY: Math.round(pointY),
        activeId: active.id,
        imageWidth: active.width,
        imageHeight: active.height,
        mode,
      })
    }
    setBusy(ui.selectionRunning)
    setStatus(ui.selectionRunning)
    runCancelableStart()
    setProgressState({ label: ui.selectionRunning, value: 0, total: 1, indeterminate: true })
    try {
      const imageBlob = await dataUrlToBlob(active.baseDataUrl)
      if (import.meta.env.DEV) {
        console.debug('[Vora] AI select image prepared', {
          mimeType: imageBlob.type,
          bytes: imageBlob.size,
        })
      }
      const maskBlob = await segmentPointViaApi({ image: imageBlob, pointX, pointY })
      const maskImageUrl = await blobToDataUrl(maskBlob)
      const maskImage = await loadHtmlImage(maskImageUrl)

      // Load existing mask pixels if present
      let existingData: Uint8ClampedArray | null = null
      if (selectionMaskDataUrl) {
        const tmpCanvas = document.createElement('canvas')
        tmpCanvas.width = active.width; tmpCanvas.height = active.height
        const tmpCtx = tmpCanvas.getContext('2d')
        if (tmpCtx) {
          const existingImg = await loadHtmlImage(selectionMaskDataUrl)
          tmpCtx.drawImage(existingImg, 0, 0, active.width, active.height)
          existingData = tmpCtx.getImageData(0, 0, active.width, active.height).data
        }
      }

      // Load new mask pixels
      const newCanvas = document.createElement('canvas')
      newCanvas.width = active.width; newCanvas.height = active.height
      const newCtx = newCanvas.getContext('2d')
      if (!newCtx) throw new Error(ERR_CANVAS_UNAVAILABLE)
      newCtx.drawImage(maskImage, 0, 0, active.width, active.height)
      const newData = newCtx.getImageData(0, 0, active.width, active.height).data

      // Combine masks
      const outCanvas = document.createElement('canvas')
      outCanvas.width = active.width; outCanvas.height = active.height
      const outCtx = outCanvas.getContext('2d')
      if (!outCtx) throw new Error(ERR_CANVAS_UNAVAILABLE)
      const outImg = outCtx.createImageData(active.width, active.height)
      for (let i = 0; i < newData.length; i += 4) {
        const ex = existingData ? (existingData[i] ?? 0) : 0
        const nv = newData[i] ?? 0
        const result = mode === 'subtract' ? (nv > 8 ? 0 : ex) : Math.max(ex, nv)
        outImg.data[i] = outImg.data[i + 1] = outImg.data[i + 2] = result
        outImg.data[i + 3] = 255
      }
      outCtx.putImageData(outImg, 0, 0)
      const normalizedMaskUrl = outCanvas.toDataURL('image/png')

      const bounds = findNonZeroMaskBounds(outImg.data, active.width, active.height)
      if (!bounds) throw new Error(ERR_SEGMENT_MASK_EMPTY)
      setSelectionMaskDataUrl(normalizedMaskUrl)
      setSelectionMaskBounds(bounds)
      setStatus(ui.selectionDone)
      if (import.meta.env.DEV) {
        console.debug('[Vora] AI select done', {
          elapsedMs: Math.round(performance.now() - requestStart),
          bounds,
          maskBytes: maskBlob.size,
        })
      }
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e)
      if (import.meta.env.DEV) {
        console.error('[Vora] AI select failed', {
          message,
          elapsedMs: Math.round(performance.now() - requestStart),
          pointX: Math.round(pointX),
          pointY: Math.round(pointY),
        })
      }
      if (message.includes('ERR_SEGMENT')) {
        setStatus(localizeErrorMessage(message))
      } else if (message.includes(ERR_SEGMENT_MASK_EMPTY)) {
        setStatus(ui.selectionMaskEmpty)
      } else {
        setStatus(localizeErrorMessage(message))
      }
    } finally {
      setBusy(null)
      setProgressState(null)
      runCancelableEnd()
    }
  }

  async function applySelectionAction(action: SelectionAction) {
    if (!active || !selectionMaskDataUrl) {
      setStatus(ui.selectionMaskEmpty)
      return
    }

    if (action === 'replaceBackground' && !selectionBackgroundImageUrl) {
      setStatus(ui.selectionPickBackgroundImage)
      return
    }

    try {
      const baseImage = await loadHtmlImage(active.baseDataUrl)
      const maskImage = await loadHtmlImage(selectionMaskDataUrl)

      const width = active.width
      const height = active.height

      const workCanvas = document.createElement('canvas')
      workCanvas.width = width
      workCanvas.height = height
      const workCtx = workCanvas.getContext('2d')
      if (!workCtx) throw new Error(ERR_CANVAS_UNAVAILABLE)

      workCtx.drawImage(baseImage, 0, 0, width, height)
      const baseImageData = workCtx.getImageData(0, 0, width, height)

      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = width
      maskCanvas.height = height
      const maskCtx = maskCanvas.getContext('2d')
      if (!maskCtx) throw new Error(ERR_CANVAS_UNAVAILABLE)
      maskCtx.drawImage(maskImage, 0, 0, width, height)
      const maskData = maskCtx.getImageData(0, 0, width, height).data

      const bounds = findNonZeroMaskBounds(maskData, width, height)
      if (!bounds) {
        setStatus(ui.selectionMaskEmpty)
        return
      }

      if (action === 'restoreSelection') {
        const maskBlob = await renderMaskImageToBlob(selectionMaskDataUrl)
        const imageBlob = await dataUrlToBlob(active.baseDataUrl)
        const resultBlob = await inpaintViaApi({ image: imageBlob, mask: maskBlob })
        const resultUrl = await blobToDataUrl(resultBlob)
        updateAssetByIdWithHistory(active.id, 'AI restore selection', (a) => ({ ...a, baseDataUrl: resultUrl }))
        setStatus(ui.done)
        return
      }

      let replacementData: Uint8ClampedArray | null = null
      if (action === 'replaceBackground' && selectionBackgroundImageUrl) {
        const backgroundImage = await loadHtmlImage(selectionBackgroundImageUrl)
        const bgCanvas = document.createElement('canvas')
        bgCanvas.width = width
        bgCanvas.height = height
        const bgCtx = bgCanvas.getContext('2d')
        if (!bgCtx) throw new Error(ERR_CANVAS_UNAVAILABLE)
        drawImageCover(bgCtx, backgroundImage, width, height)
        replacementData = bgCtx.getImageData(0, 0, width, height).data
      }

      const [fillR, fillG, fillB] = resolveFillColorRgb(selectionFillColor)
      const out = baseImageData.data
      for (let i = 0; i < out.length; i += 4) {
        const selected = (maskData[i] ?? 0) > 8
        if (action === 'eraseSelection' && selected) {
          out[i + 3] = 0
          continue
        }
        if (action === 'transparentBackground' && !selected) {
          out[i + 3] = 0
          continue
        }
        if (action === 'fillBackground' && !selected) {
          out[i] = fillR
          out[i + 1] = fillG
          out[i + 2] = fillB
          out[i + 3] = 255
          continue
        }
        if (action === 'replaceBackground' && !selected && replacementData) {
          out[i] = replacementData[i] ?? out[i]
          out[i + 1] = replacementData[i + 1] ?? out[i + 1]
          out[i + 2] = replacementData[i + 2] ?? out[i + 2]
          out[i + 3] = replacementData[i + 3] ?? 255
        }
      }

      workCtx.putImageData(baseImageData, 0, 0)
      const resultUrl = workCanvas.toDataURL('image/png')

      const label = action === 'eraseSelection'
        ? 'Delete selection'
        : action === 'transparentBackground'
          ? 'Transparent background'
          : action === 'fillBackground'
            ? 'Fill background'
            : 'Replace background image'

      updateAssetByIdWithHistory(active.id, label, (a) => ({ ...a, baseDataUrl: resultUrl }))
      setStatus(ui.done)
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
    }
  }

  function rotateTextItem(t: TextItem, deg: 90 | 180 | 270, w: number, h: number): TextItem {
    if (deg === 90) return { ...t, x: h - t.y, y: t.x, rotation: (t.rotation + 90) % 360 }
    if (deg === 180) return { ...t, x: w - t.x, y: h - t.y, rotation: (t.rotation + 180) % 360 }
    return { ...t, x: t.y, y: w - t.x, rotation: (t.rotation + 270) % 360 }
  }

  function flipTextItem(t: TextItem, axis: 'h' | 'v', w: number, h: number): TextItem {
    if (axis === 'h') return { ...t, x: w - t.x }
    return { ...t, y: h - t.y }
  }

  async function rotateImage(degrees: 90 | 180 | 270) {
    if (!active) return
    const isOdd = degrees === 90 || degrees === 270
    const newW = isOdd ? active.height : active.width
    const newH = isOdd ? active.width : active.height
    const canvas = document.createElement('canvas')
    canvas.width = newW; canvas.height = newH
    const ctx = canvas.getContext('2d')!
    const img = await loadHtmlImage(active.baseDataUrl)
    ctx.translate(newW / 2, newH / 2)
    ctx.rotate((degrees * Math.PI) / 180)
    ctx.drawImage(img, -active.width / 2, -active.height / 2)
    const resultUrl = canvas.toDataURL('image/png')
    const w = active.width; const h = active.height
    updateActiveWithHistory(`Rotate ${degrees}°`, (a) => ({
      ...a, width: newW, height: newH, baseDataUrl: resultUrl,
      texts: a.texts.map((t) => rotateTextItem(t, degrees, w, h)),
    }))
    setSelectionMaskDataUrl(null); setSelectionMaskBounds(null)
  }

  async function flipImage(axis: 'h' | 'v') {
    if (!active) return
    const canvas = document.createElement('canvas')
    canvas.width = active.width; canvas.height = active.height
    const ctx = canvas.getContext('2d')!
    const img = await loadHtmlImage(active.baseDataUrl)
    if (axis === 'h') { ctx.translate(active.width, 0); ctx.scale(-1, 1) }
    else { ctx.translate(0, active.height); ctx.scale(1, -1) }
    ctx.drawImage(img, 0, 0)
    const resultUrl = canvas.toDataURL('image/png')
    const w = active.width; const h = active.height
    updateActiveWithHistory(axis === 'h' ? 'Flip horizontal' : 'Flip vertical', (a) => ({
      ...a, baseDataUrl: resultUrl,
      texts: a.texts.map((t) => flipTextItem(t, axis, w, h)),
    }))
    setSelectionMaskDataUrl(null); setSelectionMaskBounds(null)
  }

  async function applyResize() {
    if (!active || resizeWidth < 1 || resizeHeight < 1) return
    if (resizeWidth === active.width && resizeHeight === active.height) return
    setBusy(ui.resizing)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = resizeWidth; canvas.height = resizeHeight
      const ctx = canvas.getContext('2d')!
      const img = await loadHtmlImage(active.baseDataUrl)
      ctx.drawImage(img, 0, 0, resizeWidth, resizeHeight)
      const resultUrl = canvas.toDataURL('image/png')
      const scaleX = resizeWidth / active.width
      const scaleY = resizeHeight / active.height
      updateActiveWithHistory(`Resize to ${resizeWidth}×${resizeHeight}`, (a) => ({
        ...a,
        width: resizeWidth,
        height: resizeHeight,
        baseDataUrl: resultUrl,
        texts: a.texts.map((t) => ({ ...t, x: t.x * scaleX, y: t.y * scaleY, fontSize: t.fontSize * Math.min(scaleX, scaleY) })),
      }))
      setSelectionMaskDataUrl(null); setSelectionMaskBounds(null)
      setStatus(ui.done)
    } finally {
      setBusy(null)
    }
  }

  async function autoRemoveBackground() {
    if (!active) return
    setBusy(ui.selectionRunning); setStatus(ui.selectionRunning)
    runCancelableStart()
    setProgressState({ label: ui.autoBgRemove, value: 0, total: 2, indeterminate: false })
    try {
      const imageBlob = await dataUrlToBlob(active.baseDataUrl)
      setProgressState({ label: ui.autoBgRemove, value: 1, total: 2, indeterminate: false })
      const maskBlob = await segmentPointViaApi({ image: imageBlob, pointX: Math.round(active.width / 2), pointY: Math.round(active.height / 2) })
      const maskUrl = await blobToDataUrl(maskBlob)
      const baseImage = await loadHtmlImage(active.baseDataUrl)
      const maskImage = await loadHtmlImage(maskUrl)
      const w = active.width; const h = active.height
      const wCanvas = document.createElement('canvas'); wCanvas.width = w; wCanvas.height = h
      const wCtx = wCanvas.getContext('2d')!
      wCtx.drawImage(baseImage, 0, 0)
      const baseData = wCtx.getImageData(0, 0, w, h)
      const mCanvas = document.createElement('canvas'); mCanvas.width = w; mCanvas.height = h
      const mCtx = mCanvas.getContext('2d')!
      mCtx.drawImage(maskImage, 0, 0)
      const maskData = mCtx.getImageData(0, 0, w, h).data
      const out = baseData.data
      for (let i = 0; i < out.length; i += 4) {
        if ((maskData[i] ?? 0) <= 8) out[i + 3] = 0
      }
      wCtx.putImageData(baseData, 0, 0)
      const resultUrl = wCanvas.toDataURL('image/png')
      setProgressState({ label: ui.autoBgRemove, value: 2, total: 2, indeterminate: false })
      updateActiveWithHistory('Auto BG remove', (a) => ({ ...a, baseDataUrl: resultUrl }))
      setStatus(ui.done)
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
    } finally {
      setBusy(null); setProgressState(null); runCancelableEnd()
    }
  }

  async function invertSelection() {
    if (!active || !selectionMaskDataUrl) return
    const img = await loadHtmlImage(selectionMaskDataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = active.width; canvas.height = active.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, active.width, active.height)
    for (let i = 0; i < data.data.length; i += 4) {
      const v = data.data[i] ?? 0
      data.data[i] = data.data[i + 1] = data.data[i + 2] = 255 - v
      data.data[i + 3] = 255
    }
    ctx.putImageData(data, 0, 0)
    const newUrl = canvas.toDataURL('image/png')
    setSelectionMaskDataUrl(newUrl)
    const bounds = findNonZeroMaskBounds(data.data, active.width, active.height)
    setSelectionMaskBounds(bounds)
  }

  async function morphSelection(radius: number, mode: 'expand' | 'contract') {
    if (!active || !selectionMaskDataUrl) return
    const img = await loadHtmlImage(selectionMaskDataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = active.width; canvas.height = active.height
    const ctx = canvas.getContext('2d')!
    ctx.filter = `blur(${radius}px)`
    ctx.drawImage(img, 0, 0)
    ctx.filter = 'none'
    const data = ctx.getImageData(0, 0, active.width, active.height)
    const threshold = mode === 'expand' ? 50 : 200
    for (let i = 0; i < data.data.length; i += 4) {
      const v = data.data[i] ?? 0
      const out = v > threshold ? 255 : 0
      data.data[i] = data.data[i + 1] = data.data[i + 2] = out
      data.data[i + 3] = 255
    }
    ctx.putImageData(data, 0, 0)
    const newUrl = canvas.toDataURL('image/png')
    setSelectionMaskDataUrl(newUrl)
    const bounds = findNonZeroMaskBounds(data.data, active.width, active.height)
    setSelectionMaskBounds(bounds)
  }

  async function featherSelection(radius: number) {
    if (!active || !selectionMaskDataUrl) return
    const img = await loadHtmlImage(selectionMaskDataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = active.width; canvas.height = active.height
    const ctx = canvas.getContext('2d')!
    ctx.filter = `blur(${radius}px)`
    ctx.drawImage(img, 0, 0)
    ctx.filter = 'none'
    const data = ctx.getImageData(0, 0, active.width, active.height)
    for (let i = 0; i < data.data.length; i += 4) {
      const v = data.data[i] ?? 0
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v
      data.data[i + 3] = 255
    }
    ctx.putImageData(data, 0, 0)
    setSelectionMaskDataUrl(canvas.toDataURL('image/png'))
    const bounds = findNonZeroMaskBounds(data.data, active.width, active.height)
    setSelectionMaskBounds(bounds)
  }

  async function onSelectionBackgroundImageChange(fileList: FileList | null) {
    const file = fileList?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setStatus(ui.errImageLoadFailed)
      return
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            reject(new Error(ERR_DATA_URL_CONVERT_FAILED))
            return
          }
          resolve(reader.result)
        }
        reader.onerror = () => reject(new Error(ERR_IMAGE_LOAD_FAILED))
        reader.readAsDataURL(file)
      })
      setSelectionBackgroundImageUrl(dataUrl)
      setStatus(ui.selectionBackgroundImageReady)
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
    }
  }

  async function runInpaintForAsset(assetId: string, strokes: MaskStroke[], boundsOverride?: CropRect | null) {
    const target = assetsRef.current.find((asset) => asset.id === assetId)
    if (!target) return false
    if (strokes.length === 0) {
      return false
    }

    const bounds = boundsOverride ?? getInpaintBounds(strokes, target.width, target.height)
    if (!bounds) {
      return false
    }
    try {
      const translated = strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map((value, idx) => (idx % 2 === 0 ? value - bounds.x : value - bounds.y)),
      }))

      const imageBlob = await renderAssetRegionToBlob(target, bounds)
      const maskBlob = await renderMaskToPng({
        width: bounds.width,
        height: bounds.height,
        strokes: translated,
      })

      const resultBlob = await inpaintViaApi({ image: imageBlob, mask: maskBlob })
      const resultUrl = await mergeInpaintResult(target.baseDataUrl, bounds, resultBlob)
      updateAssetByIdWithHistory(target.id, 'AI restore', (a) => ({ ...a, baseDataUrl: resultUrl, maskStrokes: [] }))
      return true
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
      return false
    }
  }

  async function applyLocalEraserForAsset(assetId: string, strokes: MaskStroke[], boundsOverride?: CropRect | null) {
    const target = assetsRef.current.find((asset) => asset.id === assetId)
    if (!target || strokes.length === 0) return false
    const bounds = boundsOverride ?? getInpaintBounds(strokes, target.width, target.height)
    if (!bounds) return false

    try {
      const baseImage = await loadHtmlImage(target.baseDataUrl)
      const canvas = document.createElement('canvas')
      canvas.width = target.width
      canvas.height = target.height
      const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(ERR_CANVAS_UNAVAILABLE)

      ctx.drawImage(baseImage, 0, 0)
      const fillColor = dominantNeighborColor(ctx, target.width, target.height, bounds)
      ctx.strokeStyle = fillColor
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      for (const stroke of strokes) {
        const pts = stroke.points
        if (pts.length < 4) continue
        ctx.lineWidth = stroke.strokeWidth
        ctx.beginPath()
        ctx.moveTo(pts[0] ?? 0, pts[1] ?? 0)
        for (let i = 2; i < pts.length; i += 2) {
          ctx.lineTo(pts[i] ?? 0, pts[i + 1] ?? 0)
        }
        ctx.stroke()
      }

      const resultUrl = canvas.toDataURL('image/png')
      updateAssetByIdWithHistory(target.id, 'AI eraser', (a) => ({ ...a, baseDataUrl: resultUrl, maskStrokes: [] }))
      return true
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
      return false
    }
  }

  function enqueueInpaint(strokes: MaskStroke[], boundsOverride?: CropRect | null) {
    if (!active) return
    const cloned = cloneStrokes(strokes)
    inpaintQueueRef.current.push({ assetId: active.id, strokes: cloned, boundsOverride: boundsOverride ?? null })
    lastRestoreMacroTemplateRef.current = normalizeStrokes(cloned, active.width, active.height)
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null
      void processInpaintQueue()
    }, 60)
  }

  async function processInpaintQueue() {
    if (inpaintRunningRef.current) return
    if (inpaintQueueRef.current.length === 0) return
    inpaintRunningRef.current = true
    runCancelableStart()
    setBusy(ui.inpainting)
    setStatus(ui.inpainting)
    try {
      const total = inpaintQueueRef.current.length
      let doneCount = 0
      setProgressState({ label: ui.inpainting, value: 0, total, indeterminate: false })
      while (inpaintQueueRef.current.length > 0) {
        if (cancelRequestedRef.current) break
        const next = inpaintQueueRef.current.shift()
        if (!next) continue
        await runInpaintForAsset(next.assetId, next.strokes, next.boundsOverride)
        doneCount += 1
        setProgressState({ label: ui.inpainting, value: doneCount, total, indeterminate: false })
      }
      setStatus(ui.done)
    } finally {
      inpaintRunningRef.current = false
      inpaintQueueRef.current = []
      setBusy(null)
      setProgressState(null)
      runCancelableEnd()
    }
  }

  async function runMacroRepeatRestore(targets: PageAsset[]) {
    const template = lastRestoreMacroTemplateRef.current
    if (!template || template.length === 0) {
      setStatus(ui.macroNoStrokeRestore)
      return
    }
    if (targets.length === 0) {
      setStatus(ui.macroNoSelectedFiles)
      return
    }
    const repeat = clamp(Math.round(macroRepeatCount), 1, 10)
    const total = targets.length * repeat
    let doneCount = 0
    let successCount = 0
    let failCount = 0
    setBusy(ui.inpainting)
    setStatus(ui.inpainting)
    runCancelableStart()
    setProgressState({ label: ui.inpainting, value: 0, total, indeterminate: false })
    try {
      for (let pass = 0; pass < repeat; pass += 1) {
        if (cancelRequestedRef.current) break
        for (const asset of targets) {
          if (cancelRequestedRef.current) break
          const mapped = denormalizeStrokes(template, asset.width, asset.height)
          const ok = await runInpaintForAsset(asset.id, mapped)
          if (ok) successCount += 1
          else failCount += 1
          doneCount += 1
          setProgressState({ label: ui.inpainting, value: doneCount, total, indeterminate: false })
        }
      }
      setStatus(`${ui.activitySummary(total, successCount, failCount)} · ${ui.done}`)
    } finally {
      setBusy(null)
      setProgressState(null)
      runCancelableEnd()
    }
  }

  async function runMacroRepeatEraser(targets: PageAsset[]) {
    const template = lastEraserMacroTemplateRef.current
    if (!template || template.length === 0) {
      setStatus(ui.macroNoStrokeEraser)
      return
    }
    if (targets.length === 0) {
      setStatus(ui.macroNoSelectedFiles)
      return
    }
    const repeat = clamp(Math.round(macroRepeatCount), 1, 10)
    const total = targets.length * repeat
    let doneCount = 0
    let successCount = 0
    let failCount = 0
    setBusy(ui.inpainting)
    setStatus(ui.inpainting)
    runCancelableStart()
    setProgressState({ label: ui.inpainting, value: 0, total, indeterminate: false })
    try {
      for (let pass = 0; pass < repeat; pass += 1) {
        if (cancelRequestedRef.current) break
        for (const asset of targets) {
          if (cancelRequestedRef.current) break
          const mapped = denormalizeStrokes(template, asset.width, asset.height)
          const ok = await applyLocalEraserForAsset(asset.id, mapped)
          if (ok) successCount += 1
          else failCount += 1
          doneCount += 1
          setProgressState({ label: ui.inpainting, value: doneCount, total, indeterminate: false })
        }
      }
      setStatus(`${ui.activitySummary(total, successCount, failCount)} · ${ui.done}`)
    } finally {
      setBusy(null)
      setProgressState(null)
      runCancelableEnd()
    }
  }

  async function exportPngSet(targets: PageAsset[], pixelRatio: number) {
    if (targets.length === 0) return
    setBusy(ui.exporting)
    setProgressState({ label: ui.exporting, value: 0, total: Math.max(1, targets.length), indeterminate: false })
    try {
      let lastName = ''
      let successCount = 0
      for (let idx = 0; idx < targets.length; idx += 1) {
        const target = targets[idx]!
        const dataUrl = await renderAssetToDataUrl(target, pixelRatio)
        const blob = await dataUrlToBlob(dataUrl)
        const fileName = buildVoraFilename(target.name, 'png')
        downloadBlob(blob, fileName)
        lastName = fileName
        successCount += 1
        setProgressState({ label: ui.exporting, value: idx + 1, total: Math.max(1, targets.length), indeterminate: false })
      }
      setStatus(successCount === 1 ? ui.exportedFile(lastName) : ui.exportedBatch(successCount, 0))
      setHasUnsavedChanges(false)
      setDirtyChangeCount(0)
      setLastDirtyAt(null)
    } finally {
      setBusy(null)
      setProgressState(null)
    }
  }

  async function exportJpgSet(targets: PageAsset[], pixelRatio: number, quality: number) {
    if (targets.length === 0) return
    setBusy(ui.exporting)
    setProgressState({ label: ui.exporting, value: 0, total: Math.max(1, targets.length), indeterminate: false })
    try {
      let lastName = ''
      let successCount = 0
      for (let idx = 0; idx < targets.length; idx += 1) {
        const target = targets[idx]!
        const dataUrl = await renderAssetToDataUrl(target, pixelRatio, 'image/jpeg', quality)
        const blob = await dataUrlToBlob(dataUrl)
        const fileName = buildVoraFilename(target.name, 'jpg')
        downloadBlob(blob, fileName)
        lastName = fileName
        successCount += 1
        setProgressState({ label: ui.exporting, value: idx + 1, total: Math.max(1, targets.length), indeterminate: false })
      }
      setStatus(successCount === 1 ? ui.exportedFile(lastName) : ui.exportedBatch(successCount, 0))
      setHasUnsavedChanges(false)
      setDirtyChangeCount(0)
      setLastDirtyAt(null)
    } finally {
      setBusy(null)
      setProgressState(null)
    }
  }

  async function exportWebpSet(targets: PageAsset[], pixelRatio: number, quality: number) {
    if (targets.length === 0) return
    setBusy(ui.exporting)
    setProgressState({ label: ui.exporting, value: 0, total: Math.max(1, targets.length), indeterminate: false })
    try {
      let lastName = ''
      let successCount = 0
      for (let idx = 0; idx < targets.length; idx += 1) {
        const target = targets[idx]!
        const dataUrl = await renderAssetToDataUrl(target, pixelRatio, 'image/webp', quality)
        const blob = await dataUrlToBlob(dataUrl)
        const fileName = buildVoraFilename(target.name, 'webp')
        downloadBlob(blob, fileName)
        lastName = fileName
        successCount += 1
        setProgressState({ label: ui.exporting, value: idx + 1, total: Math.max(1, targets.length), indeterminate: false })
      }
      setStatus(successCount === 1 ? ui.exportedFile(lastName) : ui.exportedBatch(successCount, 0))
      setHasUnsavedChanges(false)
      setDirtyChangeCount(0)
      setLastDirtyAt(null)
    } finally {
      setBusy(null)
      setProgressState(null)
    }
  }

  async function exportPdfSet(targets: PageAsset[], pixelRatio: number, scope: ExportScope) {
    if (targets.length === 0) return
    setBusy(ui.exportingPdf)
    setStatus(ui.exportingPdf)
    runCancelableStart()
    setProgressState({ label: ui.exportingPdf, value: 0, total: Math.max(1, targets.length), indeterminate: false })
    try {
      let pdf: jsPDF | null = null

      for (let idx = 0; idx < targets.length; idx++) {
        if (cancelRequestedRef.current) break
        const a = targets[idx]!
        const dataUrl = await renderAssetToDataUrl(a, pixelRatio, 'image/jpeg', 0.92)

        const pageW = a.width
        const pageH = a.height
        if (!pdf) {
          pdf = new jsPDF({
            unit: 'px',
            format: [pageW, pageH],
            orientation: pageW >= pageH ? 'landscape' : 'portrait',
          })
        } else {
          pdf.addPage([pageW, pageH], pageW >= pageH ? 'landscape' : 'portrait')
        }
        pdf.addImage(dataUrl, 'JPEG', 0, 0, pageW, pageH)
        setProgressState({ label: ui.exportingPdf, value: idx + 1, total: Math.max(1, targets.length), indeterminate: false })
      }

      if (!pdf) throw new Error(ui.noPages)
      if (cancelRequestedRef.current) {
        setStatus(ui.taskCancelled)
        return
      }
      const blob = pdf.output('blob')
      const first = targets[0]!
      const filename = targets.length === 1
        ? buildVoraFilename(first.name, 'pdf')
        : buildVoraBundleFilename(first.name, `_${scope}`, 'pdf')
      downloadBlob(blob, filename)
      setStatus(ui.exportedFile(filename))
      setHasUnsavedChanges(false)
      setDirtyChangeCount(0)
      setLastDirtyAt(null)
    } finally {
      setBusy(null)
      setProgressState(null)
      runCancelableEnd()
    }
  }

  async function exportPptxSet(targets: PageAsset[], pixelRatio: number, scope: ExportScope) {
    if (targets.length === 0) return
    setBusy(ui.exporting)
    setStatus(ui.exporting)
    runCancelableStart()
    setProgressState({ label: ui.exporting, value: 0, total: Math.max(1, targets.length), indeterminate: false })
    try {
      const pptx = new PptxGenJS()
      pptx.layout = 'LAYOUT_WIDE'
      for (let idx = 0; idx < targets.length; idx += 1) {
        if (cancelRequestedRef.current) break
        const asset = targets[idx]!
        const slide = pptx.addSlide()
        const baseOnly = { ...asset, texts: [] }
        const dataUrl = await renderAssetToDataUrl(baseOnly, pixelRatio, 'image/png')
        slide.addImage({ data: dataUrl, x: 0, y: 0, w: 13.33, h: 7.5 })
        const sx = 13.33 / Math.max(1, asset.width)
        const sy = 7.5 / Math.max(1, asset.height)

        for (const t of asset.texts) {
          if (!t.visible) continue
          const text = t.text?.trim()
          if (!text) continue
          const box = estimateTextBoxPx(text, t, asset)
          const x = clamp(t.x, 0, asset.width) * sx
          const y = clamp(t.y, 0, asset.height) * sy
          const w = clamp(box.width, 8, asset.width) * sx
          const h = clamp(box.height, 8, asset.height) * sy
          slide.addText(text, {
            x,
            y,
            w,
            h,
            fontFace: t.fontFamily,
            fontSize: clamp(t.fontSize * 0.75, 6, 220),
            color: cssColorToPptHex(t.fill),
            bold: t.fontWeight >= 600,
            italic: t.fontStyle === 'italic',
            align: t.align,
            breakLine: true,
            margin: 0,
            valign: 'top',
          })
        }
        setProgressState({ label: ui.exporting, value: idx + 1, total: Math.max(1, targets.length), indeterminate: false })
      }
      if (cancelRequestedRef.current) {
        setStatus(ui.taskCancelled)
        return
      }
      const out = (await pptx.write({ outputType: 'blob' })) as Blob
      const first = targets[0]!
      const filename = targets.length === 1
        ? buildVoraFilename(first.name, 'pptx')
        : buildVoraBundleFilename(first.name, `_${scope}`, 'pptx')
      downloadBlob(out, filename)
      setStatus(ui.exportedFile(filename))
      setHasUnsavedChanges(false)
      setDirtyChangeCount(0)
      setLastDirtyAt(null)
    } finally {
      setBusy(null)
      setProgressState(null)
      runCancelableEnd()
    }
  }

  function beginInlineEdit(t: TextItem) {
    inlineEditOpenedAtRef.current = Date.now()
    inlineEditBlurGuardRef.current = true
    setEditingTextId(t.id)
    setEditingValue(t.text)
  }

  function onInlineEditorBlur() {
    const elapsed = Date.now() - inlineEditOpenedAtRef.current
    if (inlineEditBlurGuardRef.current && elapsed < 180) {
      inlineEditBlurGuardRef.current = false
      window.requestAnimationFrame(() => {
        inlineEditorRef.current?.focus()
      })
      return
    }
    inlineEditBlurGuardRef.current = false
    commitInlineEdit()
  }

  function commitInlineEdit() {
    if (!editingTextId) return
    inlineEditBlurGuardRef.current = false
    if (selectedText?.locked) {
      setEditingTextId(null)
      return
    }
    const editedId = editingTextId
    const next = editingValue
    updateActiveWithHistory('Edit text inline', (a) => ({
      ...a,
      texts: a.texts.map((t) => (t.id === editedId ? { ...t, text: next } : t)),
    }))
    setEditingTextId(null)
  }

  async function confirmExport() {
    if (!exportDialogOpen) return
    const ratio = normalizeExportRatio(pendingExportRatio)
    const scope = pendingExportScope
    const targets = exportTargets(scope)
    if (targets.length === 0) {
      setStatus(ui.exportNoSelected)
      return
    }
    const kind = pendingExportFormat
    const imageQuality = clamp(pendingExportQuality, 50, 100) / 100
    setExportDialogOpen(false)
    if (kind === 'png') return await exportPngSet(targets, ratio)
    if (kind === 'jpg') return await exportJpgSet(targets, ratio, imageQuality)
    if (kind === 'webp') return await exportWebpSet(targets, ratio, imageQuality)
    if (kind === 'pdf') return await exportPdfSet(targets, ratio, scope)
    return await exportPptxSet(targets, ratio, scope)
  }

  async function runMacroWithConfirm(toolKind: 'restore' | 'eraser', mode: 'all' | 'selected') {
    if (busy) return
    const targets = mode === 'all' ? [...assetsRef.current] : [...selectedAssets]
    if (targets.length === 0) {
      setStatus(ui.macroNoSelectedFiles)
      return
    }
    const message = mode === 'all' ? ui.macroConfirmAll(targets.length) : ui.macroConfirmSelected(targets.length)
    if (!window.confirm(message)) return

    setMacroRunningTool(toolKind)
    setMacroRunningMode(mode)
    setStatus(mode === 'all' ? ui.macroRunningAll : ui.macroRunningSelected)
    try {
      if (toolKind === 'restore') {
        await runMacroRepeatRestore(targets)
      } else {
        await runMacroRepeatEraser(targets)
      }
    } finally {
      setMacroRunningMode(null)
      setMacroRunningTool(null)
    }
  }

  function cancelInlineEdit() {
    inlineEditBlurGuardRef.current = false
    setEditingTextId(null)
  }

  function snapTextDuringDrag(node: Konva.Text, asset: PageAsset, snapEnabled: boolean) {
    const baseThreshold = textSnapStrength === 'off'
      ? 0
      : textSnapStrength === 'soft'
        ? 4
        : textSnapStrength === 'strong'
          ? 14
          : 8
    const threshold = snapEnabled ? baseThreshold : 0
    const rect = node.getClientRect({ relativeTo: node.getParent() ?? undefined })
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2

    const guidesX = [0, asset.width / 2, asset.width]
    const guidesY = [0, asset.height / 2, asset.height]

    for (const t of asset.texts) {
      if (t.id === node.id() || !t.visible) continue
      guidesX.push(t.x)
      guidesY.push(t.y)
    }

    let snappedX: number | undefined
    let snappedY: number | undefined

    if (threshold > 0) {
      for (const gx of guidesX) {
        if (Math.abs(centerX - gx) <= threshold) {
          const dx = gx - centerX
          node.x(node.x() + dx)
          snappedX = gx
          break
        }
      }
    }

    if (threshold > 0) {
      for (const gy of guidesY) {
        if (Math.abs(centerY - gy) <= threshold) {
          const dy = gy - centerY
          node.y(node.y() + dy)
          snappedY = gy
          break
        }
      }
    }

    setDragGuides(threshold > 0 ? { x: snappedX, y: snappedY } : {})
    const latestRect = node.getClientRect({ relativeTo: node.getParent() ?? undefined })
    setDragMetrics({
      left: Math.max(0, Math.round(latestRect.x)),
      right: Math.max(0, Math.round(asset.width - (latestRect.x + latestRect.width))),
      top: Math.max(0, Math.round(latestRect.y)),
      bottom: Math.max(0, Math.round(asset.height - (latestRect.y + latestRect.height))),
    })
  }

  const activeCropHandle = cropResizeRef.current?.handle ?? cropHoverHandle
  const cropCursor = activeCropHandle === 'nw' || activeCropHandle === 'se'
    ? 'nwse-resize'
    : activeCropHandle === 'ne' || activeCropHandle === 'sw'
      ? 'nesw-resize'
      : 'crosshair'
  const stageCursor = spacePanActive
    ? 'grab'
    : tool === 'restore' || tool === 'eraser'
    ? 'none'
    : tool === 'crop'
      ? cropCursor
      : tool === 'move'
        ? 'grab'
        : 'default'
  const normalizedRestoreDevice = aiDevice.toLowerCase()
  const restoreDeviceLabel = normalizedRestoreDevice.includes('cuda') || normalizedRestoreDevice.includes('gpu') ? 'GPU' : normalizedRestoreDevice.includes('cpu') ? 'CPU' : 'AUTO'
  const aiStatusText = aiReady ? ui.aiReady : ui.aiInit
  const gpuSelectable = cudaAvailable !== false
  const selectedEngine = aiRequestedDevice === 'cuda' ? 'GPU' : 'CPU'
  const selectedAvailable = selectedEngine === 'CPU' ? true : gpuSelectable
  const canUndo = !busy && assetListHistoryPast.length > 0
  const canRedo = !busy && assetListHistoryFuture.length > 0
  const hasSelectedAssets = selectedAssetIds.length > 0
  const activeCropRect = active && cropRect ? normalizeCropRect(cropRect, active.width, active.height) : null
  const pendingMaskBounds = useMemo(() => {
    if (!active || !pendingMaskAction || pendingMaskAction.assetId !== active.id) return null
    return resolveMaskActionBounds(active, pendingMaskAction.strokes, maskApplyScope)
  }, [active, pendingMaskAction, maskApplyScope, cropRect])

  const cropAreaPercent = activeCropRect && active
    ? clamp((activeCropRect.width * activeCropRect.height * 100) / Math.max(1, active.width * active.height), 0, 100)
    : null
  const cropDockClass = tool === 'crop'
    ? cropHideDocksOnCrop
      ? 'dockPassthrough dockCropHidden'
      : 'dockPassthrough'
    : ''
  const brushSliderValue = brushToSlider(brushSize)
  const filteredToastLog = useMemo(() => {
    if (activityFilter === 'all') return toastLog
    return toastLog.filter((item) => item.tone === activityFilter)
  }, [activityFilter, toastLog])
  const orderedToastLog = useMemo(() => {
    if (activitySort === 'latest') return filteredToastLog
    return [...filteredToastLog].reverse()
  }, [activitySort, filteredToastLog])
  const textQuickBarPos = useMemo(() => {
    if (!selectedText || tool !== 'text' || !!editingTextId) return null
    const x = fit.ox + selectedText.x * fit.scale + quickBarOffset.x
    const y = fit.oy + selectedText.y * fit.scale - 44 + quickBarOffset.y
    return {
      left: clamp(x, 8, Math.max(8, wrapSize.w - 360)),
      top: clamp(y, 8, Math.max(8, wrapSize.h - 46)),
    }
  }, [selectedText, tool, editingTextId, fit, wrapSize, quickBarOffset])
  const tinyViewport = wrapSize.w <= 360
  const shortcutRows: Array<{ keyLabel: string; desc: string; category: ShortcutCategory }> = locale === 'ko'
    ? [
        { keyLabel: 'B', desc: '복원 모드', category: 'tools' },
        { keyLabel: 'E', desc: '지우개 모드', category: 'tools' },
        { keyLabel: 'T', desc: '텍스트 모드', category: 'tools' },
        { keyLabel: 'C', desc: '자르기 모드', category: 'tools' },
        { keyLabel: 'M', desc: '이동 모드', category: 'tools' },
        { keyLabel: 'Ctrl/Shift/Alt+휠', desc: '확대/축소', category: 'tools' },
        { keyLabel: 'Shift+클릭', desc: '범위 다중선택', category: 'selection' },
        { keyLabel: 'I', desc: '파일 선택 반전', category: 'selection' },
        { keyLabel: 'Esc', desc: '선택 해제', category: 'selection' },
        { keyLabel: 'Ctrl/Cmd+Z', desc: '실행취소', category: 'history' },
        { keyLabel: 'Shift+Ctrl/Cmd+Z', desc: '다시실행', category: 'history' },
        { keyLabel: 'Alt+L', desc: '작업 로그 비우기', category: 'history' },
      ]
    : [
        { keyLabel: 'B', desc: 'Restore mode', category: 'tools' },
        { keyLabel: 'E', desc: 'Eraser mode', category: 'tools' },
        { keyLabel: 'T', desc: 'Text mode', category: 'tools' },
        { keyLabel: 'C', desc: 'Crop mode', category: 'tools' },
        { keyLabel: 'M', desc: 'Move mode', category: 'tools' },
        { keyLabel: 'Ctrl/Shift/Alt+wheel', desc: 'Zoom in/out', category: 'tools' },
        { keyLabel: 'Shift+click', desc: 'Range multi-select', category: 'selection' },
        { keyLabel: 'I', desc: 'Invert file selection', category: 'selection' },
        { keyLabel: 'Esc', desc: 'Clear selection', category: 'selection' },
        { keyLabel: 'Ctrl/Cmd+Z', desc: 'Undo', category: 'history' },
        { keyLabel: 'Shift+Ctrl/Cmd+Z', desc: 'Redo', category: 'history' },
        { keyLabel: 'Alt+L', desc: 'Clear activity log', category: 'history' },
      ]
  const categorizedShortcutRows = shortcutsCategory === 'all'
    ? shortcutRows
    : shortcutRows.filter((row) => row.category === shortcutsCategory)
  const shortcutQueryLower = shortcutsQuery.trim().toLowerCase()
  const filteredShortcutRows = !shortcutQueryLower
    ? categorizedShortcutRows
    : categorizedShortcutRows.filter((row) => row.keyLabel.toLowerCase().includes(shortcutQueryLower) || row.desc.toLowerCase().includes(shortcutQueryLower))
  const selectedExportFormatHint = pendingExportFormat === 'png'
    ? ui.exportFormatHintPng
    : pendingExportFormat === 'jpg'
      ? ui.exportFormatHintJpg
      : pendingExportFormat === 'webp'
        ? ui.exportFormatHintWebp
        : pendingExportFormat === 'pdf'
          ? ui.exportFormatHintPdf
          : ui.exportFormatHintPptx
  const exportSummaryText = `${ui.exportFormat}: ${pendingExportFormat.toUpperCase()} · ${pendingExportRatio}x${pendingExportFormat === 'jpg' || pendingExportFormat === 'webp' ? ` · ${ui.exportImageQuality}: ${pendingExportQuality}` : ''} · ${ui.exportScope}: ${pendingExportScope}`
  const settingRowClass = 'settingsRow'
  const recentDirtySummaries = useMemo(() => {
    const seen = new Set<string>()
    const picked: string[] = []
    for (const item of toastLog) {
      const text = item.text.trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      picked.push(text)
      if (picked.length >= 3) break
    }
    return picked
  }, [toastLog])
  const unsavedTooltip = [
    lastDirtyAt ? ui.unsavedUpdatedAt(formatTimestamp(lastDirtyAt)) : ui.unsavedBadge,
    recentDirtySummaries.length > 0 ? `${ui.unsavedRecentChanges}: ${recentDirtySummaries.join(' · ')}` : null,
  ].filter(Boolean).join('\n')
  const activityPreviewCurrentBase = useMemo(() => {
    const cached = activityPreview?.current?.baseDataUrl
    if (cached) return cached
    const previewAssetId = activityPreview?.item.assetId
    if (!previewAssetId) return null
    const found = assets.find((asset) => asset.id === previewAssetId)
    return found?.baseDataUrl ?? null
  }, [activityPreview, assets])

  function startQuickBarDrag(e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.stopPropagation()
    quickBarDragRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originX: quickBarOffset.x,
      originY: quickBarOffset.y,
    }
    setDraggingQuickBar(true)
  }

  function statusTone(label: string): 'error' | 'success' | 'working' | 'info' {
    if (/error|failed|오류|실패/i.test(label)) return 'error'
    if (label === ui.done || label === ui.exportedPng || label === ui.exportedPdf || /완료|done/i.test(label)) return 'success'
    if (label === ui.inpainting || label === ui.exporting || label === ui.exportingPdf || label === ui.importingStatus || /중|running|importing|exporting/i.test(label)) return 'working'
    return 'info'
  }

  function statusIcon(label: string) {
    const tone = statusTone(label)
    if (tone === 'error') return '⚠'
    if (tone === 'success') return '✓'
    if (tone === 'working') return '◌'
    return '•'
  }

  function runCancelableStart() {
    cancelRequestedRef.current = false
    setCancelableTask(true)
  }

  function runCancelableEnd() {
    setCancelableTask(false)
    cancelRequestedRef.current = false
  }

  function requestCancelTask() {
    cancelRequestedRef.current = true
    setStatus(ui.taskCancelled)
  }

  function applyPendingAutoRestore() {
    if (!pendingAutoRestore) return
    setAssets(pendingAutoRestore.assets)
    setActiveId(pendingAutoRestore.activeId ?? pendingAutoRestore.assets[0]?.id ?? null)
    setLastAutoSaveAt(pendingAutoRestore.ts)
    setPendingAutoRestore(null)
    setStatus(ui.ready)
  }

  function discardPendingAutoRestore() {
    setPendingAutoRestore(null)
    try {
      window.localStorage.removeItem('vora-autosave')
    } catch {
      // ignore
    }
  }

  function openSettings() {
    setSettingsTab('general')
    setSettingsOpen(true)
  }

  function closeSettings() {
    setSettingsOpen(false)
  }

  function flashGuideTarget(target: 'files' | 'tools' | 'canvas' | 'export') {
    setGuideFocusTarget(target)
    if (guideFlashTimerRef.current !== null) {
      window.clearTimeout(guideFlashTimerRef.current)
    }
    guideFlashTimerRef.current = window.setTimeout(() => {
      setGuideFocusTarget(null)
      guideFlashTimerRef.current = null
    }, 1600)
  }

  function formatTimestamp(ts: number | null) {
    if (!ts) return ui.settingsNoAutoSave
    return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(ts))
  }

  function formatLogTimestamp(ts: number) {
    return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(ts))
  }

  function activityKindLabel(item: ToastLogItem) {
    const text = item.text.toLowerCase()
    if (text.includes('ai') || text.includes('복원')) return ui.activityKindAi
    if (text.includes('export') || text.includes('내보내')) return ui.activityKindExport
    if (text.includes('text') || text.includes('텍스트')) return ui.activityKindText
    return ui.activityKindSystem
  }

  function jumpToActivity(item: ToastLogItem) {
    if (!item.assetId) return
    if (!assetsRef.current.some((asset) => asset.id === item.assetId)) return
    setActiveId(item.assetId)
    setFlashAssetId(item.assetId)
    if (!item.snapshot) return
    const parsed = parseSnapshot(item.snapshot)
    if (!parsed) return
    updateAssetByIdWithHistory(item.assetId, 'Jump checkpoint', (asset) => ({
      ...asset,
      width: parsed.width,
      height: parsed.height,
      baseDataUrl: parsed.baseDataUrl,
      texts: parsed.texts,
      groups: parsed.groups,
      maskStrokes: [],
    }))
  }

  function openActivityMenu(e: ReactMouseEvent, item: ToastLogItem) {
    e.preventDefault()
    e.stopPropagation()
    setActivityMenu({ x: e.clientX, y: e.clientY, item })
  }

  function openActivityPreview(item: ToastLogItem) {
    if (!item.snapshot) {
      setStatus(ui.activityPreviewUnavailable)
      return
    }
    const parsed = parseSnapshot(item.snapshot)
    if (!parsed) {
      setStatus(ui.activityPreviewUnavailable)
      return
    }
    const currentAsset = item.assetId ? assetsRef.current.find((asset) => asset.id === item.assetId) ?? null : null
    setActivityPreviewCompare(50)
    setActivityPreview({ item, snapshot: parsed, current: currentAsset ? snapshotFromAsset(currentAsset) : null })
  }

  function applyActivityPreviewSnapshot(target: 'snapshot' | 'current') {
    if (!activityPreview?.item.assetId) return
    const chosen = target === 'snapshot' ? activityPreview.snapshot : activityPreview.current
    if (!chosen) {
      setStatus(ui.activityPreviewUnavailable)
      return
    }
    if (!window.confirm(target === 'snapshot' ? ui.activityApplySnapshot : ui.activityApplyCurrent)) return
    updateAssetByIdWithHistory(activityPreview.item.assetId, target === 'snapshot' ? ui.activityApplySnapshot : ui.activityApplyCurrent, (asset) => ({
      ...asset,
      width: chosen.width,
      height: chosen.height,
      baseDataUrl: chosen.baseDataUrl,
      texts: cloneTextItems(chosen.texts),
      groups: cloneLayerGroups(chosen.groups),
      maskStrokes: [],
    }))
    setActivityPreview(null)
  }

  function triggerHaptic() {
    try {
      if ('vibrate' in navigator) navigator.vibrate(12)
    } catch {
      // ignore
    }
  }

  function mobileActionLabel(action: MobileQuickAction) {
    if (action === 'export') return ui.settingsMobileActionExport
    if (action === 'activity') return ui.settingsMobileActionActivity
    if (action === 'shortcuts') return ui.settingsMobileActionShortcuts
    return ui.settingsMobileActionSettings
  }

  function mobileActionIcon(action: MobileQuickAction) {
    if (action === 'export') return '⬇'
    if (action === 'activity') return '🧾'
    if (action === 'shortcuts') return '⌨'
    return '⚙'
  }

  function runMobileQuickAction(action: MobileQuickAction) {
    triggerHaptic()
    if (action === 'export') {
      if (!hasSelectedAssets && pendingExportScope === 'selected') {
        setPendingExportScope('current')
      }
      setExportDialogOpen(true)
      return
    }
    if (action === 'activity') {
      setShowActivityLog((prev) => !prev)
      return
    }
    if (action === 'shortcuts') {
      setShowShortcutsHelp((prev) => !prev)
      return
    }
    if (settingsOpen) closeSettings()
    else openSettings()
  }

  function mobileActionHint(action: MobileQuickAction) {
    if (action === 'export') return ui.exportNow
    if (action === 'activity') return showActivityLog ? ui.activityHide : ui.activityShow
    if (action === 'shortcuts') return ui.shortcutsHelp
    return ui.settings
  }

  function moveMobileQuickAction(action: MobileQuickAction, dir: -1 | 1) {
    setMobileQuickOrder((prev) => {
      const idx = prev.indexOf(action)
      const nextIdx = idx + dir
      if (idx < 0 || nextIdx < 0 || nextIdx >= prev.length) return prev
      const next = [...prev]
      const temp = next[idx]
      next[idx] = next[nextIdx]!
      next[nextIdx] = temp!
      return next
    })
  }

  function reorderMobileQuickActions(source: MobileQuickAction, target: MobileQuickAction) {
    if (source === target) return
    setMobileQuickOrder((prev) => {
      const from = prev.indexOf(source)
      const to = prev.indexOf(target)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [item] = next.splice(from, 1)
      if (!item) return prev
      next.splice(to, 0, item)
      return next
    })
  }

  function beginLongPressHint(message: string) {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressTimerRef.current = window.setTimeout(() => {
      setStatus(message)
      longPressTimerRef.current = null
    }, 460)
  }

  async function copyDockerHubLink() {
    const text = 'https://hub.docker.com/r/xiukr/vora'
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setStatus(ui.settingsCopiedDockerHub)
    } catch {
      setStatus(text)
    }
  }

  function openExternalLink(url: string, label: string) {
    window.open(url, '_blank', 'noopener,noreferrer')
    setStatus(ui.externalOpened(label))
  }

  function cancelLongPressHint() {
    if (longPressTimerRef.current === null) return
    window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
  }

  async function copyDiagnostics() {
    const lines = [
      `app=${APP_VERSION}`,
      `locale=${locale}`,
      `preferredDevice=${preferredDevice}`,
      `runtimeDevice=${aiDevice}`,
      `aiReady=${String(aiReady)}`,
      `aiError=${aiError ?? 'none'}`,
      `brushSize=${brushSize}`,
      `autoSaveSeconds=${autoSaveSeconds}`,
      `showGuide=${String(showGuide)}`,
      `showShortcutTips=${String(showShortcutTips)}`,
      `textClickEditMode=${textClickEditMode}`,
      `zoomWheelSensitivity=${zoomWheelSensitivity.toFixed(2)}`,
      `textSnapStrength=${textSnapStrength}`,
      `tooltipDensity=${tooltipDensity}`,
      `animationStrength=${animationStrength}`,
      `uiDensity=${uiDensity}`,
      `assets=${assets.length}`,
      `activeId=${activeId ?? 'none'}`,
    ]
    const text = lines.join('\n')
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setStatus(ui.settingsCopiedDiagnostics)
    } catch {
      setStatus(text)
    }
  }

  async function copyActivityLog() {
    const text = buildActivityLogText('filtered')
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setStatus(ui.activityCopied)
    } catch {
      setStatus(text)
    }
  }

  async function copyShortcutKey(keyLabel: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(keyLabel)
      } else {
        const ta = document.createElement('textarea')
        ta.value = keyLabel
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setStatus(ui.shortcutCopied(keyLabel))
    } catch {
      setStatus(keyLabel)
    }
  }

  async function copyActivityItem(item: ToastLogItem) {
    const text = `[${formatLogTimestamp(item.at)}] ${activityKindLabel(item)}: ${item.text}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setStatus(ui.activityCopyItem)
    } catch {
      setStatus(text)
    }
  }

  function buildActivityLogText(mode: 'filtered' | 'all') {
    const source = mode === 'all' ? toastLog : filteredToastLog
    const lines = source.map((item) => `[${formatLogTimestamp(item.at)}] ${activityKindLabel(item)}: ${item.text}`)
    const header = [
      `Vora AI Activity Log`,
      `app=${APP_VERSION}`,
      `savedAt=${new Date().toISOString()}`,
      `scope=${mode}`,
      `activeFilter=${activityFilter}`,
      `count=${source.length}`,
      '',
    ]
    return `${header.join('\n')}${lines.length > 0 ? lines.join('\n') : ui.activityEmpty}`
  }

  function downloadActivityLog() {
    const pad = (n: number) => String(n).padStart(2, '0')
    const now = new Date()
    const filename = `vora_ai_activity_log_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`
    const blob = new Blob([buildActivityLogText(activityDownloadMode)], { type: 'text/plain;charset=utf-8' })
    downloadBlob(blob, filename)
    setStatus(ui.activityDownloaded(filename))
  }

  function clearActivityLog() {
    setToastLog([])
    setStatus(ui.activityCleared)
  }

  function resetSettingsToDefaults() {
    if (!window.confirm(ui.settingsResetConfirm)) return
    resetGeneralSettings()
    resetEditingSettings()
    resetExportSettings()
    setStatus(ui.settingsResetDone)
  }

  function resetGeneralSettings() {
    setBrushSize(DEFAULT_BRUSH_SIZE)
    setAutoSaveSeconds(DEFAULT_AUTOSAVE_SECONDS)
    setShowGuide(true)
    setActivityLogLimit(DEFAULT_ACTIVITY_LOG_LIMIT)
    setActivityFilter('all')
    setActivitySort('latest')
    setActivityDownloadMode('filtered')
    setShowActivityLog(false)
    setShowMobileQuickActions(true)
    setMobileQuickOrder(['export', 'activity', 'shortcuts', 'settings'])
    setPreferredDevice('cpu')
  }

  function resetEditingSettings() {
    setShowShortcutTips(true)
    setTextClickEditMode('single')
    setZoomWheelSensitivity(DEFAULT_ZOOM_WHEEL_SENSITIVITY)
    setTextSnapStrength('normal')
    setTooltipDensity('detailed')
    setAnimationStrength('high')
    setUiDensity('default')
  }

  function resetExportSettings() {
    setPendingExportFormat('png')
    setPendingExportRatio(2)
    setPendingExportScope('current')
    setPendingExportQuality(DEFAULT_EXPORT_QUALITY)
    setExportDefaultPreset('custom')
    setExportDefaultFormat('png')
    setExportDefaultScope('current')
  }

  function applyExportDefaults() {
    let nextRatio = pendingExportRatio
    let nextQuality = pendingExportQuality
    if (exportDefaultPreset === 'web') {
      nextRatio = 2
      nextQuality = 84
    } else if (exportDefaultPreset === 'print') {
      nextRatio = 4
      nextQuality = 95
    } else if (exportDefaultPreset === 'slides') {
      nextRatio = 2
      nextQuality = DEFAULT_EXPORT_QUALITY
    }
    setPendingExportFormat(exportDefaultFormat)
    setPendingExportScope(exportDefaultScope)
    setPendingExportRatio(nextRatio)
    setPendingExportQuality(nextQuality)
    setStatus(ui.settingsExportDefaultDone)
  }

  async function setDeviceMode(next: 'cpu' | 'cuda') {
    if (switchingDevice) return
    if (next === 'cuda' && !gpuSelectable) return
    setSwitchingDevice(true)
    try {
      const res = await fetch('/api/device', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'restore', device: next }),
      })
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!contentType.includes('application/json')) {
        const text = await res.text().catch(() => '')
        const snippet = text.slice(0, 140).replace(/\s+/g, ' ').trim()
        throw new Error(`ERR_API_BAD_JSON:${snippet}`)
      }

      const payload = (await res.json()) as {
        error?: string
        worker?: { device?: string; ready?: boolean; error?: string | null; requestedDevice?: 'auto' | 'cpu' | 'cuda'; cudaAvailable?: boolean | null }
      }
      if (!res.ok) {
        if (payload.error) setStatus(payload.error)
        return
      }
      const worker = payload.worker
      if (worker?.device) setAiDevice(worker.device)
      if (typeof worker?.ready === 'boolean') setAiReady(worker.ready)
      setAiError(worker?.error ?? null)
      if (worker?.requestedDevice === 'auto' || worker?.requestedDevice === 'cpu' || worker?.requestedDevice === 'cuda') {
        setAiRequestedDevice(worker.requestedDevice)
      }
      if (typeof worker?.cudaAvailable === 'boolean' || worker?.cudaAvailable === null) {
        setCudaAvailable(worker?.cudaAvailable ?? null)
      }
      setPreferredDevice(next)
    } catch (e) {
      setStatus(localizeErrorMessage(String(e instanceof Error ? e.message : e)))
    } finally {
      setSwitchingDevice(false)
    }
  }

  return (
    <div className={`app ${uiDensity === 'compact' ? 'densityCompact' : ''} ${showShortcutTips ? '' : 'shortcutsOff'} ${tooltipDensity === 'detailed' ? 'tooltipDetailed' : 'tooltipSimple'} ${tooltipsMuted ? 'tooltipsMuted' : ''} ${animationStrength === 'low' ? 'animLow' : animationStrength === 'high' ? 'animHigh' : ''} ${assets.length === 0 ? 'noSidebar noFilmstrip' : ''}`} onDragOver={onDragOverRoot} onDragLeave={onDragLeaveRoot} onDrop={onDropRoot}>
      {/* ═══ Header Bar ═══ */}
      <div className="headerBar">
        <div className="headerLeft">
          <div className="brand">
            <h1>Vora</h1>
          </div>
          <div className={`deviceBadge ${aiError ? 'error' : aiReady ? 'ready' : 'init'} ${selectedAvailable ? 'available' : 'unavailable'} ${restoreDeviceLabel === 'GPU' ? 'gpu' : 'cpu'}`}>
            <span className="deviceDot" />
            <span className="deviceEngineTag">{restoreDeviceLabel}</span>
            <span className={`deviceAvailability ${aiReady ? 'ok' : 'bad'}`}>
              {aiStatusText}
            </span>
          </div>
          {hasUnsavedChanges ? (
            <button
              className={`unsavedBadge ${dirtyChangeCount >= 10 ? 'tierHigh' : dirtyChangeCount >= 3 ? 'tierWarn' : 'tierLow'}`}
              type="button"
              title={unsavedTooltip}
              onClick={() => {
                if (!hasSelectedAssets && pendingExportScope === 'selected') {
                  setPendingExportScope('current')
                }
                setHighlightExportFormat(true)
                setExportDialogOpen(true)
              }}
            >
              {dirtyChangeCount > 0 ? ui.unsavedBadgeCount(dirtyChangeCount) : ui.unsavedBadge}
            </button>
          ) : null}
        </div>
        <div className="headerRight">
          <button className="headerIconBtn" onClick={() => setShowActivityLog((prev) => !prev)} title={showActivityLog ? ui.activityHide : ui.activityShow} aria-label={showActivityLog ? ui.activityHide : ui.activityShow}>
            🧾
          </button>
          <button className="headerIconBtn" onClick={() => setShowShortcutsHelp((prev) => !prev)} title={ui.shortcutsToggleHint} aria-label={ui.shortcutsHelp}>
            ⌨
          </button>
          <button
            className="headerIconBtn"
            onClick={() => (settingsOpen ? closeSettings() : openSettings())}
            aria-label={ui.settings}
            title={ui.settings}
          >
            ⚙
          </button>
        </div>
      </div>
      {showMobileQuickActions ? (
        <div className="mobileQuickRail" aria-label="mobile quick actions">
          {mobileQuickOrder.map((action) => (
            <button
              key={`mobile-${action}`}
              className={`mobileQuickBtn ${mobileQuickPressed === action ? 'pressed' : ''}`}
              onClick={() => {
                setMobileQuickPressed(null)
                runMobileQuickAction(action)
              }}
              onTouchStart={() => {
                setMobileQuickPressed(action)
                beginLongPressHint(mobileActionHint(action))
              }}
              onTouchEnd={() => {
                setMobileQuickPressed(null)
                cancelLongPressHint()
              }}
              onTouchCancel={() => {
                setMobileQuickPressed(null)
                cancelLongPressHint()
              }}
              aria-label={mobileActionLabel(action)}
              title={mobileActionLabel(action)}
            >
              {mobileActionIcon(action)}
            </button>
          ))}
        </div>
      ) : null}

      {/* ═══ Options Bar ═══ */}
      <div className="optionsBar">
        <div className="optionsGroup">
          <label className="btn ghost">
            {ui.import}
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.pdf"
              onChange={(e) => void handleFiles(e.target.files)}
              style={{ display: 'none' }}
            />
          </label>
          <button className="btn ghost" onClick={() => {
            if (!hasSelectedAssets && pendingExportScope === 'selected') {
              setPendingExportScope('current')
            }
            setExportDialogOpen(true)
          }} disabled={assets.length === 0 || !!busy}>{ui.exportNow}</button>
        </div>
        <div className="optionsDivider" />
        {active ? (
          <span className="optionsModeTag">
            {tool === 'text' ? ui.modeText : tool === 'crop' ? ui.modeCrop : tool === 'move' ? ui.modeMove : tool === 'restore' ? ui.modeRestore : tool === 'select' ? ui.modeSelect : ui.modeEraser}
          </span>
        ) : null}
        {active && (tool === 'restore' || tool === 'eraser') ? (
          <div className="optionsGroup optionsBrushRow">
            <span className="optionsLabel">{ui.brushSize}</span>
            <input
              className="input smoothRange"
              type="range"
              min={0}
              max={BRUSH_SLIDER_MAX}
              step={1}
              value={brushSliderValue}
              onChange={(e) => setBrushSize(sliderToBrush(Number(e.target.value)))}
            />
            <input
              className="input optionsBrushInput"
              type="number"
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              value={brushSize}
              onChange={(e) => setBrushSize(clamp(Number(e.target.value) || BRUSH_MIN, BRUSH_MIN, BRUSH_MAX))}
            />
            <span className="optionsLabel">{brushSize}px</span>
          </div>
        ) : null}
        {active && tool === 'select' ? (
          <div className="optionsGroup">
            <button className={`btn ghost ${selectMode === 'ai' ? 'active' : ''}`} onClick={() => setSelectMode('ai')}>{ui.selectModeAI}</button>
            <button className={`btn ghost ${selectMode === 'rect' ? 'active' : ''}`} onClick={() => setSelectMode('rect')}>{ui.selectModeRect}</button>
            <button className={`btn ghost ${selectMode === 'ellipse' ? 'active' : ''}`} onClick={() => setSelectMode('ellipse')}>{ui.selectModeEllipse}</button>
            <button className={`btn ghost ${selectMode === 'lasso' ? 'active' : ''}`} onClick={() => setSelectMode('lasso')}>{ui.selectModeLasso}</button>
            <div className="optionsDivider" />
            <button className="btn ghost primary" disabled={!!busy} onClick={() => void autoRemoveBackground()}>{ui.autoBgRemove}</button>
          </div>
        ) : null}
        {active && tool === 'move' ? (
          <div className="optionsGroup">
            <button className="btn ghost" disabled={!!busy} onClick={() => void rotateImage(90)}>↻ 90°</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => void rotateImage(270)}>↺ 90°</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => void flipImage('h')}>{ui.flipH}</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => void flipImage('v')}>{ui.flipV}</button>
          </div>
        ) : null}
        {active && tool === 'crop' ? (
          <div className="optionsGroup">
            <button className={`btn ghost ${cropPreset === 'free' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('free')}>{ui.cropPresetFree}</button>
            <button className={`btn ghost ${cropPreset === '1:1' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('1:1')}>{ui.cropPresetSquare}</button>
            <button className={`btn ghost ${cropPreset === '4:3' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('4:3')}>{ui.cropPresetFourThree}</button>
            <button className={`btn ghost ${cropPreset === '16:9' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('16:9')}>{ui.cropPresetSixteenNine}</button>
            <div className="optionsDivider" />
            <button className="btn ghost primary" disabled={!active || !activeCropRect || !!busy} onClick={() => void applyCrop()}>{ui.applyCrop}</button>
            <button className="btn ghost" disabled={!activeCropRect} onClick={() => clearCropSelection(ui.cancelCrop)}>{ui.cancelCrop}</button>
          </div>
        ) : null}
      </div>

      {/* ═══ Filmstrip ═══ */}
      {assets.length > 0 ? (
        <div className={`filmstrip ${guideFocusTarget === 'files' ? 'guideFlash' : ''}`}>
          {assets.map((a) => (
            <div
              key={a.id}
              ref={(node) => { assetCardRefs.current[a.id] = node }}
              className={`filmstripThumb ${a.id === activeId ? 'active' : ''} ${selectedAssetIds.includes(a.id) ? 'selected' : ''} ${a.id === flashAssetId ? 'flash' : ''} ${a.id === dragAssetId ? 'dragging' : ''} ${a.id === dragOverAssetId && a.id !== dragAssetId ? 'dropTarget' : ''}`}
              onClick={(e) => onAssetCardClick(e, a.id)}
              title={`${a.name} (${a.width}×${a.height})`}
              draggable
              onDragStart={(e) => onAssetDragStart(e, a.id)}
              onDragEnter={(e) => onAssetDragEnter(e, a.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onAssetDrop(e, a.id)}
              onDragEnd={() => { setDragAssetId(null); setDragOverAssetId(null) }}
            >
              <img src={a.baseDataUrl} alt={a.name} loading="lazy" decoding="async" />
              {selectedAssetIds.includes(a.id) ? <span className="filmstripOrder">{selectedAssetIds.indexOf(a.id) + 1}</span> : null}
              <button className="filmstripRemove" onClick={(e) => { e.stopPropagation(); removeAsset(a.id) }} title={ui.removeAsset} aria-label={ui.removeAsset}>×</button>
            </div>
          ))}
          <label className="filmstripAdd" title={ui.import}>
            +
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,.pdf"
              onChange={(e) => void handleFiles(e.target.files)}
              style={{ display: 'none' }}
            />
          </label>
          {assets.length > 1 ? (
            <div className="filmstripActions">
              <button className="btn ghost" onClick={() => setSelectedAssetIds(assets.map((a) => a.id))} disabled={assets.length === 0}>{ui.selectAllFiles}</button>
              <button className="btn ghost" onClick={() => setSelectedAssetIds([])} disabled={selectedAssetIds.length === 0}>{ui.unselectAllFiles}</button>
              <button className="btn ghost danger" onClick={clearAllAssets} disabled={assets.length === 0 || !!busy}>{ui.clearAllAssets}</button>
              {selectedAssetIds.length > 0 ? (
                <button className="selectionCountBadge" onClick={() => scrollToAsset(selectedAssetIds[0]!)} title={ui.selectionHint}>
                  {ui.selectedFilesCount(selectedAssetIds.length)}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {pendingAutoRestore ? (
        <div className="restorePrompt" role="dialog" aria-modal="true">
          <div className="restorePromptCard">
            <div className="restorePromptTitle">{ui.restorePromptTitle}</div>
            <div className="hint">{ui.restorePromptBody}</div>
            <div className="hint">{ui.settingsLastAutoSave}: {formatTimestamp(pendingAutoRestore.ts)}</div>
            <div className="restorePromptActions">
              <button className="btn" onClick={applyPendingAutoRestore}>{ui.restorePromptRestore}</button>
              <button className="btn ghost" onClick={discardPendingAutoRestore}>{ui.restorePromptDiscard}</button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="settingsBackdrop" onClick={closeSettings}>
          <div className="settingsDialog" onClick={(e) => e.stopPropagation()}>
            <div className="settingsHeader">
              <div className="settingsTitle">{ui.settingsTitle}</div>
              <button className="settingsCloseBtn" onClick={closeSettings}>{ui.settingsClose}</button>
            </div>
            <div className="settingsLayout">
              <div className="settingsSidebar">
                <div className="settingsTabs">
                  <button className={`settingsTab ${settingsTab === 'general' ? 'active' : ''}`} onClick={() => setSettingsTab('general')}>
                    <span className="settingsTabIcon" aria-hidden="true">⚙</span>{ui.settingsTabGeneral}
                  </button>
                  <button className={`settingsTab ${settingsTab === 'editing' ? 'active' : ''}`} onClick={() => setSettingsTab('editing')}>
                    <span className="settingsTabIcon" aria-hidden="true">✎</span>{ui.settingsTabEditing}
                  </button>
                  <button className={`settingsTab ${settingsTab === 'info' ? 'active' : ''}`} onClick={() => setSettingsTab('info')}>
                    <span className="settingsTabIcon" aria-hidden="true">ℹ</span>{ui.settingsTabInfo}
                  </button>
                </div>
              </div>

              <div className="settingsContent">
            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsLanguage}</div>
              <select className="langSelect settingsLangSelect" value={locale} onChange={(e) => setLocale(e.target.value as Locale)} aria-label={ui.language}>
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsAiRestoreDefault}</div>
              <select className="langSelect settingsLangSelect" value={preferredDevice} onChange={(e) => void setDeviceMode(e.target.value as 'cpu' | 'cuda')}>
                <option value="cpu">{ui.aiSetCpu} ({ui.available})</option>
                <option value="cuda" disabled={!gpuSelectable}>{ui.aiSetGpu} ({gpuSelectable ? ui.available : ui.unavailable})</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsBrushDefault}</div>
              <div className="settingsInline">
                <input
                  className="input settingsNumberInput"
                  type="number"
                  min={BRUSH_MIN}
                  max={BRUSH_MAX}
                  value={brushSize}
                  onChange={(e) => setBrushSize(clamp(Number(e.target.value) || BRUSH_MIN, BRUSH_MIN, BRUSH_MAX))}
                />
                <input
                  className="input smoothRange"
                  type="range"
                  min={0}
                  max={BRUSH_SLIDER_MAX}
                  step={1}
                  value={brushSliderValue}
                  onChange={(e) => setBrushSize(sliderToBrush(Number(e.target.value)))}
                />
              </div>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsAutoSave}</div>
              <select className="langSelect settingsLangSelect" value={String(autoSaveSeconds)} onChange={(e) => setAutoSaveSeconds(clamp(Number(e.target.value), 0, 300))}>
                <option value="0">{ui.settingsAutoSaveOff}</option>
                <option value="10">10s</option>
                <option value="30">30s</option>
                <option value="60">60s</option>
                <option value="120">120s</option>
              </select>
              <div className="hint">{ui.settingsLastAutoSave}: {formatTimestamp(lastAutoSaveAt)}</div>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsActivityLogLimit}</div>
              <select className="langSelect settingsLangSelect" value={String(activityLogLimit)} onChange={(e) => setActivityLogLimit(clamp(Number(e.target.value), 5, 20))}>
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="20">20</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <label className="settingsToggle">
                <input type="checkbox" checked={cropHideDocksOnCrop} onChange={(e) => setCropHideDocksOnCrop(e.target.checked)} />
                <span>{ui.settingsCropHideDocks}</span>
              </label>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <label className="settingsToggle">
                <input type="checkbox" checked={showMobileQuickActions} onChange={(e) => setShowMobileQuickActions(e.target.checked)} />
                <span>{ui.settingsMobileQuickActions}</span>
              </label>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsMobileQuickOrder}</div>
              <div className="mobileOrderList">
                {mobileQuickOrder.map((action, idx) => (
                  <div
                    className={`mobileOrderRow ${mobileQuickDrag === action ? 'dragging' : ''}`}
                    key={`order-${action}`}
                    draggable
                    onDragStart={() => setMobileQuickDrag(action)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (!mobileQuickDrag) return
                      reorderMobileQuickActions(mobileQuickDrag, action)
                      setMobileQuickDrag(null)
                    }}
                    onDragEnd={() => setMobileQuickDrag(null)}
                  >
                    <span className="mobileOrderName">{mobileActionLabel(action)}</span>
                    <div className="mobileOrderActions">
                      <button className="btn ghost" disabled={idx === 0} onClick={() => moveMobileQuickAction(action, -1)}>{ui.settingsMoveUp}</button>
                      <button className="btn ghost" disabled={idx === mobileQuickOrder.length - 1} onClick={() => moveMobileQuickAction(action, 1)}>{ui.settingsMoveDown}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsExportDefaults}</div>
              <div className="settingsInline exportDefaultsInline">
                <select className="langSelect settingsLangSelect" value={exportDefaultFormat} onChange={(e) => setExportDefaultFormat(e.target.value as ExportKind)}>
                  <option value="png">PNG</option>
                  <option value="jpg">JPG</option>
                  <option value="webp">WEBP</option>
                  <option value="pdf">PDF</option>
                  <option value="pptx">PPTX</option>
                </select>
                <select className="langSelect settingsLangSelect" value={exportDefaultPreset} onChange={(e) => setExportDefaultPreset(e.target.value as 'web' | 'print' | 'slides' | 'custom')}>
                  <option value="web">{ui.exportPresetWeb}</option>
                  <option value="print">{ui.exportPresetPrint}</option>
                  <option value="slides">{ui.exportPresetSlides}</option>
                  <option value="custom">{ui.settingsExportDefaultCustom}</option>
                </select>
              </div>
              <select className="langSelect settingsLangSelect" value={exportDefaultScope} onChange={(e) => setExportDefaultScope(e.target.value as ExportScope)}>
                <option value="current">{ui.exportScopeCurrent}</option>
                <option value="selected">{ui.exportScopeSelected}</option>
                <option value="all">{ui.exportScopeAll}</option>
              </select>
              <div className="settingsActionRow">
                <button className="btn" onClick={applyExportDefaults}>{ui.settingsExportDefaultApply}</button>
              </div>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={`${settingRowClass} settingsActionRow`}>
              <button className="btn ghost" onClick={resetGeneralSettings}>{ui.settingsResetGeneral}</button>
              <button className="btn ghost" onClick={resetExportSettings}>{ui.settingsResetExport}</button>
              <button className="btn ghost" onClick={resetSettingsToDefaults}>{ui.settingsResetDefaults}</button>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={`${settingRowClass} settingsActionRow`}>
              <button className="btn ghost" onClick={resetEditingSettings}>{ui.settingsResetEditing}</button>
            </div>
            ) : null}

            {settingsTab === 'general' ? (
            <div className={settingRowClass}>
              <label className="settingsToggle">
                <input type="checkbox" checked={showGuide} onChange={(e) => setShowGuide(e.target.checked)} />
                <span>{ui.settingsGuide}</span>
              </label>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <label className="settingsToggle">
                <input type="checkbox" checked={showShortcutTips} onChange={(e) => setShowShortcutTips(e.target.checked)} />
                <span>{ui.settingsShortcutTips}</span>
              </label>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsTextClickEditMode}</div>
              <select className="langSelect settingsLangSelect" value={textClickEditMode} onChange={(e) => setTextClickEditMode(e.target.value as TextClickEditMode)}>
                <option value="single">{ui.settingsTextClickEditSingle}</option>
                <option value="double">{ui.settingsTextClickEditDouble}</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsZoomWheelSensitivity}</div>
              <div className="settingsInline">
                <input
                  className="input settingsNumberInput"
                  type="number"
                  min={0.4}
                  max={2}
                  step={0.1}
                  value={Number(zoomWheelSensitivity.toFixed(1))}
                  onChange={(e) => setZoomWheelSensitivity(clamp(Number(e.target.value) || DEFAULT_ZOOM_WHEEL_SENSITIVITY, 0.4, 2))}
                />
                <input
                  className="input smoothRange"
                  type="range"
                  min={0.4}
                  max={2}
                  step={0.05}
                  value={zoomWheelSensitivity}
                  onChange={(e) => setZoomWheelSensitivity(clamp(Number(e.target.value), 0.4, 2))}
                />
              </div>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsTextSnapStrength}</div>
              <select className="langSelect settingsLangSelect" value={textSnapStrength} onChange={(e) => setTextSnapStrength(e.target.value as TextSnapStrength)}>
                <option value="off">{ui.settingsTextSnapOff}</option>
                <option value="soft">{ui.settingsTextSnapSoft}</option>
                <option value="normal">{ui.settingsTextSnapNormal}</option>
                <option value="strong">{ui.settingsTextSnapStrong}</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsTooltipDensity}</div>
              <select className="langSelect settingsLangSelect" value={tooltipDensity} onChange={(e) => setTooltipDensity(e.target.value as TooltipDensity)}>
                <option value="simple">{ui.settingsTooltipSimple}</option>
                <option value="detailed">{ui.settingsTooltipDetailed}</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsAnimationStrength}</div>
              <select className="langSelect settingsLangSelect" value={animationStrength} onChange={(e) => setAnimationStrength(e.target.value as AnimationStrength)}>
                <option value="low">{ui.settingsAnimationLow}</option>
                <option value="default">{ui.settingsAnimationDefault}</option>
                <option value="high">{ui.settingsAnimationHigh}</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'editing' ? (
            <div className={settingRowClass}>
              <div className="settingsLabel">{ui.settingsUiDensity}</div>
              <select className="langSelect settingsLangSelect" value={uiDensity} onChange={(e) => setUiDensity(e.target.value as 'default' | 'compact')}>
                <option value="default">{ui.settingsDensityDefault}</option>
                <option value="compact">{ui.settingsDensityCompact}</option>
              </select>
            </div>
            ) : null}

            {settingsTab === 'info' ? (
            <div className="settingsInfo">
              <div className="settingsInfoTitle">{ui.settingsInfo}</div>
              <div className="settingsInfoRow"><strong>{ui.settingsDeveloper}</strong><span>{ui.settingsName}</span></div>
              <div className="settingsLinkCards">
                <button className="settingsLinkCard" onClick={() => openExternalLink('https://hub.docker.com/r/xiukr/vora', ui.settingsDockerHub)}>
                  <span className="settingsLinkLabel">{ui.settingsDockerHub}</span>
                  <span className="settingsLinkUrl">hub.docker.com/r/xiukr/vora</span>
                </button>
                <button className="settingsLinkCard" onClick={() => openExternalLink('https://github.com/xiu-kr/vora', ui.settingsGitHub)}>
                  <span className="settingsLinkLabel">{ui.settingsGitHub}</span>
                  <span className="settingsLinkUrl">github.com/xiu-kr/vora</span>
                </button>
                <button className="settingsLinkCard" onClick={() => openExternalLink('https://github.com/xiu-kr', ui.settingsDocs)}>
                  <span className="settingsLinkLabel">{ui.settingsDocs}</span>
                  <span className="settingsLinkUrl">github.com/xiu-kr</span>
                </button>
              </div>
              <div className="settingsInfoActions">
                <button className="btn ghost" onClick={() => void copyDockerHubLink()}>{ui.settingsCopyDockerHub}</button>
                <button className="btn" onClick={() => void copyDiagnostics()}>{ui.settingsCopyDiagnostics}</button>
              </div>
            </div>
            ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ═══ Left Toolbar ═══ */}
      <div className={`toolbarLeft ${guideFocusTarget === 'tools' ? 'guideFlash' : ''}`}>
        <button className={`toolBtn ${tool === 'restore' ? 'active' : ''}`} title={ui.aiRestore} aria-label={ui.aiRestore} data-tip={ui.aiRestore} data-key="B" onClick={() => setTool('restore')} disabled={!active}>
          <FontAwesomeIcon icon={faWandMagicSparkles} />
        </button>
        <button className={`toolBtn ${tool === 'select' ? 'active' : ''}`} title={ui.aiSelect} aria-label={ui.aiSelect} data-tip={ui.aiSelect} data-key="S" onClick={() => setTool('select')} disabled={!active}>
          <FontAwesomeIcon icon={faObjectGroup} />
        </button>
        <button className={`toolBtn ${tool === 'move' ? 'active' : ''}`} title={ui.move} aria-label={ui.move} data-tip={ui.move} data-key="M" onClick={() => setTool('move')} disabled={!active}>
          <FontAwesomeIcon icon={faArrowsUpDownLeftRight} />
        </button>
        <button className={`toolBtn ${tool === 'eraser' ? 'active' : ''}`} title={ui.aiEraser} aria-label={ui.aiEraser} data-tip={ui.aiEraser} data-key="E" onClick={() => setTool('eraser')} disabled={!active}>
          <FontAwesomeIcon icon={faEraser} />
        </button>
        <div className="toolbarSep" />
        <button className={`toolBtn ${tool === 'text' ? 'active' : ''}`} title={ui.textSelectMode} aria-label={ui.textSelectMode} data-tip={ui.textSelectMode} data-key="T" onClick={() => setTool('text')} disabled={!active}>
          <FontAwesomeIcon icon={faFont} />
        </button>
        {tool === 'text' && active ? (
          <button className="toolBtn" title={ui.addTextLayer} aria-label={ui.addTextLayer} data-tip={ui.addTextLayer} onClick={addTextFromMenu}>
            <FontAwesomeIcon icon={faPlus} />
          </button>
        ) : null}
        <button className={`toolBtn ${tool === 'crop' ? 'active' : ''}`} title={ui.crop} aria-label={ui.crop} data-tip={ui.crop} data-key="C" onClick={() => setTool('crop')} disabled={!active}>
          <FontAwesomeIcon icon={faCropSimple} />
        </button>
        <div className="toolbarSep" />
        <button className="toolBtn" title={ui.zoomReset} aria-label={ui.zoomReset} data-tip={ui.zoomReset} onClick={() => { setZoom(1); setCanvasOffset({ x: 0, y: 0 }) }} disabled={!active}>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </button>
      </div>

      {/* ═══ Canvas ═══ */}
      <div
        className={`canvasWrap ${tool === 'text' ? 'textMode' : ''} ${tool === 'crop' ? 'cropMode' : ''} ${tool === 'move' ? 'moveMode' : ''} ${guideFocusTarget === 'canvas' ? 'guideFlash' : ''}`}
        ref={wrapRef}
      >
          {active ? (
            <div className={`canvasHistoryDock ${cropDockClass}`}>
              <button
                className="iconDockBtn"
                title={ui.undoAction}
                aria-label={ui.undoAction}
                data-tip={ui.undoAction}
                data-key="Ctrl/Cmd+Z"
                onClick={undoRestore}
                disabled={!canUndo}
              >
                <FontAwesomeIcon icon={faRotateLeft} />
              </button>
              <button
                className="iconDockBtn"
                title={ui.redoAction}
                aria-label={ui.redoAction}
                data-tip={ui.redoAction}
                data-key="Shift+Ctrl/Cmd+Z"
                onClick={redoRestore}
                disabled={!canRedo}
              >
                <FontAwesomeIcon icon={faRotateRight} />
              </button>
            </div>
          ) : null}
          {showGuide ? (
            <div className="guideCard">
              <button className="guideCardClose" onClick={() => setShowGuide(false)} aria-label={ui.guideClose} title={ui.guideClose}>×</button>
              <div className="guideTitle">{ui.guideTitle}</div>
              <button type="button" className="guideStep" onClick={() => flashGuideTarget('files')}>
                <span className="guideNum">1</span>
                <div className="guideContent">
                  <p>{ui.guideStepImport}</p>
                  <div className="guideMeta">{ui.guideMetaImport}</div>
                </div>
              </button>
              <button type="button" className="guideStep" onClick={() => flashGuideTarget('tools')}>
                <span className="guideNum">2</span>
                <div className="guideContent">
                  <p>{ui.guideStepTool}</p>
                  <div className="guideMeta">{ui.guideMetaTool}</div>
                </div>
              </button>
              <button type="button" className="guideStep" onClick={() => flashGuideTarget('canvas')}>
                <span className="guideNum">3</span>
                <div className="guideContent">
                  <p>{ui.guideStepRun}</p>
                  <div className="guideMeta">{ui.guideMetaRun}</div>
                </div>
              </button>
              <button type="button" className="guideStep" onClick={() => flashGuideTarget('export')}>
                <span className="guideNum">4</span>
                <div className="guideContent">
                  <p>{ui.guideStepExport}</p>
                  <div className="guideMeta">{ui.guideMetaExport}</div>
                </div>
              </button>
            </div>
          ) : null}
          {textQuickBarPos && selectedText ? (
            <div
              className={`textQuickBar ${draggingQuickBar ? 'dragging' : ''}`}
              style={tinyViewport
                ? { position: 'fixed', left: 10, right: 10, bottom: 10 }
                : { left: textQuickBarPos.left, top: textQuickBarPos.top }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button type="button" className="quickBarHandle" onMouseDown={startQuickBarDrag} aria-label={ui.quickBarMove}><span aria-hidden="true">⋮⋮</span><span className="srOnly">{ui.quickBarMove}</span></button>
              <button
                type="button"
                className="quickBarToggle"
                aria-label={ui.quickBarToggle}
                onClick={() => setQuickBarCollapsed((prev) => !prev)}
              >
                {quickBarCollapsed ? '▸' : '▾'}
              </button>
              {!quickBarCollapsed ? (
                <>
                  <div className="quickBarGroup">
                    <button className={`iconMini ${selectedText.align === 'left' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ align: 'left' })} aria-label={ui.alignLeft}><span aria-hidden="true">↤</span><span className="srOnly">{ui.alignLeft}</span></button>
                    <button className={`iconMini ${selectedText.align === 'center' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ align: 'center' })} aria-label={ui.alignCenter}><span aria-hidden="true">↔</span><span className="srOnly">{ui.alignCenter}</span></button>
                    <button className={`iconMini ${selectedText.align === 'right' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ align: 'right' })} aria-label={ui.alignRight}><span aria-hidden="true">↦</span><span className="srOnly">{ui.alignRight}</span></button>
                  </div>
                  <div className="quickBarGroup">
                    <button className="iconMini" disabled={selectedText.locked} onClick={() => updateSelectedText({ fontWeight: 400 })} aria-label={ui.fontWeightRegular}><span aria-hidden="true">R</span><span className="srOnly">{ui.fontWeightRegular}</span></button>
                    <button className="iconMini" disabled={selectedText.locked} onClick={() => updateSelectedText({ fontWeight: 700 })} aria-label={ui.fontWeightBold}><span aria-hidden="true">B</span><span className="srOnly">{ui.fontWeightBold}</span></button>
                    <button className={`iconMini ${selectedText.fontStyle === 'italic' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ fontStyle: selectedText.fontStyle === 'italic' ? 'normal' : 'italic' })} aria-label={ui.italicLabel}><span aria-hidden="true">I</span><span className="srOnly">{ui.italicLabel}</span></button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {active ? (
            <>
              {editingTextId && selectedText ? (
                <textarea
                  ref={inlineEditorRef}
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onBlur={onInlineEditorBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelInlineEdit()
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      commitInlineEdit()
                    }
                  }}
                  className="inlineEditor"
                  style={{
                    position: 'absolute',
                    zIndex: 10,
                    left: fit.ox + selectedText.x * fit.scale,
                    top: fit.oy + selectedText.y * fit.scale,
                    width: Math.max(160, 420 * fit.scale),
                    height: Math.max(44, 90 * fit.scale),
                    resize: 'none',
                  }}
                />
              ) : null}

              <Stage
                ref={(n) => {
                  stageRef.current = n
                }}
               dragDistance={5}
               width={wrapSize.w}
               height={wrapSize.h}
               onMouseDown={onStageMouseDown}
               onMouseMove={onStageMouseMove}
               onMouseUp={onStageMouseUp}
               onMouseLeave={onStageMouseLeave}
               onDblClick={onStageDblClick}
               onDblTap={onStageDblClick}
               onContextMenu={onStageContextMenu}
               style={{ cursor: stageCursor }}
            >
              <Layer>
                <Group x={fit.ox} y={fit.oy} scaleX={fit.scale} scaleY={fit.scale}>
                  <Rect x={0} y={0} width={active.width} height={active.height} fill="rgba(0,0,0,0.08)" />
                  {baseImg ? (
                    <KonvaImage image={baseImg} x={0} y={0} width={active.width} height={active.height} />
                  ) : null}
                </Group>
              </Layer>

              {showGrid && (
                <Layer listening={false}>
                  <Group x={fit.ox} y={fit.oy} scaleX={fit.scale} scaleY={fit.scale}>
                    {Array.from({ length: Math.floor(active.width / gridSpacing) + 1 }, (_, i) => (
                      <Line key={`gv${i}`}
                        points={[i * gridSpacing, 0, i * gridSpacing, active.height]}
                        stroke="rgba(128,128,255,0.3)" strokeWidth={1 / fit.scale} listening={false} />
                    ))}
                    {Array.from({ length: Math.floor(active.height / gridSpacing) + 1 }, (_, i) => (
                      <Line key={`gh${i}`}
                        points={[0, i * gridSpacing, active.width, i * gridSpacing]}
                        stroke="rgba(128,128,255,0.3)" strokeWidth={1 / fit.scale} listening={false} />
                    ))}
                  </Group>
                </Layer>
              )}

              <Layer>
                <Group x={fit.ox} y={fit.oy} scaleX={fit.scale} scaleY={fit.scale}>
                  {active.texts.filter((t) => t.visible).map((t) => (
                    <Group key={t.id} listening={tool === 'text' || tool === 'move'}>
                      {(() => {
                        const box = estimateTextBoxPx(t.text, t, active)
                        const padX = 8
                        const padY = 5
                        const backgroundOpacity = resolveTextBackgroundOpacity(t)
                        return backgroundOpacity > 0.001 ? (
                          <Rect
                            id={`text-bg:${t.id}`}
                            x={t.x - padX}
                            y={t.y - padY}
                            width={box.width + padX * 2}
                            height={box.height + padY * 2}
                            fill={resolveTextBackgroundColor(t)}
                            opacity={backgroundOpacity}
                            rotation={t.rotation}
                            listening={tool !== 'restore' && tool !== 'eraser'}
                            draggable={!t.locked && (tool === 'move' || tool === 'text')}
                            onDragStart={() => {
                              if (!selectedTextIds.includes(t.id)) selectTextLayer(t.id)
                              textDragMovedRef.current[t.id] = false
                            }}
                            onDragMove={(e) => {
                              if (!active) return
                              const textNode = textNodeRefs.current[t.id]
                              if (!textNode) return
                              textDragMovedRef.current[t.id] = true
                              textNode.x(e.target.x() + padX)
                              textNode.y(e.target.y() + padY)
                              snapTextDuringDrag(textNode, active, !!e.evt.shiftKey)
                              e.target.x(textNode.x() - padX)
                              e.target.y(textNode.y() - padY)
                            }}
                            onDragEnd={(e) => {
                              if (t.locked) return
                              const textNode = textNodeRefs.current[t.id]
                              const nextX = textNode ? textNode.x() : e.target.x() + padX
                              const nextY = textNode ? textNode.y() : e.target.y() + padY
                              setDragGuides({})
                              setDragMetrics(null)
                              if (textDragMovedRef.current[t.id]) lastTextDragAtRef.current = Date.now()
                              delete textDragMovedRef.current[t.id]
                              updateActiveWithHistory('Move text layer', (a) => ({
                                ...a,
                                texts: a.texts.map((tt) => (tt.id === t.id ? { ...tt, x: nextX, y: nextY } : tt)),
                              }))
                            }}
                            onClick={(evt) => {
                              if (Date.now() - lastTextDragAtRef.current < 220) return
                              selectTextLayer(t.id, !!evt.evt.shiftKey)
                            }}
                            onTap={() => {
                              if (Date.now() - lastTextDragAtRef.current < 220) return
                              selectTextLayer(t.id)
                            }}
                            onDblClick={(evt) => {
                              selectTextLayer(t.id, !!evt.evt.shiftKey)
                              if (tool === 'text' && !t.locked) beginInlineEdit(t)
                            }}
                            onDblTap={() => {
                              selectTextLayer(t.id)
                              if (tool === 'text' && !t.locked) beginInlineEdit(t)
                            }}
                          />
                        ) : null
                      })()}
                      <Text
                        id={t.id}
                        x={t.x}
                        y={t.y}
                        text={t.text}
                        fontFamily={t.fontFamily}
                        fontSize={t.fontSize}
                        fontStyle={toKonvaFontStyle(t)}
                        fill={t.fill}
                        rotation={t.rotation}
                        align={t.align}
                        opacity={t.opacity}
                        stroke={resolveTextOutlineColor(t)}
                        strokeWidth={1.2}
                        paintStrokeEnabled
                        draggable={!t.locked && (tool === 'move' || tool === 'text')}
                        listening={tool !== 'restore' && tool !== 'eraser'}
                        ref={(node) => {
                          if (node) textNodeRefs.current[t.id] = node
                        }}
                        onClick={(evt) => {
                          if (Date.now() - lastTextDragAtRef.current < 220) return
                          selectTextLayer(t.id, !!evt.evt.shiftKey)
                        }}
                        onTap={() => {
                          if (Date.now() - lastTextDragAtRef.current < 220) return
                          selectTextLayer(t.id)
                        }}
                        onDblClick={(evt) => {
                          selectTextLayer(t.id, !!evt.evt.shiftKey)
                          if (tool === 'text' && !t.locked) beginInlineEdit(t)
                        }}
                        onDblTap={() => {
                          selectTextLayer(t.id)
                          if (tool === 'text' && !t.locked) beginInlineEdit(t)
                        }}
                        onDragStart={() => {
                          if (!selectedTextIds.includes(t.id)) selectTextLayer(t.id)
                          textDragMovedRef.current[t.id] = false
                        }}
                        onDragMove={(e) => {
                          if (!active) return
                          textDragMovedRef.current[t.id] = true
                          snapTextDuringDrag(e.target as Konva.Text, active, !!e.evt.shiftKey)
                        }}
                        onDragEnd={(e) => {
                          if (t.locked) return
                          setDragGuides({})
                          setDragMetrics(null)
                          if (textDragMovedRef.current[t.id]) lastTextDragAtRef.current = Date.now()
                          delete textDragMovedRef.current[t.id]
                          updateActiveWithHistory('Move text layer', (a) => ({
                            ...a,
                            texts: a.texts.map((tt) =>
                              tt.id === t.id ? { ...tt, x: e.target.x(), y: e.target.y() } : tt,
                            ),
                          }))
                        }}
                        onTransformStart={(e) => {
                          const node = e.target as Konva.Text
                          const rect = node.getClientRect({ relativeTo: node.getParent() ?? undefined })
                          textTransformBaseRef.current = {
                            textId: t.id,
                            fontSize: t.fontSize,
                            rectHeight: Math.max(1, rect.height),
                          }
                        }}
                        onTransformEnd={(e) => {
                          if (t.locked) return
                          setDragMetrics(null)
                          const node = e.target as Konva.Text
                          const base = textTransformBaseRef.current
                          const rect = node.getClientRect({ relativeTo: node.getParent() ?? undefined })
                          const scaleBased = Math.max(0.2, Math.max(Math.abs(node.scaleX()), Math.abs(node.scaleY())))
                          const heightBased = base && base.textId === t.id ? Math.max(0.2, rect.height / Math.max(1, base.rectHeight)) : 1
                          const ratio = Math.abs(scaleBased - 1) > 0.01 ? scaleBased : heightBased
                          const sourceFontSize = base && base.textId === t.id ? base.fontSize : t.fontSize
                          const nextFontSize = clamp(Math.round(sourceFontSize * ratio), 8, 240)
                          node.scaleX(1)
                          node.scaleY(1)
                          textTransformBaseRef.current = null
                          updateActiveWithHistory('Transform text layer', (a) => ({
                            ...a,
                            texts: a.texts.map((tt) =>
                              tt.id === t.id
                                ? {
                                    ...tt,
                                    x: node.x(),
                                    y: node.y(),
                                    rotation: node.rotation(),
                                    fontSize: nextFontSize,
                                  }
                                : tt,
                            ),
                          }))
                        }}
                        shadowColor={selectedTextIds.includes(t.id) ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.35)'}
                        shadowBlur={selectedTextIds.includes(t.id) ? 12 : 8}
                        shadowOpacity={0.9}
                      />
                    </Group>
                  ))}

                  <Transformer
                    ref={(n) => {
                      transformerRef.current = n
                    }}
                    rotateEnabled
                    enabledAnchors={['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']}
                    anchorSize={10}
                    borderStroke="rgba(255,255,255,0.78)"
                    borderDash={[4, 4]}
                    anchorFill="rgba(255,255,255,0.92)"
                    anchorStroke="rgba(22,22,22,0.72)"
                    keepRatio
                  />
                </Group>
              </Layer>

              <Layer>
                <Group x={fit.ox} y={fit.oy} scaleX={fit.scale} scaleY={fit.scale}>
                  {tool === 'select' && selectionMaskImage ? (
                    <KonvaImage
                      image={selectionMaskImage}
                      x={0}
                      y={0}
                      width={active.width}
                      height={active.height}
                      opacity={1}
                      listening={false}
                    />
                  ) : null}
                  {tool === 'select' && selectionMaskBounds && (
                    <>
                      <Rect
                        stroke="white"
                        strokeWidth={1.5 / fit.scale}
                        dash={[5 / fit.scale, 5 / fit.scale]}
                        dashOffset={-antsDashOffset / fit.scale}
                        x={selectionMaskBounds.x}
                        y={selectionMaskBounds.y}
                        width={selectionMaskBounds.width}
                        height={selectionMaskBounds.height}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                      <Rect
                        stroke="black"
                        strokeWidth={1.5 / fit.scale}
                        dash={[5 / fit.scale, 5 / fit.scale]}
                        dashOffset={(-antsDashOffset + 8) / fit.scale}
                        x={selectionMaskBounds.x}
                        y={selectionMaskBounds.y}
                        width={selectionMaskBounds.width}
                        height={selectionMaskBounds.height}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                    </>
                  )}
                  {tool === 'select' && marqueeRect && selectMode === 'rect' && (
                    <Rect
                      x={marqueeRect.x} y={marqueeRect.y}
                      width={marqueeRect.width} height={marqueeRect.height}
                      stroke="white" strokeWidth={1.5 / fit.scale}
                      dash={[5 / fit.scale, 5 / fit.scale]}
                      dashOffset={-antsDashOffset / fit.scale}
                      fill="rgba(30,144,255,0.15)"
                      listening={false}
                    />
                  )}
                  {tool === 'select' && marqueeRect && selectMode === 'ellipse' && (
                    <Ellipse
                      x={marqueeRect.x + marqueeRect.width / 2}
                      y={marqueeRect.y + marqueeRect.height / 2}
                      radiusX={marqueeRect.width / 2} radiusY={marqueeRect.height / 2}
                      stroke="white" strokeWidth={1.5 / fit.scale}
                      dash={[5 / fit.scale, 5 / fit.scale]}
                      dashOffset={-antsDashOffset / fit.scale}
                      fill="rgba(30,144,255,0.15)"
                      listening={false}
                    />
                  )}
                  {tool === 'select' && selectMode === 'lasso' && lassoPoints.length >= 4 && (
                    <Line
                      points={lassoPoints}
                      stroke="white" strokeWidth={1.5 / fit.scale}
                      dash={[5 / fit.scale, 5 / fit.scale]}
                      closed={false} listening={false}
                    />
                  )}
                  {active.maskStrokes.map((l) => (
                    <Line
                      key={l.id}
                      points={l.points}
                      stroke={pendingMaskAction && pendingMaskAction.assetId === active.id && pendingMaskAction.tool === 'restore'
                        ? `rgba(107, 214, 255, ${maskPreviewOpacity.toFixed(3)})`
                        : `rgba(255, 86, 86, ${maskPreviewOpacity.toFixed(3)})`}
                      strokeWidth={l.strokeWidth}
                      lineCap="round"
                      lineJoin="round"
                      tension={0}
                    />
                  ))}

                  {pendingMaskBounds ? (
                    <Rect
                      x={pendingMaskBounds.x}
                      y={pendingMaskBounds.y}
                      width={pendingMaskBounds.width}
                      height={pendingMaskBounds.height}
                      stroke="rgba(255,255,255,0.55)"
                      dash={[5, 4]}
                      strokeWidth={1.2}
                      listening={false}
                    />
                  ) : null}

                  {dragGuides.x !== undefined ? (
                    <>
                      <Line
                        points={[dragGuides.x, 0, dragGuides.x, active.height]}
                        stroke={`rgba(255,255,255,${(guidePulse * 0.82).toFixed(3)})`}
                        strokeWidth={1.15}
                        dash={[6, 5]}
                        listening={false}
                      />
                      <Line
                        points={[dragGuides.x, 0, dragGuides.x, active.height]}
                        stroke={`rgba(94,224,255,${(guidePulse * 0.54).toFixed(3)})`}
                        strokeWidth={2.3}
                        listening={false}
                      />
                    </>
                  ) : null}
                  {dragGuides.y !== undefined ? (
                    <>
                      <Line
                        points={[0, dragGuides.y, active.width, dragGuides.y]}
                        stroke={`rgba(255,255,255,${(guidePulse * 0.82).toFixed(3)})`}
                        strokeWidth={1.15}
                        dash={[6, 5]}
                        listening={false}
                      />
                      <Line
                        points={[0, dragGuides.y, active.width, dragGuides.y]}
                        stroke={`rgba(94,224,255,${(guidePulse * 0.54).toFixed(3)})`}
                        strokeWidth={2.3}
                        listening={false}
                      />
                    </>
                  ) : null}

                  {dragMetrics ? (
                    <>
                      <Text
                        x={8}
                        y={8}
                        text={`${dragMetrics.left}px`}
                        fontSize={11}
                        fill={`rgba(236,250,255,${(guidePulse * 0.96).toFixed(3)})`}
                        stroke="rgba(8,18,24,0.72)"
                        strokeWidth={0.7}
                        listening={false}
                      />
                      <Text
                        x={active.width - 66}
                        y={8}
                        text={`${dragMetrics.right}px`}
                        fontSize={11}
                        fill={`rgba(236,250,255,${(guidePulse * 0.96).toFixed(3)})`}
                        stroke="rgba(8,18,24,0.72)"
                        strokeWidth={0.7}
                        listening={false}
                      />
                      <Text
                        x={8}
                        y={active.height - 20}
                        text={`${dragMetrics.bottom}px`}
                        fontSize={11}
                        fill={`rgba(236,250,255,${(guidePulse * 0.96).toFixed(3)})`}
                        stroke="rgba(8,18,24,0.72)"
                        strokeWidth={0.7}
                        listening={false}
                      />
                      <Text
                        x={active.width - 66}
                        y={active.height - 20}
                        text={`${dragMetrics.top}px`}
                        fontSize={11}
                        fill={`rgba(236,250,255,${(guidePulse * 0.96).toFixed(3)})`}
                        stroke="rgba(8,18,24,0.72)"
                        strokeWidth={0.7}
                        listening={false}
                      />
                    </>
                  ) : null}

                  {(tool === 'restore' || tool === 'eraser') && brushCursor.visible ? (
                    <Circle
                      x={brushCursor.x}
                      y={brushCursor.y}
                      radius={Math.max(3, brushSize / 2)}
                      stroke="rgba(100,210,255,0.85)"
                      strokeWidth={1.5}
                      fill="rgba(100,210,255,0.12)"
                      listening={false}
                    />
                  ) : null}

                  {activeCropRect ? (
                    <>
                      <Rect x={0} y={0} width={active.width} height={activeCropRect.y} fill="rgba(7, 12, 18, 0.5)" listening={false} />
                      <Rect
                        x={0}
                        y={activeCropRect.y + activeCropRect.height}
                        width={active.width}
                        height={Math.max(0, active.height - (activeCropRect.y + activeCropRect.height))}
                        fill="rgba(7, 12, 18, 0.5)"
                        listening={false}
                      />
                      <Rect x={0} y={activeCropRect.y} width={activeCropRect.x} height={activeCropRect.height} fill="rgba(7, 12, 18, 0.5)" listening={false} />
                      <Rect
                        x={activeCropRect.x + activeCropRect.width}
                        y={activeCropRect.y}
                        width={Math.max(0, active.width - (activeCropRect.x + activeCropRect.width))}
                        height={activeCropRect.height}
                        fill="rgba(7, 12, 18, 0.5)"
                        listening={false}
                      />
                      <Rect
                        x={activeCropRect.x}
                        y={activeCropRect.y}
                        width={activeCropRect.width}
                        height={activeCropRect.height}
                        stroke="rgba(100,210,255,0.95)"
                        dash={[6, 5]}
                        strokeWidth={2}
                        listening={false}
                      />
                      <Circle x={activeCropRect.x} y={activeCropRect.y} radius={4.5} fill="rgba(100,210,255,0.96)" stroke="rgba(7,12,18,0.85)" strokeWidth={1.2} listening={false} />
                      <Circle x={activeCropRect.x + activeCropRect.width} y={activeCropRect.y} radius={4.5} fill="rgba(100,210,255,0.96)" stroke="rgba(7,12,18,0.85)" strokeWidth={1.2} listening={false} />
                      <Circle x={activeCropRect.x} y={activeCropRect.y + activeCropRect.height} radius={4.5} fill="rgba(100,210,255,0.96)" stroke="rgba(7,12,18,0.85)" strokeWidth={1.2} listening={false} />
                      <Circle x={activeCropRect.x + activeCropRect.width} y={activeCropRect.y + activeCropRect.height} radius={4.5} fill="rgba(100,210,255,0.96)" stroke="rgba(7,12,18,0.85)" strokeWidth={1.2} listening={false} />
                      <Text
                        x={activeCropRect.x + 6}
                        y={Math.max(4, activeCropRect.y - 20)}
                        text={`${activeCropRect.width} × ${activeCropRect.height}`}
                        fontSize={11}
                        fill="rgba(203, 235, 255, 0.98)"
                        listening={false}
                      />
                    </>
                  ) : null}
                </Group>
              </Layer>
              </Stage>
            </>
          ) : (
            <div className="panelBody emptyCanvasBody">
              <div className="emptyHero">
                <div className="emptyHeroTitle">Vora AI</div>
                <div className="emptyHeroSubtitle">{ui.heroSubtitle}</div>
                <a className="emptyHeroRepo" href="https://github.com/xiu-kr/vora" target="_blank" rel="noreferrer">
                  {ui.heroRepo}
                </a>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Right Sidebar ═══ */}
        {assets.length > 0 ? (
        <div className="rightSidebar">

        {/* ── Properties accordion ── */}
        <div className={`accordionSection ${accordionState.properties ? 'expanded' : ''}`}>
          <button className="accordionHeader" onClick={() => toggleAccordion('properties')}>
            {ui.controls}
            <span className="accordionChevron">{accordionState.properties ? '▾' : '▸'}</span>
          </button>
          {accordionState.properties ? (
            <div className="accordionBody">
            {tool !== 'text' ? (
            <>
              {tool === 'restore' ? (
                <>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.brushSize}</div>
                    <div className="propRow">
                      <span className="propLabel">Size</span>
                      <div className="propValue">
                        <input
                          className="input smoothRange"
                          type="range"
                          min={0}
                          max={BRUSH_SLIDER_MAX}
                          step={1}
                          value={brushSliderValue}
                          onChange={(e) => setBrushSize(sliderToBrush(Number(e.target.value)))}
                        />
                        <div className="propInline">
                          <input
                            className="input"
                            type="number"
                            min={BRUSH_MIN}
                            max={BRUSH_MAX}
                            value={brushSize}
                            onChange={(e) => setBrushSize(clamp(Number(e.target.value) || BRUSH_MIN, BRUSH_MIN, BRUSH_MAX))}
                          />
                          <span className="propUnit">px</span>
                        </div>
                      </div>
                    </div>
                    <div className="hint">{ui.restoreHint}</div>
                  </div>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.macroCount}</div>
                    <div className="propRow">
                      <span className="propLabel">Repeat</span>
                      <div className="propValue">
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={10}
                          value={macroRepeatCount}
                          onChange={(e) => setMacroRepeatCount(clamp(Number(e.target.value), 1, 10))}
                          style={{ width: 52 }}
                        />
                      </div>
                    </div>
                    <div className="propBtnGrid cols2">
                      <button className="btn primary" disabled={!!busy} onClick={() => void runMacroWithConfirm('restore', 'all')}>
                        {macroRunningTool === 'restore' && macroRunningMode === 'all' ? ui.macroRunningAll : ui.macroRunAll}
                      </button>
                      <button className="btn" disabled={!!busy || !hasSelectedAssets} onClick={() => void runMacroWithConfirm('restore', 'selected')}>
                        {macroRunningTool === 'restore' && macroRunningMode === 'selected' ? ui.macroRunningSelected : ui.macroRunSelected}
                      </button>
                    </div>
                    <div className="hint">{ui.macroHint}</div>
                  </div>
                </>
              ) : null}

              {tool === 'eraser' ? (
                <>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.brushSize}</div>
                    <div className="propRow">
                      <span className="propLabel">Size</span>
                      <div className="propValue">
                        <input
                          className="input smoothRange"
                          type="range"
                          min={0}
                          max={BRUSH_SLIDER_MAX}
                          step={1}
                          value={brushSliderValue}
                          onChange={(e) => setBrushSize(sliderToBrush(Number(e.target.value)))}
                        />
                        <div className="propInline">
                          <input
                            className="input"
                            type="number"
                            min={BRUSH_MIN}
                            max={BRUSH_MAX}
                            value={brushSize}
                            onChange={(e) => setBrushSize(clamp(Number(e.target.value) || BRUSH_MIN, BRUSH_MIN, BRUSH_MAX))}
                          />
                          <span className="propUnit">px</span>
                        </div>
                      </div>
                    </div>
                    <div className="hint">{ui.eraserHint}</div>
                  </div>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.macroCount}</div>
                    <div className="propRow">
                      <span className="propLabel">Repeat</span>
                      <div className="propValue">
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={10}
                          value={macroRepeatCount}
                          onChange={(e) => setMacroRepeatCount(clamp(Number(e.target.value), 1, 10))}
                          style={{ width: 52 }}
                        />
                      </div>
                    </div>
                    <div className="propBtnGrid cols2">
                      <button className="btn primary" disabled={!!busy} onClick={() => void runMacroWithConfirm('eraser', 'all')}>
                        {macroRunningTool === 'eraser' && macroRunningMode === 'all' ? ui.macroRunningAll : ui.macroRunAll}
                      </button>
                      <button className="btn" disabled={!!busy || !hasSelectedAssets} onClick={() => void runMacroWithConfirm('eraser', 'selected')}>
                        {macroRunningTool === 'eraser' && macroRunningMode === 'selected' ? ui.macroRunningSelected : ui.macroRunSelected}
                      </button>
                    </div>
                    <div className="hint">{ui.macroHint}</div>
                  </div>
                </>
              ) : null}

              {tool === 'move' && active ? (
                <>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.imageTransform}</div>
                    <div className="propBtnGrid cols3">
                      <button className="btn" disabled={!!busy} onClick={() => void rotateImage(90)}>↻ 90°</button>
                      <button className="btn" disabled={!!busy} onClick={() => void rotateImage(270)}>↺ 90°</button>
                      <button className="btn" disabled={!!busy} onClick={() => void rotateImage(180)}>180°</button>
                    </div>
                    <div className="propBtnGrid cols2" style={{ marginTop: 3 }}>
                      <button className="btn" disabled={!!busy} onClick={() => void flipImage('h')}>{ui.flipH}</button>
                      <button className="btn" disabled={!!busy} onClick={() => void flipImage('v')}>{ui.flipV}</button>
                    </div>
                  </div>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.imageResize}</div>
                    <div className="propRow">
                      <span className="propLabel">W</span>
                      <div className="propValue">
                        <input className="input" type="number" min={1} value={resizeWidth} onChange={(e) => {
                          const v = Number(e.target.value)
                          setResizeWidth(v)
                          if (resizeLockAspect && active) setResizeHeight(Math.round(v * (active.height / active.width)))
                        }} style={{ width: 72 }} />
                        <span className="propUnit">px</span>
                      </div>
                    </div>
                    <div className="propRow">
                      <span className="propLabel">H</span>
                      <div className="propValue">
                        <input className="input" type="number" min={1} value={resizeHeight} onChange={(e) => {
                          const v = Number(e.target.value)
                          setResizeHeight(v)
                          if (resizeLockAspect && active) setResizeWidth(Math.round(v * (active.width / active.height)))
                        }} style={{ width: 72 }} />
                        <span className="propUnit">px</span>
                        <button className="btn" title={ui.lockAspect} onClick={() => setResizeLockAspect((p) => !p)} style={{ minWidth: 28, padding: '2px 4px' }}>
                          {resizeLockAspect ? '🔒' : '🔓'}
                        </button>
                      </div>
                    </div>
                    <div className="propBtnGrid cols2">
                      <button className="btn primary" disabled={!!busy} onClick={() => void applyResize()}>{ui.applyResize}</button>
                    </div>
                  </div>
                </>
              ) : null}

              {tool === 'select' ? (
                <>
                  <div className="propSection">
                    <div className="propSectionTitle">Mode</div>
                    <div className="propBtnGrid cols4">
                      <button className={`btn ${selectMode === 'ai' ? 'active' : ''}`} onClick={() => setSelectMode('ai')}>{ui.selectModeAI}</button>
                      <button className={`btn ${selectMode === 'rect' ? 'active' : ''}`} onClick={() => setSelectMode('rect')}>{ui.selectModeRect}</button>
                      <button className={`btn ${selectMode === 'ellipse' ? 'active' : ''}`} onClick={() => setSelectMode('ellipse')}>{ui.selectModeEllipse}</button>
                      <button className={`btn ${selectMode === 'lasso' ? 'active' : ''}`} onClick={() => setSelectMode('lasso')}>{ui.selectModeLasso}</button>
                    </div>
                    <div className="propBtnGrid cols2" style={{ marginTop: 4 }}>
                      <button className="btn primary" disabled={!!busy} onClick={() => void autoRemoveBackground()}>{ui.autoBgRemove}</button>
                    </div>
                    <div className="hint" style={{ marginTop: 3 }}>{selectionMaskDataUrl ? ui.selectionToolHintHasSelection : ui.selectionToolHint}</div>
                    {selectionMaskBounds ? <div className="hint">{ui.aiPreviewArea}: {selectionMaskBounds.width} x {selectionMaskBounds.height}</div> : null}
                  </div>
                  <div className="propSection">
                    <div className="propSectionTitle">Actions</div>
                    <div className="propBtnGrid cols2">
                      <button className="btn" disabled={!!busy || !selectionMaskDataUrl} onClick={() => void applySelectionAction('eraseSelection')}>{ui.selectionActionErase}</button>
                      <button className="btn" disabled={!!busy || !selectionMaskDataUrl} onClick={() => void applySelectionAction('transparentBackground')}>{ui.selectionActionTransparentBg}</button>
                    </div>
                    <div className="propRow" style={{ marginTop: 4 }}>
                      <span className="propLabel">Fill</span>
                      <div className="propValue">
                        <label className="quickColor" title={ui.selectionFillColor} aria-label={ui.selectionFillColor}>
                          <input type="color" value={selectionFillColor} onChange={(e) => setSelectionFillColor(e.target.value)} />
                        </label>
                        <button className="btn" disabled={!!busy || !selectionMaskDataUrl} onClick={() => void applySelectionAction('fillBackground')}>{ui.selectionActionFillBg}</button>
                      </div>
                    </div>
                    <input
                      ref={selectionBackgroundInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => void onSelectionBackgroundImageChange(e.target.files)}
                    />
                    <div className="propBtnGrid cols2" style={{ marginTop: 4 }}>
                      <button className="btn" onClick={() => selectionBackgroundInputRef.current?.click()}>{ui.selectionPickBackgroundImage}</button>
                      <button className="btn" disabled={!!busy || !selectionMaskDataUrl || !selectionBackgroundImageUrl} onClick={() => void applySelectionAction('replaceBackground')}>{ui.selectionActionReplaceBg}</button>
                    </div>
                    {selectionBackgroundImageUrl ? <div className="hint">{ui.selectionBackgroundImageReady}</div> : null}
                    <div className="propBtnGrid cols2" style={{ marginTop: 4 }}>
                      <button className="btn primary" disabled={!!busy || !selectionMaskDataUrl} onClick={() => void applySelectionAction('restoreSelection')}>{ui.selectionActionRestore}</button>
                      <button className="btn" disabled={!selectionMaskDataUrl} onClick={() => { setSelectionMaskDataUrl(null); setSelectionMaskBounds(null); setSelectionBackgroundImageUrl(null); setAntsDashOffset(0); }}>{ui.selectionActionClear}</button>
                    </div>
                  </div>
                  <div className="propSection">
                    <div className="propSectionTitle">{ui.selectionModify}</div>
                    <div className="propBtnGrid cols2">
                      <button className="btn" disabled={!selectionMaskDataUrl} onClick={() => void invertSelection()}>{ui.selectionInvert}</button>
                    </div>
                    <div className="propRow" style={{ marginTop: 4 }}>
                      <span className="propLabel">Radius</span>
                      <div className="propValue">
                        <input className="input" type="number" min={1} max={50} value={expandContractRadius} onChange={(e) => setExpandContractRadius(Number(e.target.value))} style={{ width: 48 }} />
                        <button className="btn" disabled={!selectionMaskDataUrl} onClick={() => void morphSelection(expandContractRadius, 'expand')}>{ui.selectionExpand}</button>
                        <button className="btn" disabled={!selectionMaskDataUrl} onClick={() => void morphSelection(expandContractRadius, 'contract')}>{ui.selectionContract}</button>
                      </div>
                    </div>
                    <div className="propRow">
                      <span className="propLabel">Feather</span>
                      <div className="propValue">
                        <input className="input" type="number" min={1} max={50} value={featherRadius} onChange={(e) => setFeatherRadius(Number(e.target.value))} style={{ width: 48 }} />
                        <button className="btn" disabled={!selectionMaskDataUrl} onClick={() => void featherSelection(featherRadius)}>{ui.selectionFeather}</button>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}

              {(tool === 'restore' || tool === 'eraser') && pendingMaskAction && pendingMaskAction.assetId === active?.id && pendingMaskAction.tool === tool ? (
                <div className="propSection" style={{ borderColor: 'rgba(108,140,255,0.25)', background: 'rgba(108,140,255,0.04)' }}>
                  <div className="propSectionTitle">{ui.aiPreviewTitle}</div>
                  <div className="hint">{ui.aiPreviewConfirm}</div>
                  <div className="propRow">
                    <span className="propLabel">Scope</span>
                    <div className="propValue">
                      <select className="select" value={maskApplyScope} onChange={(e) => setMaskApplyScope(e.target.value as MaskApplyScope)}>
                        <option value="full">{ui.aiPreviewScopeFull}</option>
                        <option value="crop">{ui.aiPreviewScopeCrop}</option>
                      </select>
                    </div>
                  </div>
                  {maskApplyScope === 'crop' && !activeCropRect ? <div className="hint">{ui.aiPreviewNoCrop}</div> : null}
                  <div className="propRow">
                    <span className="propLabel">Opacity</span>
                    <div className="propValue">
                      <input
                        className="input smoothRange"
                        type="range"
                        min={10}
                        max={100}
                        step={1}
                        value={Math.round(maskPreviewOpacity * 100)}
                        onChange={(e) => setMaskPreviewOpacity(clamp(Number(e.target.value) / 100, 0.1, 1))}
                      />
                    </div>
                  </div>
                  {pendingMaskBounds ? <div className="hint">{ui.aiPreviewArea}: {pendingMaskBounds.width} x {pendingMaskBounds.height}</div> : null}
                  <div className="propBtnGrid cols2">
                    <button className="btn primary" disabled={!!busy || !pendingMaskBounds} onClick={() => void applyPendingMaskAction()}>{ui.aiPreviewApply}</button>
                    <button className="btn" disabled={!!busy} onClick={cancelPendingMaskAction}>{ui.aiPreviewCancel}</button>
                  </div>
                </div>
              ) : null}

              {tool === 'crop' ? (
                <div className="propSection">
                  <div className="propSectionTitle">{ui.cropSelection}</div>
                  <div className="cropGrid">
                    <div>
                      <div className="label">{ui.cropX}</div>
                      <input className="input" type="number" min={0} max={Math.max(0, (active?.width ?? 1) - 1)} value={activeCropRect?.x ?? ''} onChange={(e) => updateCropField('x', Number(e.target.value))} />
                    </div>
                    <div>
                      <div className="label">{ui.cropY}</div>
                      <input className="input" type="number" min={0} max={Math.max(0, (active?.height ?? 1) - 1)} value={activeCropRect?.y ?? ''} onChange={(e) => updateCropField('y', Number(e.target.value))} />
                    </div>
                    <div>
                      <div className="label">{ui.cropWidth}</div>
                      <input className="input" type="number" min={1} max={Math.max(1, active?.width ?? 1)} value={activeCropRect?.width ?? ''} onChange={(e) => updateCropField('width', Number(e.target.value))} />
                    </div>
                    <div>
                      <div className="label">{ui.cropHeight}</div>
                      <input className="input" type="number" min={1} max={Math.max(1, active?.height ?? 1)} value={activeCropRect?.height ?? ''} onChange={(e) => updateCropField('height', Number(e.target.value))} />
                    </div>
                  </div>
                  <div className="label">{ui.cropPreset}</div>
                  <div className="cropPresetRow">
                    <button className={`btn ghost ${cropPreset === 'full' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('full')}>{ui.cropPresetFull}</button>
                    <button className={`btn ghost ${cropPreset === 'free' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('free')}>{ui.cropPresetFree}</button>
                    <button className={`btn ghost ${cropPreset === '1:1' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('1:1')}>{ui.cropPresetSquare}</button>
                    <button className={`btn ghost ${cropPreset === '4:3' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('4:3')}>{ui.cropPresetFourThree}</button>
                    <button className={`btn ghost ${cropPreset === '16:9' ? 'selected' : ''}`} disabled={!active} onClick={() => applyCropPreset('16:9')}>{ui.cropPresetSixteenNine}</button>
                  </div>
                  <div className="cropNudgePanel">
                    <div>
                      <div className="label">{ui.cropNudgeMove}</div>
                      <div className="cropNudgeRow">
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropPosition(-1, 0)} aria-label={ui.cropMoveLeft} title={ui.cropMoveLeft}>←</button>
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropPosition(1, 0)} aria-label={ui.cropMoveRight} title={ui.cropMoveRight}>→</button>
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropPosition(0, -1)} aria-label={ui.cropMoveUp} title={ui.cropMoveUp}>↑</button>
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropPosition(0, 1)} aria-label={ui.cropMoveDown} title={ui.cropMoveDown}>↓</button>
                      </div>
                    </div>
                    <div>
                      <div className="label">{ui.cropNudgeResize}</div>
                      <div className="cropNudgeRow">
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropSize(-1, 0)} aria-label={ui.cropShrinkWidth} title={ui.cropShrinkWidth}>W-</button>
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropSize(1, 0)} aria-label={ui.cropGrowWidth} title={ui.cropGrowWidth}>W+</button>
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropSize(0, -1)} aria-label={ui.cropShrinkHeight} title={ui.cropShrinkHeight}>H-</button>
                        <button className="btn ghost" disabled={!activeCropRect} onClick={() => nudgeCropSize(0, 1)} aria-label={ui.cropGrowHeight} title={ui.cropGrowHeight}>H+</button>
                      </div>
                    </div>
                  </div>
                  <div className="buttonRow">
                    <button className="btn primary" disabled={!active || !activeCropRect || !!busy} onClick={() => void applyCrop()}>{ui.applyCrop}</button>
                    <button className="btn" disabled={!active || !activeCropRect || !!busy} onClick={() => void previewCrop()}>{ui.previewCrop}</button>
                    <button className="btn" disabled={!activeCropRect} onClick={() => clearCropSelection(ui.cancelCrop)}>{ui.cancelCrop}</button>
                  </div>
                  <div className="hint">{ui.cropHint}</div>
                  {cropPreviewDataUrl && active ? (
                    <div className="cropPreviewCard">
                      <div className="label">{ui.cropPreviewTitle}</div>
                      <div
                        ref={cropCompareFrameRef}
                        className={`cropCompareFrame ${cropCompareDragging ? 'dragging' : ''}`}
                        aria-label={ui.cropPreviewTitle}
                        role="slider"
                        tabIndex={0}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={cropPreviewCompare}
                        onPointerDown={onCropComparePointerDown}
                        onDoubleClick={onCropCompareDoubleClick}
                        onWheel={onCropCompareWheel}
                        onKeyDown={onCropCompareKeyDown}
                      >
                        <img className="cropPreviewImage" src={active?.baseDataUrl} alt={ui.cropCompareBefore} loading="lazy" decoding="async" />
                        <div className="cropCompareOverlay" style={{ width: `${cropPreviewCompare}%` }}>
                          <img className="cropPreviewImage" src={cropPreviewDataUrl} alt={ui.cropCompareAfter} loading="lazy" decoding="async" />
                        </div>
                        <div className="cropCompareDivider" style={{ left: `${cropPreviewCompare}%` }}>
                          <span className="cropCompareBubble">{cropPreviewCompare}%</span>
                          <span className="cropCompareThumb" />
                        </div>
                      </div>
                      <div className="cropCompareLabels">
                        <span>{ui.cropCompareBefore}</span>
                        <span>{ui.cropCompareAfter}</span>
                      </div>
                      {activeCropRect && cropAreaPercent !== null ? (
                        <div className="cropPreviewMetaRow">
                          <span className="cropMetaChip">{ui.cropPreviewSize}: {activeCropRect.width} x {activeCropRect.height}</span>
                          <span className="cropMetaChip">{ui.cropPreviewArea}: {cropAreaPercent.toFixed(1)}%</span>
                        </div>
                      ) : null}
                      <div className="cropCompareQuickRow">
                        <button className="btn ghost" onClick={() => setCropPreviewCompare(0)}>{ui.cropCompareBefore}</button>
                        <button className="btn ghost" onClick={() => setCropPreviewCompare(25)}>{ui.cropCompareFocusLeft}</button>
                        <button className="btn ghost" onClick={() => setCropPreviewCompare(50)}>{ui.cropCompareFocusCenter}</button>
                        <button className="btn ghost" onClick={() => setCropPreviewCompare(75)}>{ui.cropCompareFocusRight}</button>
                        <button className="btn ghost" onClick={() => setCropPreviewCompare(100)}>{ui.cropCompareAfter}</button>
                        <button className="btn ghost" onClick={() => setCropPreviewCompare(55)}>{ui.cropCompareReset}</button>
                        <input
                          className="input cropCompareInput"
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={cropPreviewCompare}
                          onChange={(e) => setCropPreviewCompare(clamp(Math.round(Number(e.target.value) || 0), 0, 100))}
                          aria-label={ui.cropComparePercent}
                        />
                        <span className="cropCompareValue">{cropPreviewCompare}%</span>
                      </div>
                      <input
                        className="cropCompareSlider"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={cropPreviewCompare}
                        onChange={(e) => setCropPreviewCompare(Number(e.target.value))}
                        aria-label={ui.cropPreviewTitle}
                      />
                      <div className="hint">{ui.cropPreviewHint}</div>
                      <div className="hint">{ui.cropCompareControlHint} · {ui.cropCompareDoubleClickHint}</div>
                    </div>
                  ) : null}
                </div>
              ) : null}

            </>
            ) : null}

            {tool !== 'eraser' && tool !== 'restore' && tool !== 'select' ? (
            <div className="row layerRow">
              <div className="label">{ui.textLayers}</div>
              {selectedText ? (
                <div className="textOptionGroup textToolRow">
                  <div className="textOptionTitle label">{ui.selectedText}</div>
                  <label className="srOnly" htmlFor="text-font-search-panel">{ui.fontSearchPlaceholder}</label>
                  <input
                    id="text-font-search-panel"
                    className="input quickFontSearch"
                    type="search"
                    value={fontSearchQuery}
                    onChange={(e) => setFontSearchQuery(e.target.value)}
                    placeholder={ui.fontSearchPlaceholder}
                    aria-label={ui.fontSearchPlaceholder}
                  />
                  <label className="srOnly" htmlFor="text-font-preset-panel">{ui.fontPresetLabel}</label>
                  <select
                    id="text-font-preset-panel"
                    className="select quickFontPreset"
                    title={ui.fontPresetLabel}
                    aria-label={ui.fontPresetLabel}
                    disabled={selectedText.locked}
                    value={resolveTextFontPreset(selectedText)}
                    onChange={(e) => {
                      const preset = TEXT_FONT_PRESETS.find((item) => item.id === e.target.value)
                      if (!preset) return
                      ensureGoogleWebFontLoaded(preset.family)
                      updateSelectedText({ fontFamily: preset.family, fontWeight: preset.weight })
                    }}
                  >
                    {groupedTextFontPresets.map((group) => (
                      <optgroup key={group.category} label={group.label}>
                        {group.presets.map((preset) => (
                          <option
                            key={preset.id}
                            value={preset.id}
                            style={{ fontFamily: `"${preset.family}", "Pretendard", "Noto Sans KR", sans-serif` }}
                          >
                            {preset.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <div className="alignToggleRow">
                    <button className={`btn ${selectedText.align === 'left' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ align: 'left' })} aria-label={ui.alignLeft}>{ui.alignLeft}</button>
                    <button className={`btn ${selectedText.align === 'center' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ align: 'center' })} aria-label={ui.alignCenter}>{ui.alignCenter}</button>
                    <button className={`btn ${selectedText.align === 'right' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ align: 'right' })} aria-label={ui.alignRight}>{ui.alignRight}</button>
                  </div>
                  <div className="weightPresetRow">
                    <button className="btn" disabled={selectedText.locked} onClick={() => updateSelectedText({ fontWeight: 400 })} aria-label={ui.fontWeightRegular}>{ui.fontWeightRegular}</button>
                    <button className="btn" disabled={selectedText.locked} onClick={() => updateSelectedText({ fontWeight: 700 })} aria-label={ui.fontWeightBold}>{ui.fontWeightBold}</button>
                  </div>
                  <button className={`btn textItalicBtn ${selectedText.fontStyle === 'italic' ? 'selected' : ''}`} disabled={selectedText.locked} onClick={() => updateSelectedText({ fontStyle: selectedText.fontStyle === 'italic' ? 'normal' : 'italic' })} aria-label={ui.italicLabel}>{ui.italicLabel}</button>
                  <div className="swatchRow">
                    <label className="quickColor" title={ui.textColor} aria-label={ui.textColor}>
                      <input type="color" value={selectedText.fill} disabled={selectedText.locked} onChange={(e) => updateSelectedText({ fill: e.target.value })} />
                    </label>
                    <label className="quickColor" title={ui.textBorderColor} aria-label={ui.textBorderColor}>
                      <input type="color" value={resolveTextOutlineColor(selectedText)} disabled={selectedText.locked} onChange={(e) => updateSelectedText({ outlineColor: e.target.value })} />
                    </label>
                    <label className="quickColor" title={ui.textBackgroundColor} aria-label={ui.textBackgroundColor}>
                      <input type="color" value={resolveTextBackgroundColor(selectedText)} disabled={selectedText.locked} onChange={(e) => updateSelectedText({ backgroundColor: e.target.value })} />
                    </label>
                  </div>
                  <label className="quickOpacity" title={ui.textBackgroundOpacity} aria-label={ui.textBackgroundOpacity}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(resolveTextBackgroundOpacity(selectedText) * 100)}
                      disabled={selectedText.locked}
                      onChange={(e) => updateSelectedText({ backgroundOpacity: clamp(Number(e.target.value) / 100, 0, 1) })}
                    />
                    <span>{Math.round(resolveTextBackgroundOpacity(selectedText) * 100)}%</span>
                  </label>
                </div>
              ) : null}
              {selectedTextIds.length > 0 ? (
                <div className="label">{ui.layerBulkActions}</div>
              ) : null}
              {selectedTextIds.length > 0 ? (
                <div className="buttonRow layerBulkRow">
                  <button className="btn ghost" onClick={() => alignSelectedTextLayers('left')}>{ui.layerAlignLeft}</button>
                  <button className="btn ghost" onClick={() => alignSelectedTextLayers('center')}>{ui.layerAlignCenter}</button>
                  <button className="btn ghost" onClick={() => alignSelectedTextLayers('right')}>{ui.layerAlignRight}</button>
                  <button className="btn ghost" onClick={() => alignSelectedTextLayers('top')}>{ui.layerAlignTop}</button>
                  <button className="btn ghost" onClick={() => alignSelectedTextLayers('middle')}>{ui.layerAlignMiddle}</button>
                  <button className="btn ghost" onClick={() => alignSelectedTextLayers('bottom')}>{ui.layerAlignBottom}</button>
                  <button className="btn ghost" onClick={duplicateSelectedTextLayers}>{ui.layerDuplicateSelected}</button>
                </div>
              ) : null}
              <div className="layerList layerListCompact">
                {active && active.texts.length > 0 ? (
                  active.texts.map((t, idx) => (
                    <div key={t.id} className={`layerItem ${selectedTextIds.includes(t.id) ? 'active' : ''}`}>
                      <button className="layerMain" onClick={(e) => { setTool('text'); selectTextLayer(t.id, e.shiftKey) }} title={t.text}>
                        <span className="layerIndex">T{idx + 1}</span>
                        <span className="layerName">{t.text || 'Text'}</span>
                        {!t.visible ? <span className="layerTag">{ui.layerHidden}</span> : null}
                        {t.locked ? <span className="layerTag">{ui.layerLocked}</span> : null}
                      </button>
                      <div className="layerActions">
                        <button className="iconMini" onClick={() => toggleLayerVisible(t.id)} title={ui.showLayer} aria-label={ui.showLayer}>{t.visible ? '👁' : '🚫'}</button>
                        <button className="iconMini" onClick={() => toggleLayerLocked(t.id)} title={ui.lockLayer} aria-label={ui.lockLayer}>{t.locked ? '🔒' : '🔓'}</button>
                        <button className="iconMini" onClick={() => moveLayer(t.id, 'up')} title={ui.moveLayerUp} aria-label={ui.moveLayerUp}>↑</button>
                        <button className="iconMini" onClick={() => moveLayer(t.id, 'down')} title={ui.moveLayerDown} aria-label={ui.moveLayerDown}>↓</button>
                        <button
                          className="iconMini dangerMini"
                          onClick={() => {
                            updateActiveWithHistory('Delete text layer', (a) => ({ ...a, texts: a.texts.filter((tt) => tt.id !== t.id) }))
                            setSelectedTextIds((prev) => {
                              const next = prev.filter((id) => id !== t.id)
                              if (selectedTextId === t.id) setSelectedTextId(next[0] ?? null)
                              return next
                            })
                          }}
                          title={ui.deleteText}
                          aria-label={ui.deleteText}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="hint">{ui.noTextLayers}</div>
                )}
              </div>
            </div>
            ) : null}

          </div>
          ) : null}
        </div>

        {/* ── History accordion ── */}
        <div className={`accordionSection ${accordionState.history ? 'expanded' : ''}`}>
          <button className="accordionHeader" onClick={() => toggleAccordion('history')}>
            {ui.historyPanel}
            <span className="accordionChevron">{accordionState.history ? '▾' : '▸'}</span>
          </button>
          {accordionState.history ? (
            <div className="accordionBody">
              <div className="historyHeaderActions">
                <input
                  className="input historySearchInput"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder={ui.historySearchPlaceholder}
                />
                <button className="btn" onClick={addHistoryCheckpoint}>{ui.historyAddCheckpoint}</button>
              </div>
              <div className="historyList historyListTall">
                {filteredHistoryTimeline.length > 0 ? (
                  filteredHistoryTimeline.map(({ item: h, index: originalIndex }, idx) => (
                    <div key={h.key} className={`historyRow ${h.active ? 'active' : ''}`}>
                      <button className="historyItem" onClick={() => jumpToHistory(originalIndex)}>
                        <span className="historyIndex">#{idx + 1}</span>
                        <span className="historyLabel">{localizeHistoryLabel(h.label)}</span>
                      </button>
                      {!h.active ? (
                        <button className="iconMini dangerMini" onClick={() => deleteHistoryEntry(originalIndex)} aria-label={ui.deleteHistory} title={ui.deleteHistory}>
                          🗑
                        </button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="hint">{ui.noHistory}</div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        </div>
        ) : null}

      {/* ═══ Status Bar ═══ */}
      <div className="statusBar">
        <span className="statusLeft">
          {active ? `${active.width} × ${active.height}` : '—'}
          {active ? ` · ${active.name}` : ''}
        </span>
        <span className="statusCenter">
          {busy || ''}
        </span>
        <span className="statusRight">
          <button className="statusBtn" onClick={() => setZoom(Math.max(0.1, canvasZoom - 0.25))} title="Zoom Out">−</button>
          <span className="statusZoomPct">{Math.round(canvasZoom * 100)}%</span>
          <button className="statusBtn" onClick={() => setZoom(Math.min(10, canvasZoom + 0.25))} title="Zoom In">+</button>
          <button className="statusBtn" onClick={() => { setZoom(1); setCanvasOffset({ x: 0, y: 0 }) }} title="Reset Zoom">1:1</button>
        </span>
      </div>
      {showActivityLog ? (
        <div className="activityPanel">
          <div className="activityPanelTitleRow">
            <div className="activityPanelTitle">{ui.activityLog}</div>
            <div className="activityPanelActions">
              <select className="select activitySaveScope" value={activityDownloadMode} onChange={(e) => setActivityDownloadMode(e.target.value as 'filtered' | 'all')}>
                <option value="filtered">{ui.activityDownloadFiltered}</option>
                <option value="all">{ui.activityDownloadAll}</option>
              </select>
              <button className="btn" onClick={() => void copyActivityLog()} disabled={filteredToastLog.length === 0}>{ui.activityCopy}</button>
              <button className="btn" onClick={downloadActivityLog} disabled={activityDownloadMode === 'all' ? toastLog.length === 0 : filteredToastLog.length === 0}>{ui.activityDownload}</button>
              <button className="btn" onClick={clearActivityLog} disabled={toastLog.length === 0}>{ui.activityClear}</button>
            </div>
          </div>
          <div className="activityFilterRow">
            <button className={`tabBtn ${activityFilter === 'all' ? 'active' : ''}`} onClick={() => setActivityFilter('all')}>{ui.activityFilterAll}</button>
            <button className={`tabBtn ${activityFilter === 'error' ? 'active' : ''}`} onClick={() => setActivityFilter('error')}>{ui.activityFilterError}</button>
            <button className={`tabBtn ${activityFilter === 'success' ? 'active' : ''}`} onClick={() => setActivityFilter('success')}>{ui.activityFilterSuccess}</button>
            <button className={`tabBtn ${activityFilter === 'working' ? 'active' : ''}`} onClick={() => setActivityFilter('working')}>{ui.activityFilterWorking}</button>
          </div>
          <div className="activitySortRow">
            <button className={`tabBtn ${activitySort === 'latest' ? 'active' : ''}`} onClick={() => setActivitySort('latest')}>{ui.activitySortLatest}</button>
            <button className={`tabBtn ${activitySort === 'oldest' ? 'active' : ''}`} onClick={() => setActivitySort('oldest')}>{ui.activitySortOldest}</button>
          </div>
          <div className="activityLegend" aria-hidden="true">
            <span className="legendItem tone-error"><span className="dot" />{ui.activityLegendError}</span>
            <span className="legendItem tone-success"><span className="dot" />{ui.activityLegendSuccess}</span>
            <span className="legendItem tone-working"><span className="dot" />{ui.activityLegendWorking}</span>
          </div>
          <div className="activityPanelBody">
            {orderedToastLog.length > 0 ? orderedToastLog.map((item) => {
              const recent = activityNow - item.at <= 30_000
              return (
                <button
                  key={item.id}
                  className={`activityItem tone-${item.tone} ${recent ? 'recent' : ''} ${item.assetId ? 'jumpable' : ''}`}
                  type="button"
                  onClick={() => jumpToActivity(item)}
                  onContextMenu={(e) => openActivityMenu(e, item)}
                >
                  <span className="activityDot" />
                  <span className="activityText"><span className="activityKind">{activityKindLabel(item)}</span>{item.text}</span>
                  <span
                    className="activityCopyItemBtn"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      void copyActivityItem(item)
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      e.stopPropagation()
                      void copyActivityItem(item)
                    }}
                    title={ui.activityCopyItem}
                    aria-label={ui.activityCopyItem}
                  >
                    ⧉
                  </span>
                  <span className="activityTime">{formatLogTimestamp(item.at)}</span>
                </button>
              )
            }) : (
              <div className="hint">{ui.activityEmpty}</div>
            )}
          </div>
        </div>
      ) : null}
      {activityMenu ? (
        <div className="activityContextMenu" style={{ left: activityMenu.x, top: activityMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="menuItem" onClick={() => { void copyActivityItem(activityMenu.item); setActivityMenu(null) }}>{ui.activityCopyItem}</button>
          <button className="menuItem" disabled={!activityMenu.item.assetId} onClick={() => { jumpToActivity(activityMenu.item); setActivityMenu(null) }}>{ui.activityJumpItem}</button>
          <button className="menuItem" disabled={!activityMenu.item.snapshot} onClick={() => { openActivityPreview(activityMenu.item); setActivityMenu(null) }}>{ui.activityPreviewOpen}</button>
        </div>
      ) : null}
      {canvasMenu ? (
        <div className="activityContextMenu" style={{ left: canvasMenu.x, top: canvasMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="menuItem"
            onClick={() => {
              const created = addTextAt(canvasMenu.imageX, canvasMenu.imageY)
              if (created && !created.locked) beginInlineEdit(created)
              setTool('text')
              setCanvasMenu(null)
            }}
          >
            {ui.textAddAtCursor}
          </button>
              <button className="menuItem" onClick={() => { setTool('restore'); setCanvasMenu(null) }}>{ui.canvasMenuToolRestore}</button>
              <button className="menuItem" onClick={() => { setTool('eraser'); setCanvasMenu(null) }}>{ui.canvasMenuToolEraser}</button>
              <button className="menuItem" onClick={() => { setTool('select'); setCanvasMenu(null) }}>{ui.canvasMenuToolSelect}</button>
              <button className="menuItem" onClick={() => { setTool('text'); setCanvasMenu(null) }}>{ui.canvasMenuToolText}</button>
          <button className="menuItem" onClick={() => { setTool('move'); setCanvasMenu(null) }}>{ui.canvasMenuToolMove}</button>
          <button className="menuItem" onClick={() => { setZoom(1); setCanvasOffset({ x: 0, y: 0 }); setCanvasMenu(null) }}>{ui.canvasMenuZoomReset}</button>
        </div>
      ) : null}
      {activityPreview ? (
        <div className="dialogBackdrop" onClick={() => setActivityPreview(null)}>
          <div className="dialog activityPreviewDialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialogTitle">{ui.activityPreviewTitle}</div>
            {activityPreview.snapshot && activityPreviewCurrentBase ? (
              <div className="activityPreviewCompareWrap">
                <img className="activityPreviewImage" src={activityPreview.snapshot.baseDataUrl} alt={ui.activityPreviewTitle} />
                <img className="activityPreviewImage compareLayer" src={activityPreviewCurrentBase} alt={ui.activityPreviewTitle} style={{ clipPath: `inset(0 ${100 - activityPreviewCompare}% 0 0)` }} />
                <div className="activityCompareLabels">
                  <span>{ui.activityPreviewBefore}</span>
                  <span>{ui.activityPreviewAfter}</span>
                </div>
                <div className="activityCompareHandle" style={{ left: `${activityPreviewCompare}%` }} />
              </div>
            ) : activityPreview.snapshot ? (
              <img className="activityPreviewImage" src={activityPreview.snapshot.baseDataUrl} alt={ui.activityPreviewTitle} />
            ) : (
              <div className="hint">{ui.activityPreviewUnavailable}</div>
            )}
            {activityPreview.snapshot && activityPreviewCurrentBase ? (
              <div>
                <div className="label">{ui.activityPreviewCompare}</div>
                <input className="input smoothRange" type="range" min={0} max={100} step={1} value={activityPreviewCompare} onChange={(e) => setActivityPreviewCompare(clamp(Number(e.target.value), 0, 100))} />
              </div>
            ) : null}
            <div className="hint">[{formatLogTimestamp(activityPreview.item.at)}] {activityKindLabel(activityPreview.item)}: {activityPreview.item.text}</div>
            <div className="dialogActions">
              <button className="btn" disabled={!activityPreview.snapshot || !activityPreview.item.assetId} onClick={() => applyActivityPreviewSnapshot('snapshot')}>{ui.activityApplySnapshot}</button>
              <button className="btn" disabled={!activityPreview.current || !activityPreview.item.assetId} onClick={() => applyActivityPreviewSnapshot('current')}>{ui.activityApplyCurrent}</button>
              <button className="btn" onClick={() => setActivityPreview(null)}>{ui.activityPreviewClose}</button>
            </div>
          </div>
        </div>
      ) : null}
      {isFileDragOver ? (
        <div className="dropOverlay">
          <div className="dropCard">{ui.dropHint}</div>
        </div>
      ) : null}
      {showShortcutsHelp ? (
        <div className="dialogBackdrop" onClick={() => setShowShortcutsHelp(false)}>
          <div className="dialog shortcutsDialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialogTitle">{ui.shortcutsHelp}</div>
            <div className="dialogHint">{ui.shortcutsToggleHint}</div>
            <input
              className="input shortcutsSearchInput"
              value={shortcutsQuery}
              onChange={(e) => setShortcutsQuery(e.target.value)}
              placeholder={ui.shortcutsSearchPlaceholder}
              aria-label={ui.shortcutsSearchPlaceholder}
            />
            <div className="shortcutsCategoryRow">
              <button className={`tabBtn ${shortcutsCategory === 'all' ? 'active' : ''}`} onClick={() => setShortcutsCategory('all')}>{ui.shortcutsCategoryAll}</button>
              <button className={`tabBtn ${shortcutsCategory === 'tools' ? 'active' : ''}`} onClick={() => setShortcutsCategory('tools')}>{ui.shortcutsCategoryTools}</button>
              <button className={`tabBtn ${shortcutsCategory === 'selection' ? 'active' : ''}`} onClick={() => setShortcutsCategory('selection')}>{ui.shortcutsCategorySelection}</button>
              <button className={`tabBtn ${shortcutsCategory === 'history' ? 'active' : ''}`} onClick={() => setShortcutsCategory('history')}>{ui.shortcutsCategoryHistory}</button>
            </div>
            <div className="shortcutsTable" role="table" aria-label={ui.shortcutsHelp}>
              {filteredShortcutRows.map((row) => (
                <div className="shortcutsRow" role="row" key={`${row.category}-${row.keyLabel}`}>
                  <button className="shortcutsKey shortcutsKeyBtn" role="cell" onClick={() => void copyShortcutKey(row.keyLabel)} title={row.keyLabel}>{row.keyLabel}</button>
                  <div className="shortcutsDesc" role="cell">{row.desc}</div>
                </div>
              ))}
              {filteredShortcutRows.length === 0 ? <div className="hint">{ui.shortcutsNoMatch}</div> : null}
            </div>
            <div className="dialogActions">
              <button className="btn" onClick={() => setShowShortcutsHelp(false)}>{ui.shortcutsClose}</button>
            </div>
          </div>
        </div>
      ) : null}
      {exportDialogOpen ? (
        <div className="dialogBackdrop" onClick={() => setExportDialogOpen(false)}>
          <div className="dialog exportDialog" ref={exportDialogRef} onClick={(e) => e.stopPropagation()}>
            <div className="dialogTitle">{ui.exportDialogTitle}</div>
            <div className="dialogHint">{ui.exportDialogDesc}</div>
            <div>
              <div className="label">{ui.exportFormat}</div>
              <select className={`select ${highlightExportFormat ? 'formatPulse' : ''}`} value={pendingExportFormat} onChange={(e) => setPendingExportFormat(e.target.value as ExportKind)}>
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
                <option value="webp">WEBP</option>
                <option value="pdf">PDF</option>
                <option value="pptx">PPTX</option>
              </select>
              <div className="formatHintBadge">{selectedExportFormatHint}</div>
              <div className="exportPresetRow">
                <button className="btn ghost presetBtn" onClick={() => { setPendingExportFormat('jpg'); setPendingExportRatio(2); setPendingExportQuality(84) }}>
                  <span>{ui.exportPresetWeb}</span>
                  <span className="presetHint">{ui.exportPresetWebHint}</span>
                  <span className="presetHint">{ui.exportPresetSpeedFast}</span>
                </button>
                <button className="btn ghost presetBtn" onClick={() => { setPendingExportFormat('png'); setPendingExportRatio(4) }}>
                  <span>{ui.exportPresetPrint}</span>
                  <span className="presetHint">{ui.exportPresetPrintHint}</span>
                  <span className="presetHint">{ui.exportPresetSpeedSlow}</span>
                </button>
                <button className="btn ghost presetBtn" onClick={() => { setPendingExportFormat('pptx'); setPendingExportRatio(2) }}>
                  <span>{ui.exportPresetSlides}</span>
                  <span className="presetHint">{ui.exportPresetSlidesHint}</span>
                  <span className="presetHint">{ui.exportPresetSpeedBalanced}</span>
                </button>
              </div>
              <div className="exportSummaryCard">{exportSummaryText}</div>
            </div>
            <div>
              <div className="label">{ui.exportScope}</div>
              <select className="select" value={pendingExportScope} onChange={(e) => setPendingExportScope(e.target.value as ExportScope)}>
                <option value="current">{ui.exportScopeCurrent}</option>
                <option value="selected" disabled={!hasSelectedAssets}>{ui.exportScopeSelected}</option>
                <option value="all">{ui.exportScopeAll}</option>
              </select>
            </div>
            <select
              className="select"
              value={String(pendingExportRatio)}
              onChange={(e) => setPendingExportRatio(normalizeExportRatio(Number(e.target.value)))}
            >
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
              <option value="8">8x</option>
            </select>
            {pendingExportFormat === 'jpg' || pendingExportFormat === 'webp' ? (
              <div>
                <div className="label">{ui.exportImageQuality}</div>
                <div className="qualityRow">
                  <input
                    className="input smoothRange"
                    type="range"
                    min={50}
                    max={100}
                    step={1}
                    value={pendingExportQuality}
                    onChange={(e) => setPendingExportQuality(clamp(Number(e.target.value), 50, 100))}
                  />
                  <input
                    className="input qualityNumber"
                    type="number"
                    min={50}
                    max={100}
                    value={pendingExportQuality}
                    onChange={(e) => setPendingExportQuality(clamp(Number(e.target.value), 50, 100))}
                  />
                </div>
              </div>
            ) : null}
            <div className="dialogActions">
              <button
                className="btn"
                onClick={() => {
                  setPendingExportFormat('png')
                  setPendingExportRatio(2)
                  setPendingExportScope('current')
                  setPendingExportQuality(92)
                }}
              >
                {ui.exportResetRecent}
              </button>
              <button className="btn" onClick={() => setExportDialogOpen(false)}>
                {ui.cancel}
              </button>
              <button className="btn primary" onClick={() => void confirmExport()}>
                {ui.exportNow}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {progressState ? (
        <div className={`progressToast tone-${statusTone(progressState.label)}`}>
          <div className="progressTitle"><span className="statusIcon">{statusIcon(progressState.label)}</span>{progressState.label}</div>
          <div className="progressBarWrap">
            <div
              className={`progressBar ${progressState.indeterminate ? 'indeterminate' : ''}`}
              style={{
                width: progressState.indeterminate
                  ? '100%'
                  : `${Math.round((progressState.value / Math.max(1, progressState.total)) * 100)}%`,
              }}
            />
          </div>
          {!progressState.indeterminate ? (
            <div className="progressMeta">
              {progressState.value}/{progressState.total}
            </div>
          ) : null}
          {cancelableTask ? (
            <div className="progressActions">
              <button className="btn ghost" onClick={requestCancelTask}>{ui.cancelTask}</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {toast ? (
        <div className={`toast tone-${statusTone(toast)}`}>
          <span className="statusIcon">{statusIcon(toast)}</span>
          <span>{toast}</span>
          {toastAt ? <span className="toastTime">{formatLogTimestamp(toastAt)}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export default App
