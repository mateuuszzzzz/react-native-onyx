type MigrationResult = {
  /**
   * - `noop`: no plaintext database was found on disk, nothing to migrate.
   * - `migrated`: the plaintext database's rows were copied into the encrypted database.
   * - `cleaned-up`: a previous run already committed the migration, but the plaintext file
   *   was not deleted yet (e.g. a crash between commit and file removal); it has now been removed.
   */
  status: "noop" | "migrated" | "cleaned-up";

  /** Wall-clock duration of the migration call, in milliseconds. */
  durationMs: number;
};

type MigrateSQLiteStorageToEncryptedOptions = {
  /** Identifier of the SQLCipher encryption key to use for the encrypted database. */
  keyId: string;
};

type MigrateSQLiteStorageToEncrypted = (
  options: MigrateSQLiteStorageToEncryptedOptions,
) => MigrationResult;

export type {
  MigrationResult,
  MigrateSQLiteStorageToEncryptedOptions,
  MigrateSQLiteStorageToEncrypted,
};
