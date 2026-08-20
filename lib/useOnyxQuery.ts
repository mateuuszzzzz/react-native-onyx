/**
 * React hook for windowed, live collection queries (lazy-Onyx POC, Phase 2b).
 *
 * UI-wise there are no pages — `items` is one contiguous, ordered array meant to feed an
 * infinite-scroll list, and `loadMore` (wired to `onEndReached`) grows it by `batchSize`. "Batch" is
 * purely the I/O unit of one storage fetch.
 *
 * Live updates follow the patch-then-reconcile model with ONE watcher per query (never per page or
 * per item). Every collection write is classified:
 * 1. irrelevant (fails `where`, not in the window) → ignored;
 * 2. in-place (member in window, sort value and match unchanged) → the item is patched into the
 *    window synchronously from the written value;
 * 3. order/membership change → applied to the window synchronously (a removed member disappears
 *    immediately — identical UX to eager collections), then a debounced re-query of the WHOLE window
 *    reconciles ordering and backfills the tail. The re-query is reconciliation, never the source of
 *    the visible change.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {CollectionQuery, OrderBy, QueryCursor, QueryResultItem, WhereCondition} from './OnyxQuery';
import type {OnyxKey, OnyxValue} from './types';

import {compareItems, evaluateWhere, getFieldValue, queryCollection, registerQueryWatcher} from './OnyxQuery';

type UseOnyxQueryOptions = {
    where?: WhereCondition[];
    orderBy: OrderBy;
    /** How many items one storage fetch returns (the I/O unit — invisible to the UI). @default 20 */
    batchSize?: number;
    /**
     * Upper bound for the live window. `loadMore` stops growing the window past it, which caps the
     * cost of reconciliation re-queries. @default 200
     */
    maxWindowSize?: number;
};

type UseOnyxQueryResult = {
    /** The contiguous, ordered window — feed it straight to the list component. */
    items: QueryResultItem[];
    loadMore: () => void;
    hasMore: boolean;
    status: 'loading' | 'loaded';
};

const RECONCILE_DEBOUNCE_MS = 50;

function useOnyxQuery(collectionKey: OnyxKey, options: UseOnyxQueryOptions): UseOnyxQueryResult {
    const batchSize = options.batchSize ?? 20;
    const maxWindowSize = options.maxWindowSize ?? 200;

    const [items, setItems] = useState<QueryResultItem[]>([]);
    const [hasMore, setHasMore] = useState(true);
    const [status, setStatus] = useState<'loading' | 'loaded'>('loading');

    // The query identity — changing where/orderBy resets the window. Serialized so consumers can
    // pass fresh object literals every render without re-subscribing.
    const querySignature = JSON.stringify([collectionKey, options.where ?? null, options.orderBy]);

    // Live state the watcher reads without re-subscribing: current window + target size.
    const windowRef = useRef<QueryResultItem[]>([]);
    const hasMoreRef = useRef(true);
    const windowSizeRef = useRef(batchSize);
    const isLoadingMoreRef = useRef(false);
    const reconcileTimerRef = useRef<ReturnType<typeof setTimeout>>();

    const optionsRef = useRef(options);
    optionsRef.current = options;

    const commitWindow = useCallback((newItems: QueryResultItem[], newHasMore: boolean) => {
        windowRef.current = newItems;
        hasMoreRef.current = newHasMore;
        setItems(newItems);
        setHasMore(newHasMore);
        setStatus('loaded');
    }, []);

    // Re-runs the query for the whole current window (never per batch — page boundaries shift under
    // membership changes and would produce duplicates/gaps).
    const runWindowQuery = useCallback(() => {
        const {where, orderBy} = optionsRef.current;
        return queryCollection(collectionKey, {where, orderBy, limit: windowSizeRef.current}).then((result) => {
            commitWindow(result.items, result.hasMore);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [collectionKey, querySignature, commitWindow]);

    const scheduleReconcile = useCallback(() => {
        if (reconcileTimerRef.current) {
            return;
        }
        reconcileTimerRef.current = setTimeout(() => {
            reconcileTimerRef.current = undefined;
            runWindowQuery();
        }, RECONCILE_DEBOUNCE_MS);
    }, [runWindowQuery]);

    useEffect(() => {
        windowSizeRef.current = batchSize;
        setStatus('loading');
        runWindowQuery();

        const unregister = registerQueryWatcher(collectionKey, (key, value) => {
            const {where, orderBy} = optionsRef.current;
            const window = windowRef.current;
            const windowIndex = window.findIndex((item) => item.key === key);
            const matchesNow = value !== null && value !== undefined && evaluateWhere(value, where);

            // 1. Irrelevant: the write neither belongs to the window nor would enter it.
            if (windowIndex === -1 && !matchesNow) {
                return;
            }

            // 2. In-place: same membership, same position — patch the row synchronously, no re-query.
            if (windowIndex !== -1 && matchesNow) {
                const previousSortValue = getFieldValue(window[windowIndex].value, orderBy.field);
                const nextSortValue = getFieldValue(value, orderBy.field);
                if (previousSortValue === nextSortValue) {
                    const patched = window.slice();
                    patched[windowIndex] = {key, value: value as OnyxValue<OnyxKey>};
                    commitWindow(patched, hasMoreRef.current);
                    return;
                }
            }

            // 3. Membership/order change: apply the visible part synchronously (deletion disappears
            // NOW), reconcile ordering + tail via the debounced window re-query.
            if (windowIndex !== -1 && !matchesNow) {
                commitWindow(
                    window.filter((item) => item.key !== key),
                    hasMoreRef.current,
                );
            }
            scheduleReconcile();
        });

        return () => {
            unregister();
            if (reconcileTimerRef.current) {
                clearTimeout(reconcileTimerRef.current);
                reconcileTimerRef.current = undefined;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [collectionKey, querySignature]);

    const loadMore = useCallback(() => {
        if (isLoadingMoreRef.current || windowSizeRef.current >= maxWindowSize) {
            return;
        }
        const {where, orderBy} = optionsRef.current;
        const lastItem = windowRef.current.at(-1);
        if (!lastItem) {
            return;
        }
        isLoadingMoreRef.current = true;
        const after: QueryCursor = {sortValue: getFieldValue(lastItem.value, orderBy.field), recordKey: lastItem.key};
        const batchQuery: CollectionQuery = {where, orderBy, limit: batchSize, after};
        queryCollection(collectionKey, batchQuery)
            .then((result) => {
                // Append, dedupe on key (a reconcile may have raced the batch), and keep the order total.
                const knownKeys = new Set(windowRef.current.map((item) => item.key));
                const appended = [...windowRef.current, ...result.items.filter((item) => !knownKeys.has(item.key))];
                appended.sort((a, b) =>
                    compareItems({sortValue: getFieldValue(a.value, orderBy.field), key: a.key}, {sortValue: getFieldValue(b.value, orderBy.field), key: b.key}, orderBy.direction),
                );
                windowSizeRef.current = appended.length;
                commitWindow(appended, result.hasMore);
            })
            .finally(() => {
                isLoadingMoreRef.current = false;
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [collectionKey, querySignature, batchSize, maxWindowSize, commitWindow]);

    return {items, loadMore, hasMore, status};
}

export default useOnyxQuery;
export type {UseOnyxQueryOptions, UseOnyxQueryResult};
