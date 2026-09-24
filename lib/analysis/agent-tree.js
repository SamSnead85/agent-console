/** Build an agent tree from identifiers, models, counts and timestamps. */
const validCount = (n) => Number.isSafeInteger(n) && n >= 0;
const validTime = (n) => Number.isFinite(n) && n >= 0;
const OUTCOMES = new Set(['succeeded', 'failed', 'unknown']);

export function agentTree(sessions) {
  const nodes = new Map();
  for (const session of sessions) {
    if (typeof session.sessionHash !== 'string' || !session.sessionHash || nodes.has(session.sessionHash)) continue;
    nodes.set(session.sessionHash, {
      sessionHash: session.sessionHash,
      parentSessionHash: session.parentSessionHash || null,
      model: session.model || 'unknown',
      tokens: validCount(session.tokens) ? session.tokens : null,
      durationMinutes: validTime(session.firstAt) && validTime(session.lastAt) && session.lastAt >= session.firstAt
        ? Math.round((session.lastAt - session.firstAt) / 60_000) : null,
      outcome: OUTCOMES.has(session.outcome) ? session.outcome : 'unknown',
    });
  }
  const children = new Map();
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentSessionHash && node.parentSessionHash !== node.sessionHash && nodes.has(node.parentSessionHash)) {
      if (!children.has(node.parentSessionHash)) children.set(node.parentSessionHash, []);
      children.get(node.parentSessionHash).push(node);
    } else roots.push(node);
  }
  const seen = new Set();
  const rows = [];
  function visit(node, depth, rootSessionHash) {
    if (seen.has(node.sessionHash)) return;
    seen.add(node.sessionHash);
    rows.push({ ...node, depth, rootSessionHash });
    for (const child of children.get(node.sessionHash) || []) visit(child, depth + 1, rootSessionHash);
  }
  for (const root of roots) visit(root, 0, root.sessionHash);
  // A malformed parent cycle must not hide sessions or recurse forever.
  for (const node of nodes.values()) if (!seen.has(node.sessionHash)) visit(node, 0, node.sessionHash);
  return rows;
}
