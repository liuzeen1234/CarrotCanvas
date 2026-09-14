import test from 'node:test';
import assert from 'node:assert/strict';
import { findInputPosition, resolveOverlaps } from './resolveOverlaps.ts';

const node = (id, x, y, width = 300, height = 240) => ({ id, position: { x, y }, measured: { width, height } });
function verify(nodes) {
  const positions = resolveOverlaps(nodes);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = positions.get(nodes[i].id), b = positions.get(nodes[j].id);
    assert.ok(a.x + nodes[i].measured.width + 24 <= b.x || b.x + nodes[j].measured.width + 24 <= a.x || a.y + nodes[i].measured.height + 24 <= b.y || b.y + nodes[j].measured.height + 24 <= a.y, `overlap: ${i},${j}`);
  }
  const arranged = nodes.map(n => ({ ...n, position: positions.get(n.id) }));
  assert.deepEqual(resolveOverlaps(arranged), positions, 'second arrangement must be a no-op');
  return positions;
}
test('spaced cards stay in place', () => {
  const nodes = [node('a', -700, -500), node('b', 20, 30), node('c', 800, 30)];
  const result = verify(nodes);
  nodes.forEach(n => assert.deepEqual(result.get(n.id), n.position));
});
test('new inputs occupy a free column without moving existing cards, even after height grows', () => {
  const nodes = [node('a', 80, 80, 300, 2000), node('b', 500, -800, 450, 1200)];
  const before = structuredClone(nodes);
  const first = findInputPosition(nodes);
  assert.deepEqual(nodes, before);
  nodes.push(node('new', first.x, first.y, 300, 6000));
  const second = findInputPosition(nodes);
  nodes.push(node('next', second.x, second.y, 300, 6000));
  verify(nodes);
  assert.deepEqual(findInputPosition([], { x: 20, y: -50 }), { x: 20, y: -50 });
});
test('horizontal neighbors retain left/right relationship and a distant card stays fixed', () => {
  const nodes = [node('a', 0, 0), node('b', 280, 0), node('far', 2000, 2000)];
  const result = verify(nodes);
  assert.ok(result.get('a').x < result.get('b').x);
  assert.deepEqual(result.get('far'), nodes[2].position);
});
test('coincident cards and mixed tall/large cards are separated deterministically', () => {
  const nodes = Array.from({ length: 80 }, (_, i) => node(String(i), (i % 6) * 40 - 200, (i % 5) * 50 - 100, 200 + i % 4 * 90, 100 + i % 7 * 120));
  verify(nodes);
  assert.deepEqual(resolveOverlaps(nodes), resolveOverlaps([...nodes].reverse()));
});
