/** A stable selection stores IDs, joining fresh catalog objects only when rendering. */
export function selectRecommendationIds(catalogIds: readonly number[], previous: readonly number[] = [], refresh = false,
  random: () => number = Math.random): number[] {
  const available = [...new Set(catalogIds)];
  const limit = Math.min(6, available.length);
  const chosen = refresh ? [] : previous.filter((id, index) => available.includes(id) && previous.indexOf(id) === index).slice(0, limit);
  const pool = available.filter(id => !chosen.includes(id));
  while (chosen.length < limit) {
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
    const [id] = pool.splice(index, 1);
    if (id !== undefined) chosen.push(id);
  }
  if (refresh && limit > 0 && available.length > limit && chosen.every(id => previous.includes(id))) {
    const replacement = available.find(id => !previous.includes(id));
    if (replacement !== undefined) chosen[limit - 1] = replacement;
  } else if (refresh && limit > 1 && chosen.every((id, index) => id === previous[index])) {
    chosen.push(chosen.shift()!);
  }
  return chosen;
}
