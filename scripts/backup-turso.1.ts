import fs from "node:fs/promises";
import path from "node:path";
import { turso } from "../src/lib/turso";

function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `X'${hex}'`;
  }
  const str = String(value).replace(/'/g, "''");
  return `'${str}'`;
}

function makeIdempotentDdl(type: string, sqlText: string): string {
  const trimmed = sqlText.trim();
  if (type === "table") {
    return trimmed.replace(
      /^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i,
      "CREATE TABLE IF NOT EXISTS ",
    );
  }
  if (type === "index") {
    return trimmed.replace(
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i,
      (_, unique) => `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS `,
    );
  }
  if (type === "trigger") {
    return trimmed.replace(
      /^CREATE\s+TRIGGER\s+(?!IF\s+NOT\s+EXISTS\b)/i,
      "CREATE TRIGGER IF NOT EXISTS ",
    );
  }
  return trimmed;
}

async function runBackup(): Promise<void> {
  const outDir = path.resolve(process.argv[2] || "./backups/turso");
  await fs.mkdir(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `backup-${timestamp}.sql`);

  // Получаем таблицы и индексы/триггеры (исключаем внутренние служебные таблицы SQLite/FTS)
  const objectsRes = await turso.execute(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '%_fts%'
    ORDER BY
      CASE type
        WHEN 'table' THEN 1
        WHEN 'index' THEN 2
        WHEN 'trigger' THEN 3
        ELSE 4
      END,
      name;
  `);

  const lines: string[] = [
    `-- Turso logical backup generated at ${new Date().toISOString()}`,
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    "",
  ];

  for (const row of objectsRes.rows as any[]) {
    if (row.type === "table" && row.sql) {
      lines.push(`${makeIdempotentDdl("table", String(row.sql))};`);
      lines.push("");

      const tableName = String(row.name);
      const dataRes = await turso.execute(`SELECT * FROM "${tableName.replace(/"/g, '""')}";`);

      if (dataRes.rows.length > 0) {
        const columns = dataRes.columns;
        const colList = columns.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(", ");

        for (const dataRow of dataRes.rows as any[]) {
          const vals = columns.map((c) => escapeSqlValue(dataRow[c])).join(", ");
          lines.push(`INSERT INTO "${tableName.replace(/"/g, '""')}" (${colList}) VALUES (${vals});`);
        }
        lines.push("");
      }
    }
  }

  for (const row of objectsRes.rows as any[]) {
    if ((row.type === "index" || row.type === "trigger") && row.sql) {
      lines.push(`${makeIdempotentDdl(String(row.type), String(row.sql))};`);
    }
  }

  lines.push("");
  lines.push("COMMIT;");
  lines.push("PRAGMA foreign_keys=ON;");
  lines.push("");
  lines.push("-- После импорта при необходимости пересоберите полнотекстовый индекс:");
  lines.push("-- INSERT INTO posts_fts(posts_fts) VALUES('rebuild');");

  await fs.writeFile(outFile, lines.join("\n"), "utf-8");
  console.log(`Бэкап сохранён: ${outFile}`);
}

runBackup().catch((err) => {
  console.error("Ошибка при создании бэкапа Turso:", err);
  process.exit(1);
});
