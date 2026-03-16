export type Tool = 'restore' | 'eraser' | 'select' | 'text' | 'crop' | 'move' | 'pen' | 'shape' | 'blur' | 'dodge' | 'eyedropper' | 'hand' | 'adjust'

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'

export type LayerEffects = {
  dropShadow?: {
    enabled: boolean
    color: string
    blur: number
    offsetX: number
    offsetY: number
  }
  outerStroke?: {
    enabled: boolean
    color: string
    width: number
  }
  innerGlow?: {
    enabled: boolean
    color: string
    blur: number
  }
}

export type LayerFolder = {
  id: string
  name: string
  visible: boolean
  collapsed: boolean
  opacity: number
  blendMode: BlendMode
}

export type AdjustmentLayerItem = {
  id: string
  name: string
  type: 'brightness-contrast' | 'hue-saturation' | 'color-balance'
  visible: boolean
  locked: boolean
  opacity: number
  brightness?: number
  contrast?: number
  hue?: number
  saturation?: number
  lightness?: number
  redCyan?: number
  greenMagenta?: number
  blueYellow?: number
}

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
  blendMode?: BlendMode
  effects?: LayerEffects
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
  blendMode?: BlendMode
  effects?: LayerEffects
}

export type LayerGroup = {
  id: string
  name: string
  collapsed: boolean
}

export type UnifiedLayerRef = {
  type: 'text' | 'image' | 'group' | 'adjustment'
  id: string
  parentGroupId?: string
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
  layerFolders?: LayerFolder[]
  adjustmentLayers?: AdjustmentLayerItem[]
}
