/**
 * Detect model output that has collapsed into repetition — a short unit repeated over and over, or
 * a flood of the same two or three words. Small or damaged local models do this until the context
 * window is full, which looks like an agent "writing forever". Real code and prose never match.
 */
export function isDegenerate(text: string): boolean {
  if (text.length < 600) return false;

  // 1. The tail is exactly periodic with a short period (≥ 10 repetitions).
  const tail = text.slice(-600);
  for (let period = 1; period <= 60; period++) {
    let periodic = true;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== tail[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return true;
  }

  // 2. Hardly any vocabulary: three words make up most of the last few hundred words.
  const words = text.slice(-3000).match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length >= 300) {
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    const top = [...counts.values()].sort((a, b) => b - a).slice(0, 3);
    if (top.reduce((a, b) => a + b, 0) / words.length >= 0.7) return true;
  }
  return false;
}
