export type Tool = 'restore' | 'eraser' | 'text' | 'crop' | 'move'

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
}
