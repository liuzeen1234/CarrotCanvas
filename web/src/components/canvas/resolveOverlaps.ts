type LayoutNode = {
  id: string; position: { x: number; y: number };
  measured?: { width?: number; height?: number }; width?: number; height?: number;
  style?: { width?: unknown; height?: unknown }; hidden?: boolean;
};
type Rect = { id: string; x: number; y: number; width: number; height: number; originalX: number; originalY: number };
const dimension = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** Reserve a free column so a new input's eventual image/text height cannot create overlap. */
export function findInputPosition(nodes: LayoutNode[], preferred = { x: 80, y: 80 }, width = 300, gap = 24) {
  const occupied = nodes.filter(n => !n.hidden).map(n => ({ x: n.position.x, width: dimension(n.measured?.width, dimension(n.width, dimension(n.style?.width, 300))) }));
  const candidates = [preferred.x, ...occupied.flatMap(n => [n.x + n.width + gap, n.x - width - gap])];
  const free = candidates.filter(x => occupied.every(n => x >= n.x + n.width + gap || x + width + gap <= n.x));
  free.sort((a, b) => Math.abs(a - preferred.x) - Math.abs(b - preferred.x) || b - a);
  return { x: free[0], y: preferred.y };
}

/** Keep existing placements where possible; move collisions to the nearest free axis boundary. */
export function resolveOverlaps(nodes: LayoutNode[], gap = 24) {
  const rects: Rect[] = nodes.filter(n => !n.hidden).map(n => ({
    id: n.id, x: n.position.x, y: n.position.y, originalX: n.position.x, originalY: n.position.y,
    width: dimension(n.measured?.width, dimension(n.width, dimension(n.style?.width, 300))),
    height: dimension(n.measured?.height, dimension(n.height, dimension(n.style?.height, 240))),
  })).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const placed: Rect[] = [];
  const collides = (a: Rect, b: Rect) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
  for (const rect of rects) {
    if (placed.some(p => collides(rect, p))) {
      const candidates = placed.flatMap(p => [
        { ...rect, x: p.x + p.width + gap }, { ...rect, x: p.x - rect.width - gap },
        { ...rect, y: p.y + p.height + gap }, { ...rect, y: p.y - rect.height - gap },
      ]);
      const score = (candidate: Rect) => {
        let result = (candidate.x - rect.originalX) ** 2 + (candidate.y - rect.originalY) ** 2;
        // Prefer preserving original left/right and above/below relationships.
        for (const p of placed) {
          const dx = rect.originalX + rect.width / 2 - p.originalX - p.width / 2;
          const dy = rect.originalY + rect.height / 2 - p.originalY - p.height / 2;
          if (dx * (candidate.x + rect.width / 2 - p.x - p.width / 2) < 0) result += dx ** 2;
          if (dy * (candidate.y + rect.height / 2 - p.y - p.height / 2) < 0) result += dy ** 2;
        }
        return result;
      };
      const free = candidates.filter(c => !placed.some(p => collides(c, p)));
      free.sort((a, b) => score(a) - score(b) || a.y - b.y || a.x - b.x);
      rect.x = free[0].x; rect.y = free[0].y;
    }
    placed.push(rect);
  }
  return new Map(placed.map(r => [r.id, { x: r.x, y: r.y }]));
}
