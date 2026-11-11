/** Remove exactly the obsolete key field; preserve all other legacy data. */
export function stripLegacyKeys<T extends object>(configs: T[]): T[] {
  return configs.map(config => {
    const { apiKey: _key, ...rest } = config as T & { apiKey?: unknown };
    return rest as T;
  });
}
export async function removeLegacyKeys(deps: {
  blocked(): boolean; configs(): object[];
  commit(mutator: (doc: any) => { doc: any; result: number }): Promise<{ result: any }>;
  install(configs: any[]): void; log(message: string): void;
}) {
  const configs = deps.configs();
  try {
    if (deps.blocked() || !configs.some(c => Object.hasOwn(c, 'apiKey'))) return;
    const committed = await deps.commit(doc => {
      const arr = Array.isArray(doc.airtableConfigs) ? doc.airtableConfigs : [];
      const count = arr.filter((c: object) => Object.hasOwn(c, 'apiKey')).length;
      return { doc: count ? { ...doc, airtableConfigs: stripLegacyKeys(arr) } : doc, result: count };
    });
    if (committed.result) deps.log(`[sources] removed ${committed.result} legacy keys`);
  } finally {
    // Local commitState takes its snapshot from memory, so strip memory AFTER
    // committing; also strip when persistence fails or this revision cannot write.
    deps.install(stripLegacyKeys(deps.configs()));
  }
}
