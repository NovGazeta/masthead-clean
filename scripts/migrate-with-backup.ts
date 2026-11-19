import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const skipBackup = args.includes("--skip-backup");
const migrationArgs = args.filter((arg) => arg !== "--skip-backup");

const backupScriptPath = path.resolve("scripts/backup-turso.ts");
const migrateScriptPath = path.resolve("scripts/migrate-to-turso.ts");

function runTsxScript(scriptPath: string, scriptArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...scriptArgs], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Скрипт ${path.basename(scriptPath)} завершился с кодом ${code ?? 1}`));
      }
    });
  });
}

async function main() {
  try {
    if (!skipBackup) {
      console.log("🛡️ Шаг 1/2: Создаём бэкап Turso и загружаем в Cloudflare R2...");
      await runTsxScript(backupScriptPath, []);
    } else {
      console.log("⏭️ Шаг 1/2 пропущен (--skip-backup).");
    }

    console.log("🚀 Шаг 2/2: Запускаем миграцию статей в Turso...");
    await runTsxScript(migrateScriptPath, migrationArgs);

    console.log("✅ Пайплайн бэкапа и миграции успешно завершён.");
  } catch (err) {
    console.error("❌ Пайплайн остановлен из-за ошибки:", err);
    process.exitCode = 1;
  }
}

main();
