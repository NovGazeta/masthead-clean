import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { turso } from "../src/lib/turso";

const R2_BACKUP_PREFIX = "backups/turso/";

interface CliOptions {
  sqlFilePath: string;
  latestFromR2: boolean;
  dryRun: boolean;
  skipFtsRebuild: boolean;
  truncateFirst: boolean;
  autoYes: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let latestFromR2 = false;
  let dryRun = false;
  let skipFtsRebuild = false;
  let truncateFirst = false;
  let autoYes = false;

  for (const arg of argv) {
    if (arg === "--latest-r2") {
      latestFromR2 = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-fts") {
      skipFtsRebuild = true;
    } else if (arg === "--truncate") {
      truncateFirst = true;
    } else if (arg === "--yes" || arg === "-y") {
      autoYes = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return {
    sqlFilePath: positional[0] ? path.resolve(positional[0]) : "",
    latestFromR2,
    dryRun,
    skipFtsRebuild,
    truncateFirst,
    autoYes,
  };
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function unquoteIdent(ident: string): string {
  const trimmed = ident.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function createR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error(
      "Заполните R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и R2_BUCKET_NAME в .env для использования --latest-r2",
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

async function streamBodyToString(body: unknown): Promise<string> {
  if (!body) return "";
  if (typeof (body as any).transformToString === "function") {
    return await (body as any).transformToString("utf-8");
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (typeof (body as any)[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk, "utf-8"));
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  throw new Error("Неподдерживаемый формат тела ответа GetObjectCommand");
}

async function downloadLatestBackupFromR2(): Promise<string> {
  const bucketName = process.env.R2_BUCKET_NAME!;
  const s3 = createR2Client();

  console.log(
    `☁️ Поиск последнего бэкапа в R2 (bucket="${bucketName}", prefix="${R2_BACKUP_PREFIX}")...`,
  );

  const candidates: Array<{ key: string; lastModified: number }> = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: R2_BACKUP_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of res.Contents || []) {
      const key = String(obj.Key || "").trim();
      if (!key || key.endsWith("/") || !key.toLowerCase().endsWith(".sql")) {
        continue;
      }
      const lm = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
      candidates.push({ key, lastModified: lm });
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  if (candidates.length === 0) {
    throw new Error(`В R2 по префиксу "${R2_BACKUP_PREFIX}" не найдено ни одного .sql бэкапа.`);
  }

  candidates.sort((a, b) => {
    if (b.lastModified !== a.lastModified) {
      return b.lastModified - a.lastModified;
    }
    return b.key.localeCompare(a.key);
  });

  const latest = candidates[0];
  console.log(
    `📥 Выбран свежий бэкап в R2: ${latest.key}${
      latest.lastModified ? ` (${new Date(latest.lastModified).toISOString()})` : ""
    }`,
  );

  const objRes = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: latest.key,
    }),
  );

  const sqlContent = await streamBodyToString(objRes.Body);
  const localDir = path.resolve("./backups/turso");
  await fs.mkdir(localDir, { recursive: true });

  const baseName = path.basename(latest.key);
  const targetFile = path.join(localDir, `from-r2-${baseName}`);
  await fs.writeFile(targetFile, sqlContent, "utf-8");

  console.log(
    `💾 Бэкап сохранён локально: ${targetFile} (${Buffer.byteLength(sqlContent, "utf-8")} B)`,
  );
  return targetFile;
}

function isIgnorableStandaloneStatement(stmt: string): boolean {
  const normalized = stmt
    .replace(/--[^\n]*\n?/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+$/, "")
    .trim();

  if (!normalized) return true;

  return (
    /^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?$/i.test(normalized) ||
    /^COMMIT(\s+TRANSACTION)?$/i.test(normalized) ||
    /^END(\s+TRANSACTION)?$/i.test(normalized) ||
    /^PRAGMA\s+foreign_keys\s*=\s*(ON|OFF|1|0)$/i.test(normalized)
  );
}

/**
 * Разбивает SQL-скрипт на отдельные операторы по ';' с учётом:
 * - строковых литералов ('...' и экранированных '')
 * - идентификаторов в двойных кавычках ("..." и "") или квадратных скобках [...]
 * - блочных комментариев /* ... *\/ и однострочных -- ...
 * Сохраняет BEGIN ... END внутри триггеров и отбрасывает внешние BEGIN/COMMIT/END/PRAGMA foreign_keys.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBracketIdent = false;
  let inLineComment = false;
  let inBlockComment = false;
  let triggerBlockDepth = 0;

  const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        current += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i++;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"' && next === '"') {
        current += next;
        i++;
      } else if (ch === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inBracketIdent) {
      current += ch;
      if (ch === "]") {
        inBracketIdent = false;
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      continue;
    }

    if (ch === "[") {
      inBracketIdent = true;
      current += ch;
      continue;
    }

    if (isWordChar(ch)) {
      const prev = sql[i - 1] ?? "";
      if (!isWordChar(prev)) {
        const rest = sql.slice(i);
        if (/^BEGIN\b/i.test(rest) && current.trim().length > 0) {
          triggerBlockDepth++;
        } else if (/^END\b/i.test(rest) && triggerBlockDepth > 0) {
          triggerBlockDepth--;
        }
      }
    }

    if (ch === ";" && triggerBlockDepth === 0) {
      const trimmed = current.trim();
      if (trimmed && !isIgnorableStandaloneStatement(trimmed)) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail && !isIgnorableStandaloneStatement(tail)) {
    statements.push(tail);
  }

  return statements;
}

function extractInsertTableName(stmt: string): string | null {
  const match = stmt.match(
    /^INSERT\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)\s+)?INTO\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z0-9_]+)/i,
  );
  if (!match?.[1]) return null;
  return unquoteIdent(match[1]);
}

/**
 * Сортирует таблицы так, чтобы родительские таблицы шли раньше дочерних (по внешним ключам).
 */
async function getTablesOrderedByDependency(): Promise<string[]> {
  const res = await turso.execute(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'libsql_%'
      AND name NOT LIKE '%_fts%'
    ORDER BY name;
  `);

  const tables = (res.rows as any[]).map((r) => String(r.name || "").trim()).filter(Boolean);

  // parentsMap.get(childTable) = Set of parent tables that child references
  const parentsMap = new Map<string, Set<string>>();
  for (const t of tables) {
    parentsMap.set(t, new Set<string>());
  }

  for (const t of tables) {
    try {
      const fkRes = await turso.execute(`PRAGMA foreign_key_list(${quoteIdent(t)});`);
      for (const fk of fkRes.rows as any[]) {
        const parentTable = String(fk.table || "").trim();
        if (parentTable && parentTable !== t && parentsMap.has(parentTable)) {
          parentsMap.get(t)!.add(parentTable);
        }
      }
    } catch {
      // Игнорируем если PRAGMA недоступна для конкретной таблицы
    }
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(table: string): void {
    if (visited.has(table)) return;
    if (visiting.has(table)) return; // защита от циклических ссылок

    visiting.add(table);
    for (const parent of parentsMap.get(table) || []) {
      visit(parent);
    }
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  }

  for (const t of tables) {
    visit(t);
  }

  return ordered;
}

/**
 * Упорядочивает стейтменты: сначала DDL (CREATE TABLE / INDEX / TRIGGER),
 * затем INSERT по родительским таблицам перед дочерними, затем прочие операторы.
 */
async function orderStatementsForRestore(statements: string[]): Promise<string[]> {
  const orderedTables = await getTablesOrderedByDependency();
  const rankMap = new Map<string, number>();
  orderedTables.forEach((t, idx) => rankMap.set(t, idx));

  const ddl: string[] = [];
  const inserts: Array<{ stmt: string; rank: number; idx: number }> = [];
  const other: string[] = [];

  statements.forEach((stmt, idx) => {
    const upper = stmt.trim().toUpperCase();
    if (
      upper.startsWith("CREATE TABLE") ||
      upper.startsWith("CREATE UNIQUE INDEX") ||
      upper.startsWith("CREATE INDEX") ||
      upper.startsWith("CREATE TRIGGER")
    ) {
      ddl.push(stmt);
      return;
    }

    const insertTable = extractInsertTableName(stmt);
    if (insertTable) {
      const rank = rankMap.has(insertTable) ? rankMap.get(insertTable)! : Number.MAX_SAFE_INTEGER;
      inserts.push({ stmt, rank, idx });
      return;
    }

    other.push(stmt);
  });

  inserts.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.idx - b.idx));

  return [...ddl, ...inserts.map((x) => x.stmt), ...other];
}

async function confirmTruncate(tables: string[]): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.warn(
      "⚠️ Неинтерактивный терминал (stdin не TTY) и не передан флаг --yes: очистка таблиц отменена.",
    );
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.warn(
      `\n⚠️ ВНИМАНИЕ: будут удалены все данные из таблиц (${tables.length}): ${tables.join(", ")}.`,
    );
    const answer = await rl.question("Введите 'yes' для подтверждения очистки таблиц: ");
    const normalized = answer.trim().toLowerCase();
    return normalized === "yes" || normalized === "y";
  } finally {
    rl.close();
  }
}

async function truncateUserTables(dryRun: boolean, autoYes: boolean): Promise<boolean> {
  const parentFirstTables = await getTablesOrderedByDependency();
  // При удалении идём от дочерних таблиц к родительским
  const childFirstTables = [...parentFirstTables].reverse();

  if (childFirstTables.length === 0) {
    console.log("ℹ️ Пользовательские таблицы для очистки не найдены.");
    return true;
  }

  if (dryRun) {
    console.log(
      `[DRY-RUN] Будут очищены таблицы (${childFirstTables.length}) в порядке от дочерних к родительским: ${childFirstTables.join(", ")}`,
    );
    return true;
  }

  if (!autoYes) {
    const confirmed = await confirmTruncate(childFirstTables);
    if (!confirmed) {
      console.log("🛑 Очистка таблиц и восстановление отменены пользователем.");
      return false;
    }
  }

  console.log(`🧹 Очистка таблиц (${childFirstTables.length}) перед восстановлением...`);

  const deleteStatements = childFirstTables.map((t) => `DELETE FROM ${quoteIdent(t)};`);
  await turso.batch(deleteStatements, "write");

  const seqRes = await turso.execute(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'sqlite_sequence'
    LIMIT 1;
  `);

  if (seqRes.rows.length > 0) {
    const placeholders = childFirstTables.map(() => "?").join(", ");
    await turso.execute({
      sql: `DELETE FROM sqlite_sequence WHERE name IN (${placeholders});`,
      args: childFirstTables,
    });
  }

  console.log(`✅ Таблицы очищены: ${childFirstTables.join(", ")}`);
  return true;
}

async function rebuildFtsIndex(): Promise<void> {
  const ftsCheck = await turso.execute(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'posts_fts'
    LIMIT 1;
  `);

  if (ftsCheck.rows.length === 0) {
    console.log("ℹ️ Таблица posts_fts не найдена — переиндексация пропущена.");
    return;
  }

  console.log("🔄 Переиндексация полнотекстового индекса posts_fts...");
  await turso.execute("INSERT INTO posts_fts(posts_fts) VALUES('rebuild');");
  console.log("✨ Индекс posts_fts успешно пересобран!");
}

async function executeStatementsSafely(statements: string[]): Promise<void> {
  const batchSize = 50;
  let executedCount = 0;

  for (let i = 0; i < statements.length; i += batchSize) {
    const chunk = statements.slice(i, i + batchSize);
    try {
      await turso.batch(chunk, "write");
      executedCount += chunk.length;
    } catch (batchErr) {
      // Если батч упал, пробуем выполнить стейтменты по одному, чтобы точно увидеть проблемный запрос
      for (const stmt of chunk) {
        try {
          await turso.execute(stmt);
          executedCount += 1;
        } catch (singleErr) {
          console.error(
            `❌ Ошибка в операторе [${executedCount + 1}/${statements.length}]: ${stmt.slice(0, 300)}`,
          );
          throw singleErr ?? batchErr;
        }
      }
    }

    if (executedCount % 250 === 0 || executedCount === statements.length) {
      console.log(`⏳ Выполнено операторов: ${executedCount}/${statements.length}`);
    }
  }
}

async function runRestore(): Promise<void> {
  const { sqlFilePath, latestFromR2, dryRun, skipFtsRebuild, truncateFirst, autoYes } =
    parseCliArgs(process.argv.slice(2));

  if (!latestFromR2 && !sqlFilePath) {
    console.error(
      "Использование: npx tsx scripts/restore-turso.ts <путь-к-бэкапу.sql | --latest-r2> [--truncate [--yes]] [--dry-run] [--skip-fts]",
    );
    process.exit(1);
  }

  const resolvedSqlPath = latestFromR2 ? await downloadLatestBackupFromR2() : sqlFilePath;

  try {
    await fs.access(resolvedSqlPath);
  } catch {
    console.error(`❌ Файл бэкапа не найден: ${resolvedSqlPath}`);
    process.exit(1);
  }

  const rawSql = await fs.readFile(resolvedSqlPath, "utf-8");
  const rawStatements = splitSqlStatements(rawSql);

  if (rawStatements.length === 0) {
    console.log("⚠️ В SQL-файле не найдено операторов для выполнения.");
    return;
  }

  const statements = await orderStatementsForRestore(rawStatements);

  console.log(
    `${dryRun ? "[DRY-RUN] " : ""}Найдено SQL-операторов в файле ${path.basename(resolvedSqlPath)}: ${statements.length}`,
  );

  if (truncateFirst) {
    const proceeded = await truncateUserTables(dryRun, autoYes);
    if (!proceeded) {
      return;
    }
  }

  if (dryRun) {
    const preview = statements.slice(0, 10);
    for (let i = 0; i < preview.length; i++) {
      console.log(`  [${i + 1}] ${preview[i].replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (statements.length > preview.length) {
      console.log(`  ... и ещё ${statements.length - preview.length} операторов`);
    }
    console.log(
      `[DRY-RUN] Восстановление не выполнялось${skipFtsRebuild ? "" : " (+ пересборка posts_fts)"}.`,
    );
    return;
  }

  await executeStatementsSafely(statements);

  if (!skipFtsRebuild) {
    await rebuildFtsIndex();
  } else {
    console.log("⏭️ Переиндексация posts_fts пропущена по флагу --skip-fts.");
  }

  console.log(`🎉 База Turso успешно восстановлена из ${path.basename(resolvedSqlPath)}!`);
}

runRestore().catch((err) => {
  console.error("❌ Ошибка при восстановлении базы Turso:", err);
  process.exit(1);
});
