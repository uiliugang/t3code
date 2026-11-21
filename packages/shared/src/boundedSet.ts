export function boundedAdd(set: Set<string>, key: string, limit: number): void {
  set.delete(key);
  set.add(key);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}
