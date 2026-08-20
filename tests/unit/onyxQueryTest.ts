import {act, renderHook} from '@testing-library/react-native';

import Onyx, {queryCollection, useOnyxQuery} from '../../lib';
import OnyxCache from '../../lib/OnyxCache';
import StorageMock from '../../lib/storage';
import waitForPromisesToResolve from '../utils/waitForPromisesToResolve';

const ONYX_KEYS = {
    COLLECTION: {
        TEST_KEY: 'test_',
    },
};

/** Seeds `count` members with a numeric `order` field and a `kind` alternating a/b. */
async function seedMembers(count: number) {
    for (let index = 1; index <= count; index++) {
        // eslint-disable-next-line no-await-in-loop
        await StorageMock.setItem(`${ONYX_KEYS.COLLECTION.TEST_KEY}${index}`, {id: index, order: index, kind: index % 2 === 0 ? 'a' : 'b'});
    }
}

describe('queryCollection', () => {
    beforeEach(async () => {
        await seedMembers(10);
        Onyx.init({keys: ONYX_KEYS, lazyCollections: [ONYX_KEYS.COLLECTION.TEST_KEY]});
        await waitForPromisesToResolve();
    });

    afterEach(async () => {
        await Onyx.clear();
        await waitForPromisesToResolve();
    });

    it('returns only the requested page in order, without hydrating the collection', async () => {
        const result = await queryCollection(ONYX_KEYS.COLLECTION.TEST_KEY, {orderBy: {field: 'order', direction: 'desc'}, limit: 3});

        expect(result.items.map((item) => item.key)).toEqual([`${ONYX_KEYS.COLLECTION.TEST_KEY}10`, `${ONYX_KEYS.COLLECTION.TEST_KEY}9`, `${ONYX_KEYS.COLLECTION.TEST_KEY}8`]);
        expect(result.hasMore).toBe(true);
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('unhydrated');
    });

    it('paginates with a keyset cursor without duplicates or gaps', async () => {
        const query = {orderBy: {field: 'order', direction: 'asc' as const}, limit: 4};
        const firstPage = await queryCollection(ONYX_KEYS.COLLECTION.TEST_KEY, query);
        const secondPage = await queryCollection(ONYX_KEYS.COLLECTION.TEST_KEY, {...query, after: firstPage.nextCursor});
        const thirdPage = await queryCollection(ONYX_KEYS.COLLECTION.TEST_KEY, {...query, after: secondPage.nextCursor});

        const allIDs = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) => (item.value as {id: number}).id);
        expect(allIDs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(thirdPage.hasMore).toBe(false);
    });

    it('filters with where conditions', async () => {
        const result = await queryCollection(ONYX_KEYS.COLLECTION.TEST_KEY, {
            where: [
                {field: 'kind', operator: 'eq', value: 'a'},
                {field: 'order', operator: 'gt', value: 4},
            ],
            orderBy: {field: 'order', direction: 'asc'},
            limit: 10,
        });

        expect(result.items.map((item) => (item.value as {id: number}).id)).toEqual([6, 8, 10]);
    });

    it('overlays optimistic cache writes over storage results (cache wins per key)', async () => {
        // Simulate an optimistic write that landed in cache but has NOT been persisted yet — the
        // exact window where a storage-only read would return stale data.
        OnyxCache.set(`${ONYX_KEYS.COLLECTION.TEST_KEY}10`, {id: 10, order: 0, kind: 'a'});
        const result = await queryCollection(ONYX_KEYS.COLLECTION.TEST_KEY, {orderBy: {field: 'order', direction: 'asc'}, limit: 3});

        expect(result.items.at(0)?.key).toBe(`${ONYX_KEYS.COLLECTION.TEST_KEY}10`);
        expect((await StorageMock.getItem(`${ONYX_KEYS.COLLECTION.TEST_KEY}10`))?.order).toBe(10);
    });
});

describe('useOnyxQuery', () => {
    beforeEach(async () => {
        await seedMembers(10);
        Onyx.init({keys: ONYX_KEYS, lazyCollections: [ONYX_KEYS.COLLECTION.TEST_KEY]});
        await waitForPromisesToResolve();
    });

    afterEach(async () => {
        await Onyx.clear();
        await waitForPromisesToResolve();
    });

    function renderQuery() {
        return renderHook(() =>
            useOnyxQuery(ONYX_KEYS.COLLECTION.TEST_KEY, {
                orderBy: {field: 'order', direction: 'asc'},
                batchSize: 3,
            }),
        );
    }

    it('loads the first batch and grows the window via loadMore', async () => {
        const {result} = renderQuery();
        expect(result.current.status).toBe('loading');

        await act(async () => waitForPromisesToResolve());
        expect(result.current.status).toBe('loaded');
        expect(result.current.items.map((item) => (item.value as {id: number}).id)).toEqual([1, 2, 3]);
        expect(result.current.hasMore).toBe(true);

        await act(async () => {
            result.current.loadMore();
            return waitForPromisesToResolve();
        });
        expect(result.current.items.map((item) => (item.value as {id: number}).id)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('patches an in-place change synchronously without a re-query', async () => {
        const {result} = renderQuery();
        await act(async () => waitForPromisesToResolve());

        await act(async () => {
            Onyx.merge(`${ONYX_KEYS.COLLECTION.TEST_KEY}2`, {kind: 'updated'});
            return waitForPromisesToResolve();
        });

        const updated = result.current.items.find((item) => item.key === `${ONYX_KEYS.COLLECTION.TEST_KEY}2`);
        expect((updated?.value as {kind: string}).kind).toBe('updated');
        expect(result.current.items).toHaveLength(3);
    });

    it('removes a deleted member immediately and backfills the window on reconcile', async () => {
        const {result} = renderQuery();
        await act(async () => waitForPromisesToResolve());

        await act(async () => {
            Onyx.set(`${ONYX_KEYS.COLLECTION.TEST_KEY}2`, null);
            return waitForPromisesToResolve();
        });

        // Patch phase: the row is gone synchronously, before any re-query.
        expect(result.current.items.map((item) => (item.value as {id: number}).id)).toEqual([1, 3]);

        // Reconcile phase: the debounced (50ms) window re-query backfills the tail.
        await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
        expect(result.current.items.map((item) => (item.value as {id: number}).id)).toEqual([1, 3, 4]);
    });

    it('brings a new matching member into the window via reconcile', async () => {
        const {result} = renderQuery();
        await act(async () => waitForPromisesToResolve());

        await act(async () => {
            Onyx.merge(`${ONYX_KEYS.COLLECTION.TEST_KEY}99`, {id: 99, order: 0, kind: 'b'});
            return waitForPromisesToResolve();
        });
        await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));

        expect(result.current.items.map((item) => (item.value as {id: number}).id)).toEqual([99, 1, 2]);
    });
});
