import type {KeyValueMapping, OnyxKey, OnyxValue} from './types';

/**
 * Paginated, predicate-filtered reads over a collection without hydrating it (lazy-Onyx POC, Phase 2b).
 *
 * A query executes against SQLite (range scan + json_extract, only the requested rows return to JS)
 * when the active provider implements `queryByPrefix`, and falls back to a prefix read filtered in JS
 * otherwise. The `where` mini-DSL is deliberately narrow — equality, inequality, IN, range, AND — so
 * every predicate is expressible in BOTH engines: SQL for the storage read, JS for the cache overlay
 * and for live-query invalidation (deciding cheaply whether a write affects a query).
 *
 * Consistency model: cache wins per key. Rows returned from storage are overridden by warm cache
 * values; cache-only members (optimistic writes not yet persisted, hydrated members) are merged in via
 * the JS predicate. Query results are NOT marked as collection hydration — loaded members become warm
 * cache entries, and the collection's hydration state is untouched.
 */
import cache from './OnyxCache';
import OnyxKeys from './OnyxKeys';
import Storage from './storage';

type QueryComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

type WhereCondition =
    | {field: string; operator: QueryComparisonOperator; value: string | number | boolean | null}
    | {field: string; operator: 'in'; value: Array<string | number | boolean | null>};

type OrderBy = {
    field: string;
    direction: 'asc' | 'desc';
};

/** Keyset cursor: the sort value and record key of the last returned item. Stable under inserts, unlike OFFSET. */
type QueryCursor = {
    sortValue: string | number | boolean | null;
    recordKey: OnyxKey;
};

type CollectionQuery = {
    /** Conditions combined with AND. Every condition must hold for a member to be included. */
    where?: WhereCondition[];
    orderBy: OrderBy;
    limit: number;
    /** Return items strictly after this cursor in the query's order (keyset pagination). */
    after?: QueryCursor;
};

type QueryResultItem = {
    key: OnyxKey;
    value: OnyxValue<OnyxKey>;
};

type QueryResult = {
    items: QueryResultItem[];
    /** Cursor of the last returned item; undefined when the result is empty. */
    nextCursor?: QueryCursor;
    /** False when fewer than `limit` items were returned — the query is exhausted. */
    hasMore: boolean;
};

/** A scalar read from a member value at the query's field path. Objects/arrays are not orderable/filterable. */
function getFieldValue(value: unknown, field: string): string | number | boolean | null {
    if (value === null || typeof value !== 'object') {
        return null;
    }
    const fieldValue = (value as Record<string, unknown>)[field];
    if (typeof fieldValue === 'string' || typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
        return fieldValue;
    }
    return null;
}

/** JS engine of the two-engine predicate. Must mirror the SQL the provider generates. */
function evaluateWhere(value: unknown, where: WhereCondition[] | undefined): boolean {
    if (!where || where.length === 0) {
        return true;
    }
    for (const condition of where) {
        const fieldValue = getFieldValue(value, condition.field);
        switch (condition.operator) {
            case 'eq':
                if (fieldValue !== condition.value) return false;
                break;
            case 'neq':
                if (fieldValue === condition.value) return false;
                break;
            case 'in':
                if (!condition.value.includes(fieldValue)) return false;
                break;
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte': {
                if (fieldValue === null || condition.value === null) return false;
                if (condition.operator === 'gt' && !(fieldValue > condition.value)) return false;
                if (condition.operator === 'gte' && !(fieldValue >= condition.value)) return false;
                if (condition.operator === 'lt' && !(fieldValue < condition.value)) return false;
                if (condition.operator === 'lte' && !(fieldValue <= condition.value)) return false;
                break;
            }
            default:
                return false;
        }
    }
    return true;
}

/**
 * Total order over (sortValue, recordKey) matching SQLite semantics closely enough for our scalars:
 * nulls sort first ascending; the record key tie-breaks so the order (and thus keyset cursors) is total.
 */
function compareItems(
    a: {sortValue: string | number | boolean | null; key: OnyxKey},
    b: {sortValue: string | number | boolean | null; key: OnyxKey},
    direction: OrderBy['direction'],
): number {
    let result: number;
    if (a.sortValue === b.sortValue) {
        result = 0;
    } else if (a.sortValue === null) {
        result = -1;
    } else if (b.sortValue === null) {
        result = 1;
    } else {
        result = a.sortValue < b.sortValue ? -1 : 1;
    }
    if (result === 0) {
        result = a.key === b.key ? 0 : a.key < b.key ? -1 : 1;
    }
    return direction === 'desc' ? -result : result;
}

/** Whether an item lies strictly after the cursor in the query's order. */
function isAfterCursor(item: {sortValue: string | number | boolean | null; key: OnyxKey}, cursor: QueryCursor, direction: OrderBy['direction']): boolean {
    return compareItems(item, {sortValue: cursor.sortValue, key: cursor.recordKey}, direction) > 0;
}

/**
 * Executes the query in JS over an iterable of [key, value] pairs — used over the warm cache, over
 * fallback prefix reads, and to overlay cache values on top of a native storage result.
 */
