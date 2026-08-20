import type {OnyxKey} from '../types';
import type StorageProvider from './providers/types';

import * as Logger from '../Logger';
import InstanceSync from './InstanceSync';
import PlatformStorage from './platforms';
import MemoryOnlyProvider from './providers/MemoryOnlyProvider';

let provider = PlatformStorage as StorageProvider<unknown>;
let shouldKeepInstancesSync = false;
let finishInitalization: (value?: unknown) => void;
const initPromise = new Promise((resolve) => {
    finishInitalization = resolve;
});

type Storage = {
    getStorageProvider: () => StorageProvider<unknown>;
    /** Always present on the facade (native implementation or getAllKeys+multiGet fallback), unlike providers where it's optional. */
    getByPrefix: NonNullable<StorageProvider<unknown>['getByPrefix']>;
} & Omit<StorageProvider<unknown>, 'name' | 'store' | 'getByPrefix'>;

/**
 * Degrade performance by removing the storage provider and only using cache
 */
function degradePerformance(error: Error) {
    Logger.logHmmm(`Error while using ${provider.name}. Falling back to only using cache and dropping storage.\n Error: ${error.message}\n Stack: ${error.stack}\n Cause: ${error.cause}`);
    console.error(error);
    provider = MemoryOnlyProvider;
}

/**
 * Runs a piece of code and degrades performance if certain errors are thrown
 */
function tryOrDegradePerformance<T>(fn: () => Promise<T> | T, waitForInitialization = true): Promise<T> {
    const initialization = waitForInitialization ? initPromise : Promise.resolve();
    return initialization
        .then(() => fn())
        .catch((error: unknown) => {
            // catch the error if DB connection can not be established/DB can not be created
            if (error instanceof Error && error.message.includes('IDBKeyVal store could not be created')) {
                degradePerformance(error);
            }
            return Promise.reject(error);
        });
}

const storage: Storage = {
    /**
     * Returns the storage provider currently in use
     */
    getStorageProvider() {
        return provider;
    },

    /**
     * Classifies a write error using the active provider's own classifier. Synchronous and pure —
     * never wrapped in tryOrDegradePerformance.
     */
    classifyError: (error) => provider.classifyError(error),

    /**
     * Initializes all providers in the list of storage providers
     * and enables fallback providers if necessary
     */
    init() {
        tryOrDegradePerformance(provider.init, false).finally(() => {
            finishInitalization();
        });
    },

    /**
     * Get the value of a given key or return `null` if it's not available
     */
    getItem: (key) => tryOrDegradePerformance(() => provider.getItem(key)),

    /**
     * Get multiple key-value pairs for the give array of keys in a batch
     */
    multiGet: (keys) => tryOrDegradePerformance(() => provider.multiGet(keys)),

    /**
     * Sets the value for a given key. The only requirement is that the value should be serializable to JSON string
     */
    setItem: (key, value) =>
        tryOrDegradePerformance(() => {
            const promise = provider.setItem(key, value);

            if (shouldKeepInstancesSync) {
                return promise.then(() => InstanceSync.setItem(key));
            }

            return promise;
        }),

    /**
     * Stores multiple key-value pairs in a batch
     */
    multiSet: (pairs) =>
        tryOrDegradePerformance(() => {
            const promise = provider.multiSet(pairs);

            if (shouldKeepInstancesSync) {
                return promise.then(() => InstanceSync.multiSet(pairs.map((pair) => pair[0])));
            }

            return promise;
        }),

    /**
     * Merging an existing value with a new one
     */
    mergeItem: (key, change, replaceNullPatches) =>
        tryOrDegradePerformance(() => {
            const promise = provider.mergeItem(key, change, replaceNullPatches);

            if (shouldKeepInstancesSync) {
                return promise.then(() => InstanceSync.mergeItem(key));
            }

            return promise;
        }),

    /**
     * Multiple merging of existing and new values in a batch
     * This function also removes all nested null values from an object.
     */
    multiMerge: (pairs) =>
        tryOrDegradePerformance(() => {
            const promise = provider.multiMerge(pairs);

            if (shouldKeepInstancesSync) {
                return promise.then(() => InstanceSync.multiMerge(pairs.map((pair) => pair[0])));
            }

            return promise;
        }),

    /**
     * Removes given key and its value
     */
    removeItem: (key) =>
        tryOrDegradePerformance(() => {
            const promise = provider.removeItem(key);

            if (shouldKeepInstancesSync) {
                return promise.then(() => InstanceSync.removeItem(key));
            }

            return promise;
        }),

    /**
     * Remove given keys and their values
     */
    removeItems: (keys) =>
        tryOrDegradePerformance(() => {
            const promise = provider.removeItems(keys);

            if (shouldKeepInstancesSync) {
                return promise.then(() => InstanceSync.removeItems(keys));
            }

            return promise;
        }),

    /**
     * Clears everything
     */
    clear: () =>
        tryOrDegradePerformance(() => {
            if (shouldKeepInstancesSync) {
                return InstanceSync.clear(() => provider.clear());
            }

            return provider.clear();
        }),

    /**
     * Returns all available keys
     */
    getAllKeys: () => tryOrDegradePerformance(() => provider.getAllKeys()),

    /**
     * Returns all key-value pairs from storage in a single batch operation
     */
    getAll: () => tryOrDegradePerformance(() => provider.getAll()),

    /**
     * Gets all key-value pairs whose key starts with the given prefix (one lazy-collection
     * hydration read). Falls back to getAllKeys + multiGet for providers without a native
     * prefix-range implementation.
     */
    getByPrefix: (prefix: OnyxKey) =>
        tryOrDegradePerformance(() => {
            if (provider.getByPrefix) {
                return provider.getByPrefix(prefix);
            }
            return provider.getAllKeys().then((keys) => {
                const matchingKeys = keys.filter((key) => key.startsWith(prefix));
                if (matchingKeys.length === 0) {
                    return [];
                }
                return provider.multiGet(matchingKeys);
            });
        }),

    /**
     * Gets the total bytes of the store
     */
    getDatabaseSize: () => tryOrDegradePerformance(() => provider.getDatabaseSize()),

    /**
     * @param onStorageKeyChanged - Storage synchronization mechanism keeping all opened tabs in sync (web only)
     */
    keepInstancesSync(onStorageKeyChanged) {
        // If InstanceSync shouldn't be used, it means we're on a native platform and we don't need to keep instances in sync
        if (!InstanceSync.shouldBeUsed) return;

        shouldKeepInstancesSync = true;
        InstanceSync.init(onStorageKeyChanged, this);
    },
};

export default storage;
