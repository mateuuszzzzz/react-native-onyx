import {databaseExists, NitroSQLite, open} from 'react-native-nitro-sqlite';
import {SQLITE_CREATE_TABLE_QUERY, SQLITE_ENCRYPTED_DB_NAME, SQLITE_PLAINTEXT_DB_NAME, SQLITE_STORAGE_VERSION_MIGRATED} from '../storage/providers/SQLiteConstants';
import type {MigrateSQLiteStorageToEncrypted, MigrationResult} from './types';

type UserVersionResult = {
    user_version: number;
};

/**
 * One-time migration of the plaintext SQLite database into the encrypted one.
 *
 * Idempotent and crash-safe: data and the completion marker (`PRAGMA
 * user_version`) are committed in a single transaction, so an interrupted
 * migration rolls back and restarts on the next call. The plaintext database
 * is only read, and deleted once the marker is committed.
 *
 * Must be called BEFORE `Onyx.init()` whenever encryption is enabled there.
 */
const migrateSQLiteStorageToEncrypted: MigrateSQLiteStorageToEncrypted = ({keyId}): MigrationResult => {
    const startTime = Date.now();

    if (!databaseExists(SQLITE_PLAINTEXT_DB_NAME)) {
        return {status: 'noop', durationMs: Date.now() - startTime};
    }

    const targetDb = open({name: SQLITE_ENCRYPTED_DB_NAME, keyId});
    let status: MigrationResult['status'] = 'cleaned-up';

    try {
        targetDb.execute(SQLITE_CREATE_TABLE_QUERY);

        const userVersion = targetDb.execute<UserVersionResult>('PRAGMA user_version;').rows?.item(0)?.user_version ?? 0;

        if (userVersion < SQLITE_STORAGE_VERSION_MIGRATED) {
            // The plaintext source must be attached with an explicit empty key,
            // otherwise it would inherit the encrypted connection's key.
            targetDb.attach(SQLITE_PLAINTEXT_DB_NAME, 'legacy', undefined, true);
            try {
                const hasLegacyTable = (targetDb.execute("SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = 'keyvaluepairs';").rows?.length ?? 0) > 0;

                targetDb.execute('BEGIN;');
                if (hasLegacyTable) {
                    targetDb.execute('INSERT OR IGNORE INTO keyvaluepairs SELECT * FROM legacy.keyvaluepairs;');
                }
                targetDb.execute(`PRAGMA user_version = ${SQLITE_STORAGE_VERSION_MIGRATED};`);
                targetDb.execute('COMMIT;');
                status = 'migrated';
            } catch (error) {
                targetDb.execute('ROLLBACK;');
                throw error;
            } finally {
                targetDb.detach('legacy');
            }
        }
    } finally {
        targetDb.close();
    }

    // Marker is committed at this point, so the plaintext file can go.
    // NOTE: `NitroSQLite.drop` is undefined — `NitroSQLite` is built via `{...HybridNitroSQLite}`,
    // and object spread only copies own properties, not the HybridObject's prototype methods.
    // `.native` keeps the original, unspread reference where `drop` actually exists.
    NitroSQLite.native.drop(SQLITE_PLAINTEXT_DB_NAME);

    return {status, durationMs: Date.now() - startTime};
};

export default migrateSQLiteStorageToEncrypted;
