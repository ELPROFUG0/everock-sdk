type Entry<T> = { owner: string; value: T; lastUsed: number };

// Reservations count immediately, including while the transport is initializing.
export class SessionPool<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(private readonly capacity: number, private readonly ownerLimit: number) {}

  reserve(id: string, owner: string, create: () => T, now: number): T | undefined {
    if (this.entries.size >= this.capacity || this.entries.has(id)) return;
    let owned = 0;
    for (const entry of this.entries.values()) if (entry.owner === owner) owned++;
    if (owned >= this.ownerLimit) return;
    const value = create();
    this.entries.set(id, { owner, value, lastUsed: now });
    return value;
  }

  get(id: string, owner: string, now: number): T | undefined {
    const entry = this.entries.get(id);
    if (entry?.owner !== owner) return;
    entry.lastUsed = now;
    return entry.value;
  }

  remove(id: string) { this.entries.delete(id); }

  expireBefore(cutoff: number): T[] {
    const expired: T[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.lastUsed > cutoff) continue;
      this.entries.delete(id);
      expired.push(entry.value);
    }
    return expired;
  }
}
