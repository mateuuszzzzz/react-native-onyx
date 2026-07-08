/**
 * The SQLiteStorage provider stores everything in a key/value store by
 * converting the value to a JSON string
 */
import type {BatchQueryCommand, NitroSQLiteConnection} from 'react-native-nitro-sqlite';
import {databaseExists, NitroSQLite, open} from 'react-native-nitro-sqlite';
import {getFreeDiskStorage} from 'react-native-device-info';
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
 * Name of the legacy, unencrypted database. Only ever used as a migration
 * source: if this file exists on disk, its contents are copied into the
 * encrypted database once, and the file is deleted afterwards.
 */
const LEGACY_DB_NAME = 'OnyxDB';

/**
 * Name of the encrypted (SQLCipher) database. This is the only database the
 * provider works with; the name is versioned separately from the legacy one so
 * that the migration never needs to move/rename database files.
 */
const DB_NAME = 'OnyxDBEncrypted';

/**
 * Identifier of the SQLCipher encryption key for OnyxDB. The key material
 * itself never passes through JavaScript: react-native-nitro-sqlite resolves
 * (and on first use generates) the actual 32-byte key in the native layer,
 * stored in the iOS Keychain / Android Keystore-backed storage.
 *
 * NOTE: Encryption requires react-native-nitro-sqlite to be built with
 * SQLCipher support (NITRO_SQLITE_SQLCIPHER=1 on iOS, nitroSqliteSqlcipher=true
 * on Android).
 */
const DB_KEY_ID = 'onyx-db';

/**
 * Value of `PRAGMA user_version` in the encrypted database marking that the
 * legacy database migration has completed. `user_version` is a 4-byte integer
 * stored in the SQLite file header, fully reserved for the application, and
 * writes to it are transactional — which makes it a crash-safe migration
 * marker when set inside the same transaction that copies the data (the same
 * pattern Android's SQLiteOpenHelper/Signal use for schema versioning).
 *
 * `0` (the default of any fresh database) means the migration transaction has
 * never committed; `>= 1` guarantees all legacy data is present.
 */
const STORAGE_VERSION_MIGRATED = 1;

const CREATE_TABLE_QUERY = 'CREATE TABLE IF NOT EXISTS keyvaluepairs (record_key TEXT NOT NULL PRIMARY KEY , valueJSON JSON NOT NULL) WITHOUT ROWID;';

type UserVersionResult = {
    user_version: number;
};

/**
 * One-time, idempotent, crash-safe migration of the legacy plaintext database
 * into the encrypted one. Safe to call on every startup, BEFORE the provider
 * starts using the encrypted database:
 *
 *  - no legacy database on disk -> no-op (fresh install or already cleaned up)
 *  - legacy exists, `user_version` of the target is 0 -> copy all rows and the
 *    completion marker in ONE transaction (a crash at any point rolls back to
 *    a clean "not migrated" state and the copy restarts on next launch)
 *  - legacy exists, `user_version` >= 1 -> the migration transaction committed
 *    earlier but the legacy file was not deleted yet (crash in between) ->
 *    just delete it
 *
 * The legacy database is never modified, only read and finally deleted.
 */
function migrateLegacyDatabase(targetDb: NitroSQLiteConnection) {
    if (!databaseExists(LEGACY_DB_NAME)) {
        return;
    }

    const userVersion = targetDb.execute<UserVersionResult>('PRAGMA user_version;').rows?.item(0)?.user_version ?? 0;

    if (userVersion < STORAGE_VERSION_MIGRATED) {
        // The legacy database is plaintext, so it must be attached with an
        // explicit empty key — otherwise it would inherit the encrypted
        // connection's key and fail to open.
        targetDb.attach(LEGACY_DB_NAME, 'legacy', undefined, true);
        try {
            // Guard against a legacy file without the expected table (e.g. a
            // file created but never initialized) — there is nothing to copy
            // then, but the migration should still complete and clean up.
            const hasLegacyTable = (targetDb.execute("SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = 'keyvaluepairs';").rows?.length ?? 0) > 0;

            targetDb.execute('BEGIN;');
            if (hasLegacyTable) {
                targetDb.execute('INSERT OR IGNORE INTO keyvaluepairs SELECT * FROM legacy.keyvaluepairs;');
            }
            targetDb.execute(`PRAGMA user_version = ${STORAGE_VERSION_MIGRATED};`);
            targetDb.execute('COMMIT;');
        } catch (error) {
            targetDb.execute('ROLLBACK;');
            throw error;
        } finally {
            targetDb.detach('legacy');
        }
    }

    // Reaching this point guarantees all legacy data is committed into the
    // encrypted database (either just now or in a previous run), so the
    // plaintext file can be safely removed.
    NitroSQLite.drop(LEGACY_DB_NAME);
}

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
     * Initializes the storage provider
     */
    init() {
        provider.store = open({name: DB_NAME, keyId: DB_KEY_ID});

        provider.store.execute(CREATE_TABLE_QUERY);

        migrateLegacyDatabase(provider.store);

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
