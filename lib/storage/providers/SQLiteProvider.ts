/**
 * The SQLiteStorage provider stores everything in a key/value store by
 * converting the value to a JSON string
 */
import type {BatchQueryCommand, NitroSQLiteConnection, QueryResult} from 'react-native-nitro-sqlite';

import {getFreeDiskStorage} from 'react-native-device-info';
import {open} from 'react-native-nitro-sqlite';

import type {FastMergeReplaceNullPatch} from '../../utils';
import type StorageProvider from './types';
import type {StorageCollectionQuery, StorageKeyList, StorageKeyValuePair} from './types';

import utils from '../../utils';
import classifySQLiteError from './classifySQLiteError';

/**
 * The result of the `PRAGMA compile_options`, which lists SQLite compile-time options
 */
type CompileOptionsResult = {
    compile_options: string;
};

/** Escapes a string for embedding as a single-quoted SQLite literal. */
function escapeSQLiteStringLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/** Namespace prefix of every index Onyx manages — reconciliation only ever touches these. */
const ONYX_INDEX_PREFIX = 'onyx_idx_';

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

const DB_NAME = 'OnyxDB';
const SQLITE_MAX_VARIABLE_NUMBER = 32766;
const COMPILE_OPTIONS = {
    MAX_VARIABLE_NUMBER: 'MAX_VARIABLE_NUMBER',
} as const;

/** SQLite's maximum number of bound parameters per statement, read once from PRAGMA compile_options in init(). */
let sqliteMaxVariableNumber = SQLITE_MAX_VARIABLE_NUMBER;

/**
 * Returns the value of a compile option from the rows returned by `PRAGMA compile_options`.
 * For flag-only options (e.g. `ENABLE_FTS3`), returns an empty string when the option is present.
 */
