/**
 * What a picture may draw of a figure: the figure when it is above zero,
 * otherwise nothing.
 *
 * A refund is an expense with a minus, so a node, month or cell can net to zero
 * or below. The table keeps it with its minus; a width, a height, the numerator
 * of a share or the maximum of a scale takes this instead. Null, undefined and
 * NaN are nothing as well.
 */
export function drawn(n: number | null | undefined): number {
  return typeof n === 'number' && n > 0 ? n : 0
}
