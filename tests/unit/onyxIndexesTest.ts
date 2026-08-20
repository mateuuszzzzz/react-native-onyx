import Onyx from '../../lib';
import {computeIndexName, setIndexesConfig} from '../../lib/OnyxIndexes';
import StorageMock from '../../lib/storage';
import waitForPromisesToResolve from '../utils/waitForPromisesToResolve';

const ONYX_KEYS = {
    COLLECTION: {
        TEST_KEY: 'test_',
        PEOPLE: 'people_',
    },
};

type FakeIndexProvider = {
    listOnyxIndexes?: jest.Mock;
    createCollectionIndex?: jest.Mock;
    dropIndex?: jest.Mock;
};

describe('Onyx.reconcileIndexes', () => {
    beforeEach(async () => {
        Onyx.init({keys: ONYX_KEYS});
        await waitForPromisesToResolve();
    });

    afterEach(async () => {
        const provider = StorageMock.getStorageProvider() as FakeIndexProvider;
        delete provider.listOnyxIndexes;
        delete provider.createCollectionIndex;
        delete provider.dropIndex;
        await Onyx.clear();
        await waitForPromisesToResolve();
    });

    it('reports unsupported on providers without index capabilities', async () => {
        setIndexesConfig({[ONYX_KEYS.COLLECTION.TEST_KEY]: ['order']});
        const result = await Onyx.reconcileIndexes();
        expect(result).toEqual({supported: false, created: [], dropped: []});
    });

    it('creates declared-but-missing indexes and drops undeclared managed ones', async () => {
        const provider = StorageMock.getStorageProvider() as FakeIndexProvider;
        const orphanName = computeIndexName(ONYX_KEYS.COLLECTION.PEOPLE, ['removedField']);
        provider.listOnyxIndexes = jest.fn(() => Promise.resolve([orphanName]));
        provider.createCollectionIndex = jest.fn(() => Promise.resolve());
        provider.dropIndex = jest.fn(() => Promise.resolve());

        setIndexesConfig({[ONYX_KEYS.COLLECTION.TEST_KEY]: ['order', 'kind']});
        const result = await Onyx.reconcileIndexes();

        expect(result.supported).toBe(true);
        expect(result.created.sort()).toEqual([computeIndexName(ONYX_KEYS.COLLECTION.TEST_KEY, ['kind']), computeIndexName(ONYX_KEYS.COLLECTION.TEST_KEY, ['order'])].sort());
        // The orphan existed in storage but is not declared in code — reconciliation detects and drops it.
        expect(result.dropped).toEqual([orphanName]);
        expect(provider.dropIndex).toHaveBeenCalledWith(orphanName);
        expect(provider.createCollectionIndex).toHaveBeenCalledWith(computeIndexName(ONYX_KEYS.COLLECTION.TEST_KEY, ['order']), ONYX_KEYS.COLLECTION.TEST_KEY, ['order']);
    });

    it('is a no-op when storage already matches the declaration', async () => {
        const provider = StorageMock.getStorageProvider() as FakeIndexProvider;
        const declaredName = computeIndexName(ONYX_KEYS.COLLECTION.TEST_KEY, ['order']);
        provider.listOnyxIndexes = jest.fn(() => Promise.resolve([declaredName]));
        provider.createCollectionIndex = jest.fn(() => Promise.resolve());
        provider.dropIndex = jest.fn(() => Promise.resolve());

        setIndexesConfig({[ONYX_KEYS.COLLECTION.TEST_KEY]: ['order']});
        const result = await Onyx.reconcileIndexes();

        expect(result).toEqual({supported: true, created: [], dropped: []});
        expect(provider.createCollectionIndex).not.toHaveBeenCalled();
        expect(provider.dropIndex).not.toHaveBeenCalled();
    });

    it('supports composite indexes declared as field arrays', async () => {
        const provider = StorageMock.getStorageProvider() as FakeIndexProvider;
        provider.listOnyxIndexes = jest.fn(() => Promise.resolve([]));
        provider.createCollectionIndex = jest.fn(() => Promise.resolve());
        provider.dropIndex = jest.fn(() => Promise.resolve());

        setIndexesConfig({[ONYX_KEYS.COLLECTION.TEST_KEY]: [['policyID', 'order']]});
        const result = await Onyx.reconcileIndexes();

        const compositeName = computeIndexName(ONYX_KEYS.COLLECTION.TEST_KEY, ['policyID', 'order']);
        expect(result.created).toEqual([compositeName]);
        expect(provider.createCollectionIndex).toHaveBeenCalledWith(compositeName, ONYX_KEYS.COLLECTION.TEST_KEY, ['policyID', 'order']);
    });

    it('skips invalid field names instead of generating unsafe SQL identifiers', async () => {
        const provider = StorageMock.getStorageProvider() as FakeIndexProvider;
        provider.listOnyxIndexes = jest.fn(() => Promise.resolve([]));
        provider.createCollectionIndex = jest.fn(() => Promise.resolve());
        provider.dropIndex = jest.fn(() => Promise.resolve());

        setIndexesConfig({[ONYX_KEYS.COLLECTION.TEST_KEY]: ["bad'; DROP TABLE keyvaluepairs;--", 'goodField']});
        const result = await Onyx.reconcileIndexes();

        expect(result.created).toEqual([computeIndexName(ONYX_KEYS.COLLECTION.TEST_KEY, ['goodField'])]);
    });
});
