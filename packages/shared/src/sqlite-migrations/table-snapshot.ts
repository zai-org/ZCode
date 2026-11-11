import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MigrationBackup, MigrationBackupTable } from "./contract.js";

type TableColumns = Pick<MigrationBackupTable, "name" | "columns">;
const HASH_PREFIX = "sqlite-table-v2\0";

export function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return `"${value}"`;
}

export function describeTable(db: DatabaseSync, name: string): TableColumns {
  const columns = (
    db.prepare(`pragma table_info(${identifier(name)})`).all() as { name: string }[]
  ).map((row) => row.name);
  return { name, columns };
}

function* readRows(db: DatabaseSync, table: TableColumns): Generator<SQLInputValue[]> {
  if (!table.columns.length) return;
  const statement = db.prepare(
    `select ${table.columns.map(identifier).join(",")} from ${identifier(table.name)}`,
  );
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) yield table.columns.map((column) => row[column]!);
}

function prepareInsert(db: DatabaseSync, table: TableColumns) {
  return db.prepare(
    `insert into ${identifier(table.name)} (${table.columns.map(identifier).join(",")}) values (${table.columns.map(() => "?").join(",")})`,
  );
}

export function estimateTableBytes(db: DatabaseSync, table: TableColumns): number {
  let bytes = 0;
  for (const row of readRows(db, table))
    for (const value of row)
      bytes +=
        (value instanceof Uint8Array ? value.byteLength : Buffer.byteLength(String(value))) + 32;
  return bytes;
}

function encodeRow(row: SQLInputValue[]): string {
  return JSON.stringify(row, (_key, value: unknown) => {
    if (typeof value === "bigint") return { integer: value.toString() };
    if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
    return value;
  });
}

/** 校验时可同时复制一行；原库快照和备份连接的事务由调用方持有。 */
export function hashTable(
  db: DatabaseSync,
  table: TableColumns,
  version: MigrationBackup["version"],
  target?: DatabaseSync,
): MigrationBackupTable {
  // Bug：整表数组和整体 JSON 会分别耗尽堆、超过字符串上限。临时库只保留排序材料，JS 只持有单行。
  // 空路径是 SQLite 自动清理的临时文件库；限制页缓存，排序允许落盘，不能换成 :memory:。
  const sorter = new DatabaseSync("");
  try {
    sorter.exec(
      "pragma temp_store=FILE; pragma cache_size=-2048; create table rows(sort_key blob, encoded text); begin",
    );
    const record = sorter.prepare("insert into rows values (?, ?)");
    const insert = target && table.columns.length ? prepareInsert(target, table) : undefined;
    let rows = 0;
    for (const row of readRows(db, table)) {
      insert?.run(...row);
      const encoded = encodeRow(row);
      if (version === 1) {
        // 旧版 Array.sort 按 UTF-16 码元排序，SQLite UTF-8 文本排序在补充平面字符上不等价。
        record.run(Buffer.from(encoded, "utf16le").swap16(), encoded);
      } else record.run(createHash("sha256").update(encoded).digest(), null);
      rows++;
    }
    sorter.exec("commit");
    const hash = createHash("sha256").update(version === 1 ? "[" : HASH_PREFIX);
    let first = true;
    for (const row of sorter
      .prepare("select sort_key, encoded from rows order by sort_key")
      .iterate()) {
      if (version === 1) {
        if (!first) hash.update(",");
        hash.update(JSON.stringify(row.encoded));
      } else hash.update(row.sort_key as Uint8Array);
      first = false;
    }
    if (version === 1) hash.update("]");
    return { ...table, rows, hash: hash.digest("hex") };
  } finally {
    sorter.close();
  }
}

export function copyTable(source: DatabaseSync, target: DatabaseSync, table: TableColumns): void {
  if (!table.columns.length) return;
  const insert = prepareInsert(target, table);
  for (const row of readRows(source, table)) insert.run(...row);
}
