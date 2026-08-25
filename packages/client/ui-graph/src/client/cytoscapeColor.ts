/**
 * Expand CSS shorthand hexadecimal colors into values accepted by Cytoscape.
 * @param value computed CSS color token.
 * @returns an equivalent Cytoscape color value.
 */
export function cytoscapeColor(value: string): string {
  const shorthand = /^#([\da-f])([\da-f])([\da-f])([\da-f])?$/i.exec(value)
  if (shorthand === null) return value
  const channel = (digit: string): number => Number.parseInt(`${digit}${digit}`, 16)
  const red = channel(shorthand[1] as string)
  const green = channel(shorthand[2] as string)
  const blue = channel(shorthand[3] as string)
  if (shorthand[4] === undefined) {
    return `rgb(${String(red)}, ${String(green)}, ${String(blue)})`
  }
  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(channel(shorthand[4]) / 255)})`
}
