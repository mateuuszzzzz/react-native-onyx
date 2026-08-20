import type {OnyxKey} from './types';

/**
 * Declarative, Onyx-managed storage indexes accelerating `queryCollection` (lazy-Onyx POC).
 *
 * The app declares indexes in `Onyx.init({indexes: {[collectionKey]: ['field', …]}})` and calls
 * `Onyx.reconcileIndexes()` (ideally from idle, after startup). Reconciliation is a two-way diff of
 * the declaration against what actually exists in storage:
 * - declared but missing  → created;
 * - existing but NOT declared → detected and DROPPED, so removing a declaration from app code (or a
 *   renamed field) cleans the orphaned index up automatically on the next run.
 * Only indexes inside the Onyx-managed namespace (`onyx_idx_*`) are ever touched — anything else in
 * storage is invisible to reconciliation.
 *
 * Index support is provider-specific (SQLite today). On providers without it, reconciliation
 * resolves with `supported: false` and queries simply run unindexed — identical results, slower scan.
 */
import * as Logger from './Logger';
import Storage from './storage';

/**
 * Index declarations per collection. Each entry is either a single field or an ordered list of
 * fields (a composite index — equality-filter fields first, the sort field last). Direction is
 * deliberately NOT declarable: SQLite walks a B-tree both ways, so one index serves `asc` and
 * `desc` alike (mixed-direction multi-column sorts are the only case that would need it, and the
 * query API always orders every column the same way). `record_key` is appended to every index
 * automatically so the query's tie-break ordering is fully covered.
 */
type OnyxIndexDeclaration = string | string[];
type OnyxIndexesConfig = Partial<Record<OnyxKey, OnyxIndexDeclaration[]>>;

type ReconcileIndexesResult = {
    /** Whether the active storage provider supports indexes at all. */
    supported: boolean;
    created: string[];
    dropped: string[];
};

const ONYX_INDEX_PREFIX = 'onyx_idx_';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;

let indexesConfig: OnyxIndexesConfig = {};

function setIndexesConfig(config: OnyxIndexesConfig): void {
    indexesConfig = config;
}

function getIndexesConfig(): OnyxIndexesConfig {
    return indexesConfig;
}

/** Deterministic managed name for one (collection, fields) index — the identity reconciliation diffs on. */
function computeIndexName(collectionPrefix: OnyxKey, fields: string[]): string {
    const sanitizedCollection = collectionPrefix.replace(/[^A-Za-z0-9]/g, '');
    return `${ONYX_INDEX_PREFIX}${sanitizedCollection}_${fields.join('_')}`;
}

/**
 * Creates every declared-but-missing index and drops every Onyx-managed index that is no longer
 * declared. Never runs concurrently with itself in practice (call it once, from idle).
 */
function reconcileIndexes(): Promise<ReconcileIndexesResult> {
    const provider = Storage.getStorageProvider();
    if (!provider.listOnyxIndexes || !provider.createCollectionIndex || !provider.dropIndex) {
        return Promise.resolve({supported: false, created: [], dropped: []});
    }

    const desired = new Map<string, {collectionPrefix: OnyxKey; fields: string[]}>();
    for (const [collectionPrefix, declarations] of Object.entries(indexesConfig)) {
        if (!declarations) {
            continue;
        }
        for (const declaration of declarations) {
            const fields = Array.isArray(declaration) ? declaration : [declaration];
            if (fields.length === 0 || fields.some((field) => !IDENTIFIER_PATTERN.test(field))) {
                Logger.logAlert(`[OnyxIndexes] Skipping index with invalid field list [${fields.join(', ')}] on '${collectionPrefix}'.`);
                continue;
            }
            desired.set(computeIndexName(collectionPrefix, fields), {collectionPrefix, fields});
        }
    }

    return provider
        .listOnyxIndexes()
        .then((existingNames) => {
            const existing = new Set(existingNames);

            const namesToCreate = [...desired.keys()].filter((name) => !existing.has(name));
            const namesToDrop = existingNames.filter((name) => !desired.has(name));

            // Sequential on purpose: index builds are O(collection) writes — overlapping them only
            // multiplies peak I/O pressure for no latency benefit.
            let chain = Promise.resolve();
            for (const name of namesToCreate) {
                const spec = desired.get(name);
                if (!spec) {
                    continue;
                }
                chain = chain.then(() => provider.createCollectionIndex?.(name, spec.collectionPrefix, spec.fields));
            }
            for (const name of namesToDrop) {
                chain = chain.then(() => provider.dropIndex?.(name));
            }

            return chain.then(() => {
                if (namesToCreate.length > 0 || namesToDrop.length > 0) {
                    Logger.logInfo(`[OnyxIndexes] Reconciled indexes. Created: [${namesToCreate.join(', ')}] Dropped (undeclared): [${namesToDrop.join(', ')}]`);
                }
                return {supported: true, created: namesToCreate, dropped: namesToDrop};
            });
        })
        .catch((error) => {
            Logger.logAlert(`[OnyxIndexes] Failed to reconcile indexes: ${error}`);
            return {supported: true, created: [], dropped: []};
        });
}

export {setIndexesConfig, getIndexesConfig, computeIndexName, reconcileIndexes, ONYX_INDEX_PREFIX};
export type {OnyxIndexesConfig, OnyxIndexDeclaration, ReconcileIndexesResult};
