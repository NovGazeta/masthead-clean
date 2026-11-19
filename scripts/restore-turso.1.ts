import fs from "node:fs/promises";
import path from "node:path";
import { turso } from "../src/lib/turso";

interface CliOptions {
  sqlFilePath: string;
  dryRun: boolean;
  skipFtsRebuild: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let dryRun = false;
  let skipFtsRebuild = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-fts") {
      skipFtsRebuild = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return {
    sqlFilePath: path.resolve(positional[0] || ""),
    dryRun,
    skipFtsRebuild,
  };
}

/**
 * Разбивает SQL-скрипт на отдельные операторы по ';' с учётом:
 * - строковых литералов ('...' и экранированных '')
 * - идентификаторов в двойных кавычках ("..." и "") или квадратных скобках [...]
 * - блочных комментариев /* ... *\/ и однострочных -- ...
 * При этом сохраняет BEGIN ... END внутри триггеров.
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

    // Вне строк и комментариев
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

    // Отслеживание BEGIN ... END внутри триггеров (чтобы ';' внутри триггера не резал стейтмент)
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
      if (trimmed) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }

  return statements;
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

async function runRestore(): Promise<void> {
  const { sqlFilePath, dryRun, skipFtsRebuild } = parseCliArgs(process.argv.slice(2));

  if (!process.argv.slice(2).find((a) => !a.startsWith("-"))) {
    console.error("Использование: npx tsx scripts/restore-turso.ts <путь-к-бэкапу.sql> [--dry-run] [--skip-fts]");
    process.exit(1);
  }

  try {
    await fs.access(sqlFilePath);
  } catch {
    console.error(`❌ Файл бэкапа не найден: ${sqlFilePath}`);
    process.exit(1);
  }

  const rawSql = await fs.readFile(sqlFilePath, "utf-8");
  const statements = splitSqlStatements(rawSql);

  if (statements.length === 0) {
    console.log("⚠️ В SQL-файле не найдено операторов для выполнения.");
    return;
  }

  console.log(
    `${dryRun ? "[DRY-RUN] " : ""}Найдено SQL-операторов в файле ${path.basename(sqlFilePath)}: ${statements.length}`,
  );

  if (dryRun) {
    const preview = statements.slice(0, 10);
    for (let i = 0; i < preview.length; i++) {
      console.log(`  [${i + 1}] ${preview[i].replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (statements.length > preview.length) {
      console.log(`  ... и ещё ${statements.length - preview.length} операторов`);
    }
    console.log(`[DRY-RUN] Восстановление не выполнялось${skipFtsRebuild ? "" : " (+ пересборка posts_fts)"}.`);
    return;
  }

  const batchSize = 50;
  let executedCount = 0;

  for (let i = 0; i < statements.length; i += batchSize) {
    const chunk = statements.slice(i, i + batchSize);
    await turso.batch(chunk, "write");
    executedCount += chunk.length;

    if (executedCount % 250 === 0 || executedCount === statements.length) {
      console.log(`⏳ Выполнено операторов: ${executedCount}/${statements.length}`);
    }
  }

  if (!skipFtsRebuild) {
    await rebuildFtsIndex();
  } else {
    console.log("⏭️ Переиндексация posts_fts пропущена по флагу --skip-fts.");
  }

  console.log(`🎉 База Turso успешно восстановлена из ${path.basename(sqlFilePath)}!`);
}

runRestore().catch((err) => {
  console.error("❌ Ошибка при восстановлении базы Turso:", err);
  process.exit(1);
});
