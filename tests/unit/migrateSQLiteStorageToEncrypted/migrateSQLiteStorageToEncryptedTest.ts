/**
 * Tests for the one-time legacy (plaintext) -> encrypted database migration
 * performed by `migrateSQLiteStorageToEncrypted`.
 *
 * Uses the file-backed better-sqlite3 mock so ATTACH DATABASE and on-disk
 * existence checks behave like the real engine. Encryption itself is not
 * exercised here (the mock engine has no SQLCipher codec) — these tests verify
 * the migration STATE MACHINE: data copy, marker semantics, idempotency,
 * crash-state recovery and legacy cleanup.
 */
import migrateSQLiteStorageToEncrypted from '../../../lib/migrateSQLiteStorageToEncrypted/index.native';
// eslint-disable-next-line no-restricted-syntax
import * as SQLiteMock from '../mocks/sqliteMock';

jest.mock('react-native-nitro-sqlite', () => require('../mocks/sqliteMock'));

const LEGACY_DB_NAME = 'OnyxDB';
const ENCRYPTED_DB_NAME = 'OnyxDBEncrypted';
const CREATE_TABLE_QUERY = 'CREATE TABLE IF NOT EXISTS keyvaluepairs (record_key TEXT NOT NULL PRIMARY KEY , valueJSON JSON NOT NULL) WITHOUT ROWID;';
const KEY_ID = 'test-key';

/**
 * Creates a legacy plaintext database with the given key-value rows, exactly
 * like an old app version would have left it, and closes it.
 */
function seedLegacyDatabase(entries: Array<[string, string]>) {
    const legacy = SQLiteMock.open({name: LEGACY_DB_NAME});
    legacy.execute(CREATE_TABLE_QUERY);
    for (const [key, valueJSON] of entries) {
        legacy.execute('INSERT INTO keyvaluepairs VALUES (?, ?)', [key, valueJSON]);
    }
    legacy.close();
}

function readAll(): Record<string, string> {
    const database = SQLiteMock.open({name: ENCRYPTED_DB_NAME});
    const rows = database.execute<{record_key: string; valueJSON: string}>('SELECT record_key, valueJSON FROM keyvaluepairs').rows?._array ?? [];
    const result: Record<string, string> = {};
    for (const row of rows) {
        result[row.record_key] = row.valueJSON;
    }
    database.close();
    return result;
}

function getUserVersion(): number {
    const database = SQLiteMock.open({name: ENCRYPTED_DB_NAME});
    const userVersion = database.execute<{user_version: number}>('PRAGMA user_version;').rows?.item(0)?.user_version ?? 0;
    database.close();
    return userVersion;
}

describe('migrateSQLiteStorageToEncrypted', () => {
    beforeEach(() => {
        SQLiteMock.resetAllDatabases();
    });

    afterAll(() => {
        SQLiteMock.resetAllDatabases();
    });

    it('fresh install: no legacy database -> no-op', () => {
        const result = migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        expect(result.status).toBe('noop');
        expect(SQLiteMock.databaseExists(LEGACY_DB_NAME)).toBe(false);
    });

    it('copies all legacy data into the encrypted database and deletes the legacy file', () => {
        seedLegacyDatabase([
            ['user_1', '"Alice"'],
            ['session', '{"token":"abc"}'],
        ]);

        const result = migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        expect(result.status).toBe('migrated');
        expect(readAll()).toEqual({
            user_1: '"Alice"',
            session: '{"token":"abc"}',
        });
        expect(getUserVersion()).toBeGreaterThanOrEqual(1);
        expect(SQLiteMock.databaseExists(LEGACY_DB_NAME)).toBe(false);
    });

    it('is idempotent: calling it again after a completed migration is a no-op that does not disturb new data', () => {
        seedLegacyDatabase([['k', '"v"']]);

        migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        const database = SQLiteMock.open({name: ENCRYPTED_DB_NAME});
        database.execute('INSERT INTO keyvaluepairs VALUES (?, ?)', ['newKey', '{"written":"afterMigration"}']);
        database.close();

        const result = migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        expect(result.status).toBe('noop');
        expect(readAll()).toEqual({
            k: '"v"',
            newKey: '{"written":"afterMigration"}',
        });
    });

    it('crash state: encrypted db exists with user_version=0 -> migration restarts from scratch', () => {
        seedLegacyDatabase([['k1', '"v1"']]);

        // Simulate a crash mid-migration: the encrypted database file was
        // created (schema committed), but the copy transaction rolled back —
        // no data, user_version still 0.
        const target = SQLiteMock.open({name: ENCRYPTED_DB_NAME});
        target.execute(CREATE_TABLE_QUERY);
        target.close();

        const result = migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        expect(result.status).toBe('migrated');
        expect(readAll()).toEqual({k1: '"v1"'});
        expect(getUserVersion()).toBeGreaterThanOrEqual(1);
        expect(SQLiteMock.databaseExists(LEGACY_DB_NAME)).toBe(false);
    });

    it('crash state: migration committed (user_version=1) but legacy not deleted -> only cleans up, does not re-copy', () => {
        // Fully migrated encrypted database...
        const target = SQLiteMock.open({name: ENCRYPTED_DB_NAME});
        target.execute(CREATE_TABLE_QUERY);
        target.execute('INSERT INTO keyvaluepairs VALUES (?, ?)', ['k', '"migratedValue"']);
        target.execute('PRAGMA user_version = 1;');
        target.close();

        // ...the app then deleted key `stale` (post-migration write activity),
        // while a stale legacy file still contains it. A re-copy would
        // resurrect it — cleanup-only must not.
        seedLegacyDatabase([
            ['k', '"legacyOldValue"'],
            ['stale', '"shouldNotComeBack"'],
        ]);

        const result = migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        expect(result.status).toBe('cleaned-up');
        expect(readAll()).toEqual({k: '"migratedValue"'});
        expect(SQLiteMock.databaseExists(LEGACY_DB_NAME)).toBe(false);
    });

    it('legacy file without the keyvaluepairs table -> completes migration and cleans up', () => {
        // e.g. a legacy database file that was created but never initialized.
        const legacy = SQLiteMock.open({name: LEGACY_DB_NAME});
        legacy.execute('PRAGMA user_version = 0;');
        legacy.close();

        const result = migrateSQLiteStorageToEncrypted({keyId: KEY_ID});

        expect(result.status).toBe('migrated');
        expect(getUserVersion()).toBeGreaterThanOrEqual(1);
        expect(SQLiteMock.databaseExists(LEGACY_DB_NAME)).toBe(false);
    });
});
