export type Tool = 'restore' | 'eraser' | 'select' | 'text' | 'crop' | 'move' | 'pen' | 'shape' | 'blur' | 'dodge' | 'eyedropper' | 'hand' | 'adjust'

export type DrawingStroke = {
  id: string
  points: number[]
  strokeWidth: number
  color: string
  opacity: number
}

export type ShapeType = 'rect' | 'ellipse' | 'line' | 'arrow'

export type ShapeItem = {
  id: string
  type: ShapeType
  x: number
  y: number
  width: number
  height: number
  fill: string
  stroke: string
  strokeWidth: number
  opacity: number
  rotation: number
  visible: boolean
  locked: boolean
}

export type BlurMode = 'blur' | 'sharpen'
export type DodgeMode = 'dodge' | 'burn'

export type ImageLayerItem = {
  id: string
  dataUrl: string
  x: number
  y: number
  width: number
  height: number
  opacity: number
  rotation: number
  visible: boolean
  locked: boolean
}

export type ImageAdjustments = {
  brightness: number   // -100 to 100 (0 = default)
  contrast: number     // -100 to 100 (0 = default)
  saturation: number   // -100 to 100 (0 = default)
  temperature: number  // -100 to 100 (0 = default, negative = cool, positive = warm)
  exposure: number     // -100 to 100 (0 = default)
  highlights: number   // -100 to 100 (0 = default)
  shadows: number      // -100 to 100 (0 = default)
  vibrance: number     // -100 to 100 (0 = default)
}

export type MaskStroke = {
  id: string
  points: number[]
  strokeWidth: number
}

export type TextAlign = 'left' | 'center' | 'right'

export type TextItem = {
  id: string
  x: number
  y: number
  text: string
  fontFamily: string
  fontSize: number
  fill: string
  outlineColor?: string
  backgroundColor?: string
  backgroundOpacity?: number
  fontWeight: number
  fontStyle: 'normal' | 'italic'
  rotation: number
  align: TextAlign
  visible: boolean
  locked: boolean
  opacity: number
  groupId: string
}

export type LayerGroup = {
  id: string
  name: string
  collapsed: boolean
}

export type UnifiedLayerRef = {
  type: 'text' | 'image'
  id: string
}

export type HistoryEntry = {
  label: string
  snapshot: string
  timestamp: number
}

export type PageAsset = {
  id: string
  name: string
  width: number
  height: number
  baseDataUrl: string
  maskStrokes: MaskStroke[]
  groups: LayerGroup[]
  texts: TextItem[]
  drawings: DrawingStroke[]
  shapes: ShapeItem[]
  imageLayers: ImageLayerItem[]
  layerOrder: UnifiedLayerRef[]
  adjustments: ImageAdjustments
}
