export type AdapterHealthEntry = { name: string; enabled: boolean };

/** Adapter status from the resolver; the resolver is loaded lazily and may not exist yet. */
export async function getAdapterHealth(): Promise<AdapterHealthEntry[]> {
  try {
    // real shape of adapterHealth(): Array<{ name, configured }>
    const mod = (await import('@/lib/resolver')) as { adapterHealth?: () => unknown };
    const raw = await mod.adapterHealth?.();
    if (!Array.isArray(raw)) return [];
    return raw.map((r: Record<string, unknown>) => ({
      name: String(r.name ?? 'unknown'),
      enabled: Boolean(r.configured),
    }));
  } catch {
    return [];
  }
}
