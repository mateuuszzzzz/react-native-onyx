/** Name of the plaintext database (used when encryption is not configured). */
const SQLITE_PLAINTEXT_DB_NAME = 'OnyxDB';

/** Name of the SQLCipher-encrypted database (used when encryption is configured). */
const SQLITE_ENCRYPTED_DB_NAME = 'OnyxDBEncrypted';

const SQLITE_CREATE_TABLE_QUERY = 'CREATE TABLE IF NOT EXISTS keyvaluepairs (record_key TEXT NOT NULL PRIMARY KEY , valueJSON JSON NOT NULL) WITHOUT ROWID;';

/** `PRAGMA user_version` value marking that the plaintext -> encrypted migration has completed. */
const SQLITE_STORAGE_VERSION_MIGRATED = 1;

export {SQLITE_PLAINTEXT_DB_NAME, SQLITE_ENCRYPTED_DB_NAME, SQLITE_CREATE_TABLE_QUERY, SQLITE_STORAGE_VERSION_MIGRATED};
