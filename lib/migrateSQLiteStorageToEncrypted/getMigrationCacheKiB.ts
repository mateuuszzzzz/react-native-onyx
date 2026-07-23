// A large page cache keeps the migration's working set in RAM instead of repeatedly spilling and re-encrypting pages
const MAX_CACHE_KIB = 131_072; // 128MB — sweet spot; beyond it the one-time per-page crypto dominates
const MIN_CACHE_KIB = 20_000; // used when memory unknown; keep in sync with SQLiteProvider's PRAGMA cache_size=-20000
const MEMORY_BUDGET_FRACTION = 0.5; // use at most half of available memory, leaving headroom for app + OS

// Page-cache size (KiB) for the migration connection, bounded by the source DB and available memory.
// Never below MIN_CACHE_KIB, including when available memory is unknown (<= 0).
function getMigrationCacheKiB(dbSizeBytes: number, availableMemoryBytes: number): number {
  if (availableMemoryBytes <= 0) {
    return MIN_CACHE_KIB;
  }
  const dbSizeKiB = Math.ceil(dbSizeBytes / 1024) || MAX_CACHE_KIB;
  const budgetKiB = Math.floor((availableMemoryBytes * MEMORY_BUDGET_FRACTION) / 1024);
  return Math.max(MIN_CACHE_KIB, Math.min(dbSizeKiB, MAX_CACHE_KIB, budgetKiB));
}

export default getMigrationCacheKiB;