function runQueryInJS(pairs: Iterable<[OnyxKey, unknown]>, query: CollectionQuery): QueryResult {
    const matching: Array<{key: OnyxKey; value: unknown; sortValue: string | number | boolean | null}> = [];
    for (const [key, value] of pairs) {
        if (value === null || value === undefined || !evaluateWhere(value, query.where)) {
            continue;
        }
        const candidate = {key, value, sortValue: getFieldValue(value, query.orderBy.field)};
        if (query.after && !isAfterCursor(candidate, query.after, query.orderBy.direction)) {
            continue;
        }
        matching.push(candidate);
    }

    matching.sort((a, b) => compareItems(a, b, query.orderBy.direction));
    const limited = matching.slice(0, query.limit);
    const lastItem = limited.at(-1);
    return {
        items: limited.map(({key, value}) => ({key, value: value as OnyxValue<OnyxKey>})),
        nextCursor: lastItem ? {sortValue: lastItem.sortValue, recordKey: lastItem.key} : undefined,
        hasMore: matching.length > query.limit,
    };
}

/** All warm cache members of a collection as [key, value] pairs. */
function getWarmCacheMembers(collectionKey: OnyxKey): Array<[OnyxKey, unknown]> {
    const memberKeys = OnyxKeys.getMembersOfCollection(collectionKey);
    const pairs: Array<[OnyxKey, unknown]> = [];
    if (!memberKeys) {
        return pairs;
    }
    for (const key of memberKeys) {
        const value = cache.get(key);
        if (value !== undefined) {
            pairs.push([key, value]);
        }
    }
    return pairs;
}

/**
 * Queries a collection: `where` (AND mini-DSL) + `orderBy` + `limit` + keyset cursor.
 *
 * Hydrated (or non-lazy) collections are answered purely from cache — it is complete and authoritative.
 * Unhydrated lazy collections read from storage (native SQL when available, prefix read otherwise) and
 * overlay warm cache members: cache wins per key, and cache-only members are merged in through the JS
 * predicate so optimistic writes are never missing from results.
 */
function queryCollection(collectionKey: OnyxKey, query: CollectionQuery): Promise<QueryResult> {
    if (!OnyxKeys.isCollectionKey(collectionKey)) {
        return Promise.reject(new Error(`queryCollection() requires a collection key, got '${collectionKey}'.`));
    }

    if (cache.getHydrationState(collectionKey) === 'hydrated') {
        const collectionData = cache.getCollectionData(collectionKey) ?? {};
        return Promise.resolve(runQueryInJS(Object.entries(collectionData), query));
    }

    const warmMembers = getWarmCacheMembers(collectionKey);

    /** Overlay storage rows with the warm cache (cache wins per key) and finish the query in JS. */
    const overlayAndRun = (pairs: Array<[OnyxKey, unknown]> | ReadonlyArray<readonly [OnyxKey, unknown, unknown?]>): QueryResult => {
        const merged = new Map<OnyxKey, unknown>();
        for (const [key, value] of pairs) {
            if (OnyxKeys.isRamOnlyKey(key)) {
                continue;
            }
            merged.set(key, cache.get(key) ?? value);
        }
        for (const [key, value] of warmMembers) {
            merged.set(key, value);
        }
        return runQueryInJS(merged.entries(), query);
    };

    // Native fast path: SQLite evaluates where/order/limit and only the requested rows are parsed
    // and returned to JS. Overfetch by the warm-member count — a cache-modified row can displace a
    // persisted row out of the SQL top-N, so the JS re-sort over the union needs that slack to still
    // produce a correct page.
    const provider = Storage.getStorageProvider();
    if (provider.queryByPrefix && !(query.after && query.after.sortValue === null)) {
        const storageQuery = {where: query.where, orderBy: query.orderBy, limit: query.limit + warmMembers.length + 1, after: query.after};
        return provider
            .queryByPrefix(collectionKey, storageQuery)
            .then((rows) => {
                const result = overlayAndRun(rows);
                // The SQL read was bounded — a full page from it implies more rows may follow even
                // when the JS pass over the bounded union saw the end.
                return {...result, hasMore: result.hasMore || rows.length >= storageQuery.limit};
            })
            .catch(() => Storage.getByPrefix(collectionKey).then(overlayAndRun));
    }

    return Storage.getByPrefix(collectionKey).then(overlayAndRun);
}

// #region Live-query watchers
type QueryWatcher = (key: OnyxKey, value: unknown) => void;

const queryWatchers = new Map<OnyxKey, Set<QueryWatcher>>();

/**
 * Registers a listener for every write landing in the given collection. Deliberately NOT an Onyx
 * subscription: a collection-root subscription would force full hydration, which is exactly what a
 * query consumer avoids. Returns an unregister function.
 */
function registerQueryWatcher(collectionKey: OnyxKey, watcher: QueryWatcher): () => void {
    let watchers = queryWatchers.get(collectionKey);
    if (!watchers) {
        watchers = new Set();
        queryWatchers.set(collectionKey, watchers);
    }
    watchers.add(watcher);
    return () => {
        watchers.delete(watcher);
        if (watchers.size === 0) {
            queryWatchers.delete(collectionKey);
        }
    };
}

/** Called from the write broadcast paths (keyChanged/keysChanged). Cheap no-op when nothing watches. */
function notifyQueryWatchers(key: OnyxKey, value: unknown): void {
    if (queryWatchers.size === 0) {
        return;
    }
    const collectionKey = OnyxKeys.getCollectionKey(key);
    if (!collectionKey) {
        return;
    }
    const watchers = queryWatchers.get(collectionKey);
    if (!watchers) {
        return;
    }
    for (const watcher of watchers) {
        watcher(key, value);
    }
}
// #endregion

export {queryCollection, evaluateWhere, getFieldValue, compareItems, registerQueryWatcher, notifyQueryWatchers};
export type {CollectionQuery, WhereCondition, OrderBy, QueryCursor, QueryResult, QueryResultItem, KeyValueMapping};
