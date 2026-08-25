/** Cross-platform reading font stack shared by DOM and Cytoscape Graph surfaces. */
export const graphFontFamily = 'Inter, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif'

/** Typography applied to task labels on Graph canvases. */
export const graphCanvasNodeTypography = {
  'font-family': graphFontFamily,
  'font-size': 12,
  'font-weight': 500,
} as const