function getCompileOptionValue(compileOptionsResult: QueryResult<CompileOptionsResult>, optionName: string): string | undefined {
    const optionPrefix = `${optionName}=`;
    const rowCount = compileOptionsResult.rows?.length ?? 0;

    for (let index = 0; index < rowCount; index++) {
        const compileOption = compileOptionsResult.rows?.item(index)?.compile_options;

        if (!compileOption) {
            continue;
        }

        if (compileOption === optionName) {
            return '';
        }

        if (compileOption.startsWith(optionPrefix)) {
            return compileOption.slice(optionPrefix.length);
        }
    }

    return undefined;
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
        provider.store = open({name: DB_NAME});

        provider.store.execute('CREATE TABLE IF NOT EXISTS keyvaluepairs (record_key TEXT NOT NULL PRIMARY KEY , valueJSON JSON NOT NULL) WITHOUT ROWID;');

        // All of the 3 pragmas below were suggested by SQLite team.
        // You can find more info about them here: https://www.sqlite.org/pragma.html
        provider.store.execute('PRAGMA CACHE_SIZE=-20000;');
        provider.store.execute('PRAGMA synchronous=NORMAL;');
        provider.store.execute('PRAGMA journal_mode=WAL;');

        const compileOptionsResult = provider.store.execute<CompileOptionsResult>('PRAGMA compile_options;');

        // Get the value of MAX_VARIABLE_NUMBER from the compile options and
        // stores it in a global variable, that is going to be used during runtime.
        const maxVariableNumber = Number(getCompileOptionValue(compileOptionsResult, COMPILE_OPTIONS.MAX_VARIABLE_NUMBER));
        sqliteMaxVariableNumber = maxVariableNumber > 0 ? maxVariableNumber : SQLITE_MAX_VARIABLE_NUMBER;
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

        if (keys.length === 0) {
            return Promise.resolve([]);
        }

        const keyChunks = utils.chunkArray(keys, sqliteMaxVariableNumber);

        return Promise.all(
            keyChunks.map((keyChunk) => {
                if (!provider.store) {
                    throw new Error('Store is not initialized!');
                }

                const placeholders = keyChunk.map(() => '?').join(',');
                const command = `SELECT record_key, valueJSON FROM keyvaluepairs WHERE record_key IN (${placeholders});`;
                return provider.store.executeAsync<OnyxSQLiteKeyValuePair>(command, keyChunk);
            }),
        ).then((results) => {
            const result = results.flatMap(
                ({rows}) =>
                    // eslint-disable-next-line no-underscore-dangle
                    rows?._array.map((row) => [row.record_key, JSON.parse(row.valueJSON)]) ?? [],
            );
            return result as StorageKeyValuePair[];
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
        const params = pairs.map(([key, value]) => [key, JSON.stringify(value === undefined ? null : value)]);
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

        // Aggregate the whole table into a single JSON string in SQLite so we only run JSON.parse
        // once, instead of returning every row and parsing each one individually in JavaScript.
        return provider.store
            .executeAsync<{aggregated: string | null}>('SELECT json_group_array(json_array(record_key, json(valueJSON))) AS aggregated FROM keyvaluepairs;')
            .then(({rows}) => {
                const aggregated = rows?.item(0)?.aggregated;
                if (aggregated == null) {
                    return [];
                }
                return JSON.parse(aggregated) as StorageKeyValuePair[];
            });
    },
    getByPrefix(prefix) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        // Half-open key range instead of LIKE: the table is WITHOUT ROWID with record_key as its
        // primary key, so `>= prefix AND < upperBound` is a pure B-tree range scan (LIKE defeats the
        // index under the default case-insensitive collation). The upper bound is the prefix with its
        // last code unit incremented — every key starting with the prefix sorts inside the range.
        const upperBound = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

        // Same single-JSON.parse aggregation as getAll — one parse per hydration, not one per row.
        return provider.store
            .executeAsync<{aggregated: string | null}>(
                'SELECT json_group_array(json_array(record_key, json(valueJSON))) AS aggregated FROM keyvaluepairs WHERE record_key >= ? AND record_key < ?;',
                [prefix, upperBound],
            )
            .then(({rows}) => {
                const aggregated = rows?.item(0)?.aggregated;
                if (aggregated == null) {
                    return [];
                }
                return JSON.parse(aggregated) as StorageKeyValuePair[];
            });
    },
    queryByPrefix(prefix, query) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }

        // Field names are embedded in the generated SQL (values always travel as bound parameters),
        // so they must be plain identifiers. The generated predicates mirror the JS evaluator in
        // OnyxQuery exactly: `IS`/`IS NOT` for null-safe (in)equality, IN extended with an IS NULL
        // arm when the list contains null, and range operators that exclude null fields.
        const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
        const fieldExpression = (field: string): string => {
            if (!IDENTIFIER_PATTERN.test(field)) {
                throw new Error(`queryByPrefix(): invalid field name '${field}'.`);
            }
            return `json_extract(valueJSON, '$.${field}')`;
        };

        // Keyset cursors over a null sort value would need three-armed SQL that is not worth
        // generating — callers fall back to the in-JS path for that page.
        if (query.after && query.after.sortValue === null) {
            return Promise.reject(new Error('queryByPrefix(): null-sort cursors are not supported natively.'));
        }

        // The key-range bounds are inlined as escaped literals instead of bound parameters ON
        // PURPOSE: SQLite only plans a PARTIAL index (our per-collection indexes carry the same
        // range in their WHERE clause) when it can prove the query's constraints imply the index's
        // at prepare time — which it cannot do through parameters.
        const upperBound = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
        const clauses: string[] = [`record_key >= '${escapeSQLiteStringLiteral(prefix)}'`, `record_key < '${escapeSQLiteStringLiteral(upperBound)}'`];
        const params: Array<string | number | boolean | null> = [];

        for (const condition of query.where ?? []) {
            const expression = fieldExpression(condition.field);
            switch (condition.operator) {
                case 'eq':
                    clauses.push(`${expression} IS ?`);
                    params.push(condition.value);
                    break;
                case 'neq':
                    clauses.push(`${expression} IS NOT ?`);
                    params.push(condition.value);
                    break;
                case 'in': {
                    const nonNullValues = condition.value.filter((value) => value !== null);
                    const placeholders = nonNullValues.map(() => '?').join(',');
                    const inClause = nonNullValues.length > 0 ? `${expression} IN (${placeholders})` : '0';
                    clauses.push(condition.value.length > nonNullValues.length ? `(${inClause} OR ${expression} IS NULL)` : `(${inClause})`);
                    params.push(...nonNullValues);
                    break;
                }
                case 'gt':
                case 'gte':
                case 'lt':
                case 'lte': {
                    const operatorSQL = {gt: '>', gte: '>=', lt: '<', lte: '<='}[condition.operator];
                    clauses.push(`${expression} ${operatorSQL} ?`);
                    params.push(condition.value);
                    break;
                }
                default:
                    throw new Error('queryByPrefix(): unsupported operator.');
            }
        }

        const sortExpression = fieldExpression(query.orderBy.field);
        const isAscending = query.orderBy.direction === 'asc';
        if (query.after) {
            if (isAscending) {
                // Nulls sort first ascending, so anything after a non-null cursor is non-null — the
                // strict comparison excludes null sort values naturally.
                clauses.push(`(${sortExpression} > ? OR (${sortExpression} IS ? AND record_key > ?))`);
            } else {
                // Nulls sort last descending — they come after every non-null cursor.
                clauses.push(`(${sortExpression} < ? OR (${sortExpression} IS ? AND record_key < ?) OR ${sortExpression} IS NULL)`);
            }
            params.push(query.after.sortValue, query.after.sortValue, query.after.recordKey);
        }

        const direction = isAscending ? 'ASC' : 'DESC';
        const command = `SELECT json_group_array(json_array(record_key, json(valueJSON))) AS aggregated FROM (
            SELECT record_key, valueJSON FROM keyvaluepairs
            WHERE ${clauses.join(' AND ')}
            ORDER BY ${sortExpression} ${direction}, record_key ${direction}
            LIMIT ?
        );`;
        params.push(query.limit);

        return provider.store.executeAsync<{aggregated: string | null}>(command, params as string[]).then(({rows}) => {
            const aggregated = rows?.item(0)?.aggregated;
            if (aggregated == null) {
                return [];
            }
            return JSON.parse(aggregated) as StorageKeyValuePair[];
        });
    },
    listOnyxIndexes() {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }
        return provider.store.executeAsync<{name: string}>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '${ONYX_INDEX_PREFIX}%';`).then(({rows}) => {
            const names: string[] = [];
            for (let index = 0; index < (rows?.length ?? 0); index++) {
                const name = rows?.item(index)?.name;
                if (name) {
                    names.push(name);
                }
            }
            return names;
        });
    },
    createCollectionIndex(indexName, collectionPrefix, fields) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }
        if (!indexName.startsWith(ONYX_INDEX_PREFIX) || !/^[A-Za-z0-9_]+$/.test(indexName)) {
            return Promise.reject(new Error(`createCollectionIndex(): invalid index name '${indexName}'.`));
        }
        if (fields.length === 0 || fields.some((field) => !/^[A-Za-z0-9_]+$/.test(field))) {
            return Promise.reject(new Error(`createCollectionIndex(): invalid field list [${fields.join(', ')}].`));
        }

        // A PARTIAL expression index scoped to the collection's key range. The range literals here
        // must textually imply the (also literal) range in queryByPrefix, and the indexed expressions
        // must textually match the query's — both are generated from the same inputs, so they do.
        // `record_key` is appended so the query's `ORDER BY <expr> DIR, record_key DIR` tie-break is
        // fully covered by the index (no residual sorter). One index serves asc and desc alike —
        // SQLite walks the B-tree in either direction when all columns share one direction.
        const upperBound = collectionPrefix.slice(0, -1) + String.fromCharCode(collectionPrefix.charCodeAt(collectionPrefix.length - 1) + 1);
        const indexedExpressions = [...fields.map((field) => `json_extract(valueJSON, '$.${field}')`), 'record_key'];
        const command = `CREATE INDEX IF NOT EXISTS ${indexName}
            ON keyvaluepairs (${indexedExpressions.join(', ')})
            WHERE record_key >= '${escapeSQLiteStringLiteral(collectionPrefix)}' AND record_key < '${escapeSQLiteStringLiteral(upperBound)}';`;
        return provider.store.executeAsync(command).then(() => undefined);
    },
    dropIndex(indexName) {
        if (!provider.store) {
            throw new Error('Store is not initialized!');
        }
        if (!indexName.startsWith(ONYX_INDEX_PREFIX) || !/^[A-Za-z0-9_]+$/.test(indexName)) {
            return Promise.reject(new Error(`dropIndex(): refusing to drop non-Onyx-managed index '${indexName}'.`));
        }
        return provider.store.executeAsync(`DROP INDEX IF EXISTS ${indexName};`).then(() => undefined);
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

        if (keys.length === 0) {
            return Promise.resolve();
        }

        const keyChunks = utils.chunkArray(keys, sqliteMaxVariableNumber);

        const buildDeleteQuery = (keyChunk: readonly string[]) => {
            const placeholders = keyChunk.map(() => '?').join(',');
            return `DELETE FROM keyvaluepairs WHERE record_key IN (${placeholders});`;
        };

        if (keyChunks.length === 1) {
            const keyChunk = keyChunks[0];
            return provider.store.executeAsync(buildDeleteQuery(keyChunk), keyChunk).then(() => undefined);
        }

        const commands: BatchQueryCommand[] = keyChunks.map((keyChunk) => ({
            query: buildDeleteQuery(keyChunk),
            params: keyChunk,
        }));

        return provider.store.executeBatchAsync(commands).then(() => undefined);
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
