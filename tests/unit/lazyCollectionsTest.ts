import {act, renderHook} from '@testing-library/react-native';

import type {StorageKeyValuePair} from '../../lib/storage/providers/types';

import Onyx, {useOnyx} from '../../lib';
import OnyxCache from '../../lib/OnyxCache';
import StorageMock from '../../lib/storage';
import waitForPromisesToResolve from '../utils/waitForPromisesToResolve';

const ONYX_KEYS = {
    COLLECTION: {
        TEST_KEY: 'test_',
        PEOPLE: 'people_',
    },
    SINGLE_KEY: 'single',
};

const SEEDED_MEMBERS = {
    [`${ONYX_KEYS.COLLECTION.TEST_KEY}1`]: {id: 1, title: 'One'},
    [`${ONYX_KEYS.COLLECTION.TEST_KEY}2`]: {id: 2, title: 'Two'},
    [`${ONYX_KEYS.COLLECTION.TEST_KEY}3`]: {id: 3, title: 'Three'},
};

/**
 * Invariant tests for lazy collection hydration (`InitOptions.lazyCollections`).
 * Each test simulates a second app session: data is written straight to storage first
 * (a previous session's persistence), then Onyx.init runs with `test_` configured lazy.
 */
describe('Lazy collections', () => {
    beforeEach(async () => {
        for (const [key, value] of Object.entries(SEEDED_MEMBERS)) {
            await StorageMock.setItem(key, value);
        }
        await StorageMock.setItem(ONYX_KEYS.SINGLE_KEY, {title: 'eager'});

        Onyx.init({
            keys: ONYX_KEYS,
            lazyCollections: [ONYX_KEYS.COLLECTION.TEST_KEY, ONYX_KEYS.COLLECTION.PEOPLE],
        });
        await waitForPromisesToResolve();
    });

    afterEach(async () => {
        await Onyx.clear();
        await waitForPromisesToResolve();
    });

    it('indexes lazy member keys at init but does not load their values', () => {
        // Invariant 1: the key index is always complete (Onyx.clear depends on it).
        const allKeys = OnyxCache.getAllKeys();
        for (const key of Object.keys(SEEDED_MEMBERS)) {
            expect(allKeys.has(key)).toBe(true);
        }

        // Values of lazy members are not resident; eager singletons are.
        expect(OnyxCache.hasCacheForKey(`${ONYX_KEYS.COLLECTION.TEST_KEY}1`)).toBe(false);
        expect(OnyxCache.hasCacheForKey(ONYX_KEYS.SINGLE_KEY)).toBe(true);
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('unhydrated');
    });

    it('hydrates on first collection-root subscription and delivers the full collection in the first callback', async () => {
        const callback = jest.fn();
        Onyx.connectWithoutView({key: ONYX_KEYS.COLLECTION.TEST_KEY, callback});
        await waitForPromisesToResolve();

        // Invariant 2: the first callback carries the complete collection — never a partial one.
        expect(callback).toHaveBeenCalled();
        expect(callback.mock.calls.at(0)?.at(0)).toEqual(SEEDED_MEMBERS);
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('hydrated');
    });

    it('loads only the requested member on a member-key subscription', async () => {
        const callback = jest.fn();
        Onyx.connectWithoutView({key: `${ONYX_KEYS.COLLECTION.TEST_KEY}1`, callback});
        await waitForPromisesToResolve();

        // Invariant 6 / decision D3: a member subscription hydrates just that member.
        expect(callback).toHaveBeenCalledWith(SEEDED_MEMBERS[`${ONYX_KEYS.COLLECTION.TEST_KEY}1`], `${ONYX_KEYS.COLLECTION.TEST_KEY}1`);
        expect(OnyxCache.hasCacheForKey(`${ONYX_KEYS.COLLECTION.TEST_KEY}1`)).toBe(true);
        expect(OnyxCache.hasCacheForKey(`${ONYX_KEYS.COLLECTION.TEST_KEY}2`)).toBe(false);
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('unhydrated');
    });

    it('deletes an unhydrated member from storage on Onyx.set(key, null)', async () => {
        await Onyx.set(`${ONYX_KEYS.COLLECTION.TEST_KEY}2`, null);
        await waitForPromisesToResolve();

        const storedValue = await StorageMock.getItem(`${ONYX_KEYS.COLLECTION.TEST_KEY}2`);
        expect(storedValue ?? undefined).toBeUndefined();
        expect(OnyxCache.getAllKeys().has(`${ONYX_KEYS.COLLECTION.TEST_KEY}2`)).toBe(false);
    });

    it('clear() wipes unhydrated lazy members from storage and resets hydration', async () => {
        await Onyx.clear();
        await waitForPromisesToResolve();

        // Invariant 1 consequence: no cross-account leak — the rows are gone even though their
        // values were never loaded into cache.
        const remainingKeys = await StorageMock.getAllKeys();
        for (const key of Object.keys(SEEDED_MEMBERS)) {
            expect(remainingKeys).not.toContain(key);
        }
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('unhydrated');
    });

    it('shares one storage read between concurrent collection-root subscriptions', async () => {
        const getByPrefixSpy = StorageMock.getByPrefix as jest.Mock;
        getByPrefixSpy.mockClear();

        Onyx.connectWithoutView({key: ONYX_KEYS.COLLECTION.TEST_KEY, callback: jest.fn()});
        Onyx.connectWithoutView({key: ONYX_KEYS.COLLECTION.TEST_KEY, callback: jest.fn()});
        await waitForPromisesToResolve();

        const testKeyReads = getByPrefixSpy.mock.calls.filter((call) => call.at(0) === ONYX_KEYS.COLLECTION.TEST_KEY);
        expect(testKeyReads).toHaveLength(1);
    });

    it('never delivers a partial collection to a root subscriber when a write lands mid-hydration', async () => {
        // Hold the hydration read open so we can interleave a write while state is `hydrating`.
        let releaseHydration: (pairs: StorageKeyValuePair[]) => void = () => {};
        const heldRead = new Promise<StorageKeyValuePair[]>((resolve) => {
            releaseHydration = resolve;
        });
        const getByPrefixSpy = StorageMock.getByPrefix as jest.Mock;
        getByPrefixSpy.mockImplementationOnce(() => heldRead);

        const callback = jest.fn();
        Onyx.connectWithoutView({key: ONYX_KEYS.COLLECTION.TEST_KEY, callback});
        await waitForPromisesToResolve();
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('hydrating');

        // A member write arrives while hydrating — the root subscriber must NOT see a 1-member collection.
        Onyx.merge(`${ONYX_KEYS.COLLECTION.TEST_KEY}1`, {title: 'One updated'});
        await waitForPromisesToResolve();
        expect(callback).not.toHaveBeenCalled();

        releaseHydration(Object.entries(SEEDED_MEMBERS) as StorageKeyValuePair[]);
        await waitForPromisesToResolve();

        // The single callback carries the complete collection, with the mid-hydration write applied
        // (cache-first writes win over the storage read).
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls.at(0)?.at(0)).toEqual({
            ...SEEDED_MEMBERS,
            [`${ONYX_KEYS.COLLECTION.TEST_KEY}1`]: {id: 1, title: 'One updated'},
        });
    });

    it('reports an empty lazy collection as hydrated-empty, not loading', async () => {
        const callback = jest.fn();
        Onyx.connectWithoutView({key: ONYX_KEYS.COLLECTION.PEOPLE, callback});
        await waitForPromisesToResolve();

        expect(callback).toHaveBeenCalledWith(undefined, ONYX_KEYS.COLLECTION.PEOPLE);
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.PEOPLE)).toBe('hydrated');
    });

    it('useOnyx transitions loading → loaded with the full collection', async () => {
        const {result} = renderHook(() => useOnyx(ONYX_KEYS.COLLECTION.TEST_KEY));

        expect(result.current.at(1)).toMatchObject({status: 'loading'});
        expect(result.current.at(0)).toBeUndefined();

        await act(async () => waitForPromisesToResolve());

        expect(result.current.at(1)).toMatchObject({status: 'loaded'});
        expect(result.current.at(0)).toEqual(SEEDED_MEMBERS);
    });

    it('discards a hydration read that races a clear() instead of resurrecting deleted rows', async () => {
        let releaseHydration: (pairs: StorageKeyValuePair[]) => void = () => {};
        const heldRead = new Promise<StorageKeyValuePair[]>((resolve) => {
            releaseHydration = resolve;
        });
        const getByPrefixSpy = StorageMock.getByPrefix as jest.Mock;
        getByPrefixSpy.mockImplementationOnce(() => heldRead);

        Onyx.connectWithoutView({key: ONYX_KEYS.COLLECTION.TEST_KEY, callback: jest.fn()});
        await waitForPromisesToResolve();

        const clearPromise = Onyx.clear();
        releaseHydration(Object.entries(SEEDED_MEMBERS) as StorageKeyValuePair[]);
        await clearPromise;
        await waitForPromisesToResolve();

        // The previous session's rows must not have been merged back into cache by the stale read.
        expect(OnyxCache.get(`${ONYX_KEYS.COLLECTION.TEST_KEY}1`)).toBeUndefined();
        expect(Onyx.getHydrationStatus(ONYX_KEYS.COLLECTION.TEST_KEY)).toBe('unhydrated');
    });
});
