// ─── branchTree ─────────────────────────────────────────────────────────────
//
// Laying the P&L out as a branching tree: the month on the left, splitting
// into categories, into sub-categories, into the lines themselves.
//
// No React and no drawing, so where every node sits and how thick every branch
// is can be checked with numbers.
//
// ── Why the branch is thick ─────────────────────────────────────────────────
//
// An ordinary tree diagram — an org chart — says only what contains what, and
// the P&L table already says that in a column of indents. What a branching
// picture can add, and a table cannot, is that the shape of the spending is
// visible along the way: a branch carrying half the month should LOOK like it
// carries half the month.
//
// So the link into a node is drawn at a thickness proportional to its amount.
// It is the same encoding a Sankey uses and it is the whole reason this is
// worth drawing rather than listing: the eye follows the thick branch without
// reading a single figure.
//
// ── Only what is open ───────────────────────────────────────────────────────
//
// Forty-odd leaves laid out at once is a wall. The layout takes the set of
// opened nodes and places only those rows, so the tree starts as eleven
// categories and grows where it is asked to. A parent sits at the MIDDLE of
// its open children, which is what makes a branch read as a branch rather than
// as a list with lines drawn on it.

export interface BranchNode {
  key: string
  label: string
  amount: number
  children?: BranchNode[]
  /** Anything the caller wants back on the placed node. */
  [extra: string]: unknown
}

export interface PlacedNode {
  key: string
  label: string
  amount: number
  /** Of the whole laid out, 0–1. */
  share: number
  depth: number
  /** Left edge of the node's own box. */
  x: number
  /** Centre of the node's row. */
  y: number
  hasChildren: boolean
  open: boolean
  node: BranchNode
}

export interface BranchLink {
  from: string
  to: string
  /** Where the branch leaves the parent and where it arrives. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Stroke width, proportional to the child's amount. */
  width: number
}

export interface BranchLayout {
  nodes: PlacedNode[]
  links: BranchLink[]
  /** How tall the drawing has to be for everything placed to fit. */
  height: number
  /** Rows that were not drawn because their parent is shut. */
  hidden: number
}

export interface BranchOptions {
  /** Vertical space per placed row. */
  rowHeight?: number
  /** Horizontal distance between one depth and the next. */
  columnWidth?: number
  /** Width of a node's own box, inside its column. */
  nodeWidth?: number
  /** The thickest a branch is ever drawn. */
  maxLinkWidth?: number
  /** The thinnest, so a small line is still a line and still hoverable. */
  minLinkWidth?: number
  top?: number
}

const amountOf = (n: BranchNode): number => Math.abs(Number(n.amount) || 0)

/**
 * Where every open node sits, and how thick the branch into it is.
 *
 * `open` is the set of keys whose children are showing. A node not in it is
 * drawn with its subtree folded away — and `hidden` counts what that cost, so
 * the caller can say it rather than leaving a reader to wonder whether eleven
 * categories is all there is.
 *
 * Thickness is scaled against the LARGEST amount at any depth, not against the
 * parent at each level. Scaling per level makes the biggest child of a tiny
 * category as thick as the biggest category in the month, which says the
 * opposite of the truth about it.
 */
export function layoutBranches(
  roots: BranchNode[], open: Set<string>, opts: BranchOptions = {},
): BranchLayout {
  const rowHeight = opts.rowHeight ?? 30
  const columnWidth = opts.columnWidth ?? 230
  const nodeWidth = opts.nodeWidth ?? 190
  const maxLink = opts.maxLinkWidth ?? 26
  const minLink = opts.minLinkWidth ?? 1.5
  const top = opts.top ?? 0

  const kept = roots.filter(r => amountOf(r) > 0)
  const total = kept.reduce((s, n) => s + amountOf(n), 0)
  if (kept.length === 0 || total <= 0) {
    return { nodes: [], links: [], height: 0, hidden: 0 }
  }

  const biggest = Math.max(...kept.map(amountOf))
  const nodes: PlacedNode[] = []
  const links: BranchLink[] = []
  let row = 0
  let hidden = 0

  const place = (node: BranchNode, depth: number, parent: PlacedNode | null): PlacedNode => {
    const children = (node.children || []).filter(c => amountOf(c) > 0)
    const isOpen = open.has(node.key) && children.length > 0

    // A leaf takes the next row. A parent takes the middle of its children's,
    // which is what makes the branch read as a branch and not as a list with
    // lines drawn on it — so the children have to be placed first.
    let y: number
    let placedChildren: PlacedNode[] = []
    if (isOpen) {
      placedChildren = children.map(c => place(c, depth + 1, null))
      y = (placedChildren[0].y + placedChildren[placedChildren.length - 1].y) / 2
    } else {
      y = top + row * rowHeight + rowHeight / 2
      row += 1
      hidden += countUnder(node)
    }

    const placed: PlacedNode = {
      key: node.key,
      label: node.label,
      amount: amountOf(node),
      share: amountOf(node) / total,
      depth,
      x: depth * columnWidth,
      y,
      hasChildren: children.length > 0,
      open: isOpen,
      node,
    }
    nodes.push(placed)

    // Written after the node so a caller reading `links` in order sees the
    // parent before what hangs off it.
    for (const child of placedChildren) {
      links.push({
        from: placed.key, to: child.key,
        x1: placed.x + nodeWidth, y1: placed.y,
        x2: child.x, y2: child.y,
        width: Math.max(minLink, (child.amount / biggest) * maxLink),
      })
    }
    void parent
    return placed
  }

  for (const r of kept) place(r, 0, null)

  return {
    nodes,
    links,
    height: top + row * rowHeight,
    hidden,
  }
}

/** How many nodes sit under this one, at any depth. */
export function countUnder(node: BranchNode): number {
  const children = (node.children || []).filter(c => amountOf(c) > 0)
  return children.reduce((s, c) => s + 1 + countUnder(c), 0)
}

/**
 * The path of curves from one point to another, as a cubic.
 *
 * A straight diagonal between two rows crosses its neighbours at an angle and
 * two of them at a shallow angle are hard to tell apart where they nearly
 * overlap. A curve that leaves horizontally and arrives horizontally is
 * separable at the ends, which is where a reader is looking.
 */
export function branchPath(l: BranchLink): string {
  const dx = Math.max(20, (l.x2 - l.x1) / 2)
  return `M ${l.x1} ${l.y1} C ${l.x1 + dx} ${l.y1}, ${l.x2 - dx} ${l.y2}, ${l.x2} ${l.y2}`
}

/** Every key from `roots` down to the given depth, for opening a level at a time. */
export function keysToDepth(roots: BranchNode[], depth: number): Set<string> {
  const out = new Set<string>()
  const walk = (nodes: BranchNode[], d: number) => {
    if (d >= depth) return
    for (const n of nodes) {
      if (amountOf(n) <= 0) continue
      if (n.children && n.children.length > 0) {
        out.add(n.key)
        walk(n.children, d + 1)
      }
    }
  }
  walk(roots, 0)
  return out
}
