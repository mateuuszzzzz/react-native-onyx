/**
 * The SQLiteStorage provider stores everything in a key/value store by
 * converting the value to a JSON string
 */
import type {BatchQueryCommand, NitroSQLiteConnection} from 'react-native-nitro-sqlite';
import {open} from 'react-native-nitro-sqlite';
import {getFreeDiskStorage} from 'react-native-device-info';
import {SQLITE_CREATE_TABLE_QUERY, SQLITE_ENCRYPTED_DB_NAME, SQLITE_PLAINTEXT_DB_NAME} from './SQLiteConstants';
import type {FastMergeReplaceNullPatch} from '../../utils';
import utils from '../../utils';
import type StorageProvider from './types';
import type {StorageKeyList, StorageKeyValuePair} from './types';
import classifySQLiteError from './classifySQLiteError';

/**
 * The type of the key-value pair stored in the SQLite database
 * @property record_key - the key of the record
 * @property valueJSON - the value of the record in JSON string format
 */
type OnyxSQLiteKeyValuePair = {
    record_key: string;
    valueJSON: string;
};

/**
 * The result of the `PRAGMA page_size`, which gets the page size of the SQLite database
 */
type PageSizeResult = {
    page_size: number;
};

/**
 * The result of the `PRAGMA page_count`, which gets the page count of the SQLite database
 */
type PageCountResult = {
    page_count: number;
};

/**
 * Prevents the stringifying of the object markers.
 */
function objectMarkRemover(key: string, value: unknown) {
    if (key === utils.ONYX_INTERNALS__REPLACE_OBJECT_MARK) return undefined;
    return value;
}

/**
 * Transforms the replace null patches into SQL queries to be passed to JSON_REPLACE.
 */
function generateJSONReplaceSQLQueries(key: string, patches: FastMergeReplaceNullPatch[]): string[][] {
    const queries = patches.map(([pathArray, value]) => {
        const jsonPath = `$.${pathArray.join('.')}`;
        return [jsonPath, JSON.stringify(value), key];
    });

    return queries;
}

const provider: StorageProvider<NitroSQLiteConnection | undefined> = {
    store: undefined,

    /**
     * The name of the provider that can be printed to the logs
     */
    name: 'SQLiteProvider',
    /**
     * Classifies a SQLite write failure into the shared storage taxonomy.
     */
    classifyError: classifySQLiteError,
    /**
     * Initializes the storage provider by connecting to the appropriate database.
     * Passing a `keyId` connects to the encrypted (SQLCipher) database using that key;
     * omitting it connects to the plaintext database. This method never migrates data —
     * see `migrateSQLiteStorageToEncrypted` for moving an existing plaintext database
     * to the encrypted one.
     */
    init(keyId) {
        provider.store = keyId ? open({name: SQLITE_ENCRYPTED_DB_NAME, keyId}) : open({name: SQLITE_PLAINTEXT_DB_NAME});

        provider.store.execute(SQLITE_CREATE_TABLE_QUERY);

        // All of the 3 pragmas below were suggested by SQLite team.
        // You can find more info about them here: https://www.sqlite.org/pragma.html
        provider.store.execute('PRAGMA CACHE_SIZE=-20000;');
        provider.store.execute('PRAGMA synchronous=NORMAL;');
        provider.store.execute('PRAGMA journal_mode=WAL;');
    },
    getItem(key) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return provider.store.executeAsync<OnyxSQLiteKeyValuePair>('SELECT record_key, valueJSON FROM keyvaluepairs WHERE record_key = ?;', [key]).then(({rows}) => {
            if (!rows || rows?.length === 0) {
                return null;
            }
            const result = rows?.item(0);

            if (result == null) {
                return null;
            }

            return JSON.parse(result.valueJSON);
        });
    },
    multiGet(keys) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        const placeholders = keys.map(() => '?').join(',');
        const command = `SELECT record_key, valueJSON FROM keyvaluepairs WHERE record_key IN (${placeholders});`;
        return provider.store.executeAsync<OnyxSQLiteKeyValuePair>(command, keys).then(({rows}) => {
            // eslint-disable-next-line no-underscore-dangle
            const result = rows?._array.map((row) => [row.record_key, JSON.parse(row.valueJSON)]);
            return (result ?? []) as StorageKeyValuePair[];
        });
    },
    setItem(key, value) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return provider.store.executeAsync('REPLACE INTO keyvaluepairs (record_key, valueJSON) VALUES (?, ?);', [key, JSON.stringify(value)]).then(() => undefined);
    },
    multiSet(pairs) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        const query = 'REPLACE INTO keyvaluepairs (record_key, valueJSON) VALUES (?, ?);';
        const params = pairs.map((pair) => [pair[0], JSON.stringify(pair[1] === undefined ? null : pair[1])]);
        if (utils.isEmptyObject(params)) {
            return Promise.resolve();
        }
        return provider.store.executeBatchAsync([{query, params}]).then(() => undefined);
    },
    multiMerge(pairs) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        const commands: BatchQueryCommand[] = [];

        // Query to merge the change into the DB value.
        const patchQuery = `INSERT INTO keyvaluepairs (record_key, valueJSON)
            VALUES (:key, :value)
            ON CONFLICT DO UPDATE
            SET valueJSON = JSON_PATCH(valueJSON, :value);
        `;
        const patchQueryArguments: string[][] = [];

        // Query to fully replace the nested objects of the DB value.
        // NOTE: The JSON() wrapper around the replacement value is required here. Unlike JSON_PATCH (which
        // parses both arguments as JSON internally), JSON_REPLACE treats a plain TEXT binding as a quoted
        // JSON string. Without JSON(), objects would be stored as string values (e.g. "{...}") instead of
        // actual JSON objects, corrupting the stored data.
        const replaceQuery = `UPDATE keyvaluepairs
            SET valueJSON = JSON_REPLACE(valueJSON, ?, JSON(?))
            WHERE record_key = ?;
        `;
        const replaceQueryArguments: string[][] = [];

        const nonNullishPairs = pairs.filter((pair) => pair[1] !== undefined);

        for (const [key, value, replaceNullPatches] of nonNullishPairs) {
            const changeWithoutMarkers = JSON.stringify(value, objectMarkRemover);
            patchQueryArguments.push([key, changeWithoutMarkers]);

            const patches = replaceNullPatches ?? [];
            if (patches.length > 0) {
                const queries = generateJSONReplaceSQLQueries(key, patches);

                if (queries.length > 0) {
                    replaceQueryArguments.push(...queries);
                }
            }
        }

        commands.push({query: patchQuery, params: patchQueryArguments});
        if (replaceQueryArguments.length > 0) {
            commands.push({query: replaceQuery, params: replaceQueryArguments});
        }

        return provider.store.executeBatchAsync(commands).then(() => undefined);
    },
    mergeItem(key, change, replaceNullPatches) {
        // Since Onyx already merged the existing value with the changes, we can just set the value directly.
        return provider.multiMerge([[key, change, replaceNullPatches]]);
    },
    getAllKeys() {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return provider.store.executeAsync('SELECT record_key FROM keyvaluepairs;').then(({rows}) => {
            // eslint-disable-next-line no-underscore-dangle
            const result = rows?._array.map((row) => row.record_key);
            return (result ?? []) as StorageKeyList;
        });
    },
    getAll() {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return provider.store.executeAsync<OnyxSQLiteKeyValuePair>('SELECT record_key, valueJSON FROM keyvaluepairs;').then(({rows}) => {
            // eslint-disable-next-line no-underscore-dangle
            const result = rows?._array.map((row) => [row.record_key, JSON.parse(row.valueJSON)]);
            return (result ?? []) as StorageKeyValuePair[];
        });
    },
    removeItem(key) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return provider.store.executeAsync('DELETE FROM keyvaluepairs WHERE record_key = ?;', [key]).then(() => undefined);
    },
    removeItems(keys) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        const placeholders = keys.map(() => '?').join(',');
        const query = `DELETE FROM keyvaluepairs WHERE record_key IN (${placeholders});`;
        return provider.store.executeAsync(query, keys).then(() => undefined);
    },
    clear() {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return provider.store.executeAsync('DELETE FROM keyvaluepairs;', []).then(() => undefined);
    },
    getDatabaseSize() {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        return Promise.all([provider.store.executeAsync<PageSizeResult>('PRAGMA page_size;'), provider.store.executeAsync<PageCountResult>('PRAGMA page_count;'), getFreeDiskStorage()]).then(
            ([pageSizeResult, pageCountResult, bytesRemaining]) => {
                const pageSize = pageSizeResult.rows?.item(0)?.page_size ?? 0;
                const pageCount = pageCountResult.rows?.item(0)?.page_count ?? 0;
                return {
                    bytesUsed: pageSize * pageCount,
                    bytesRemaining,
                };
            },
        );
    },
};

export default provider;
export type {OnyxSQLiteKeyValuePair};
