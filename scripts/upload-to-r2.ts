import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME;
const publicBaseUrl = (process.env.PUBLIC_ASSETS_BASE_URL || "").replace(/\/+$/, "");

if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
  console.error(
    "Заполните R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и R2_BUCKET_NAME в .env",
  );
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

const MIME_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const SUPPORTED_EXTS = new Set(Object.keys(MIME_TYPES));

interface CliOptions {
  sourceDir: string;
  keyPrefix: string;
  dryRun: boolean;
  reportPath?: string;
  fromReportPath?: string;
}

interface FolderBatch {
  localDir: string;
  r2Prefix: string;
  files: string[];
}

interface UploadStats {
  uploaded: number;
  overwritten: number;
  skipped: number;
}

interface RemoteObjectMeta {
  exists: boolean;
  size?: number;
}

interface ReportEntry {
  key: string;
  localPath: string;
  localSize: number;
  remoteSize?: number;
  url: string;
}

interface DryRunReport {
  generatedAt: string;
  bucket: string;
  sourceDir: string;
  keyPrefix: string;
  summary: {
    toUpload: number;
    toOverwrite: number;
    skipped: number;
  };
  toUpload: ReportEntry[];
  toOverwrite: ReportEntry[];
  skipped: ReportEntry[];
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function parseCliArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  let dryRun = false;
  let reportPath: string | undefined;
  let fromReportPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--report") {
      const nextVal = argv[i + 1];
      if (nextVal && !nextVal.startsWith("-")) {
        reportPath = nextVal;
        i++;
      }
    } else if (arg.startsWith("--report=")) {
      const val = arg.slice("--report=".length).trim();
      if (val) {
        reportPath = val;
      }
    } else if (arg === "--from-report") {
      const nextVal = argv[i + 1];
      if (nextVal && !nextVal.startsWith("-")) {
        fromReportPath = nextVal;
        i++;
      }
    } else if (arg.startsWith("--from-report=")) {
      const val = arg.slice("--from-report=".length).trim();
      if (val) {
        fromReportPath = val;
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return {
    sourceDir: path.resolve(positional[0] || "./images"),
    keyPrefix: normalizePrefix(positional[1] || ""),
    dryRun,
    reportPath,
    fromReportPath,
  };
}

function joinR2Key(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function getParentPrefix(key: string): string {
  const clean = normalizePrefix(key);
  const lastSlash = clean.lastIndexOf("/");
  return lastSlash === -1 ? "" : clean.slice(0, lastSlash);
}

async function getRemoteObjectMeta(key: string): Promise<RemoteObjectMeta> {
  try {
    const res = await s3.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
    return {
      exists: true,
      size: typeof res.ContentLength === "number" ? res.ContentLength : undefined,
    };
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === "NotFound" || err?.Code === "NoSuchKey") {
      return { exists: false };
    }
    throw err;
  }
}

async function ensureR2Folder(r2Prefix: string, dryRun: boolean): Promise<void> {
  const cleanPrefix = normalizePrefix(r2Prefix);
  if (!cleanPrefix) return;

  const segments = cleanPrefix.split("/");
  let current = "";

  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const markerKey = `${current}/`;
    const meta = await getRemoteObjectMeta(markerKey);

    if (!meta.exists) {
      if (dryRun) {
        console.log(`[DRY-RUN] Будет создана папка в R2: ${markerKey}`);
      } else {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: markerKey,
            Body: new Uint8Array(0),
            ContentType: "application/x-directory",
          }),
        );
        console.log(`Создана папка в R2: ${markerKey}`);
      }
    }
  }
}

async function collectFolderBatches(
  rootDir: string,
  currentDir: string,
  basePrefix: string,
): Promise<FolderBatch[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const relDir = path.relative(rootDir, currentDir).split(path.sep).join("/");
  const r2Prefix = joinR2Key(basePrefix, relDir === "." ? "" : relDir);

  const files: string[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) {
        files.push(fullPath);
      }
    }
  }

  const batches: FolderBatch[] = [
    {
      localDir: currentDir,
      r2Prefix,
      files,
    },
  ];

  for (const subdir of subdirs) {
    batches.push(...(await collectFolderBatches(rootDir, subdir, basePrefix)));
  }

  return batches;
}

async function uploadFileToFolder(
  filePath: string,
  r2Prefix: string,
  stats: UploadStats,
  dryRun: boolean,
  reportLists: {
    toUpload: ReportEntry[];
    toOverwrite: ReportEntry[];
    skipped: ReportEntry[];
  },
): Promise<void> {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const key = joinR2Key(r2Prefix, fileName);

  const fileStat = await fs.stat(filePath);
  const localSize = fileStat.size;
  const remoteMeta = await getRemoteObjectMeta(key);
  const publicUrl = publicBaseUrl ? `${publicBaseUrl}/${key}` : `r2://${bucketName}/${key}`;

  const entry: ReportEntry = {
    key,
    localPath: filePath,
    localSize,
    ...(typeof remoteMeta.size === "number" ? { remoteSize: remoteMeta.size } : {}),
    url: publicUrl,
  };

  if (remoteMeta.exists && remoteMeta.size === localSize) {
    stats.skipped += 1;
    reportLists.skipped.push(entry);
    const prefixLog = dryRun ? "[DRY-RUN] " : "";
    console.log(`${prefixLog}SKIP (размер совпадает — ${localSize} B): ${key}`);
    return;
  }

  const isOverwrite = remoteMeta.exists;
  const sizeInfo =
    isOverwrite && typeof remoteMeta.size === "number"
      ? `${remoteMeta.size} -> ${localSize} B`
      : `${localSize} B`;

  if (dryRun) {
    if (isOverwrite) {
      stats.overwritten += 1;
      reportLists.toOverwrite.push(entry);
      console.log(`[DRY-RUN] OVERWRITE (${sizeInfo}): ${key} -> ${publicUrl}`);
    } else {
      stats.uploaded += 1;
      reportLists.toUpload.push(entry);
      console.log(`[DRY-RUN] UPLOAD (${sizeInfo}): ${key} -> ${publicUrl}`);
    }
    return;
  }

  const body = await fs.readFile(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  if (isOverwrite) {
    stats.overwritten += 1;
  } else {
    stats.uploaded += 1;
  }

  const tag = isOverwrite ? "OVERWRITE" : "OK";
  console.log(`${tag} (${sizeInfo}): ${key} -> ${publicUrl}`);
}

async function runFromReport(fromReportPath: string, dryRun: boolean): Promise<void> {
  const resolvedReport = path.resolve(fromReportPath);
  let parsed: DryRunReport;

  try {
    const raw = await fs.readFile(resolvedReport, "utf-8");
    parsed = JSON.parse(raw) as DryRunReport;
  } catch (err) {
    console.error(`Не удалось прочитать JSON-отчёт: ${resolvedReport}`, err);
    process.exit(1);
  }

  const uploadItems = Array.isArray(parsed.toUpload) ? parsed.toUpload : [];
  const overwriteItems = Array.isArray(parsed.toOverwrite) ? parsed.toOverwrite : [];

  const planned: Array<{ item: ReportEntry; forceOverwrite: boolean }> = [
    ...uploadItems.map((item) => ({ item, forceOverwrite: false })),
    ...overwriteItems.map((item) => ({ item, forceOverwrite: true })),
  ];

  if (planned.length === 0) {
    console.log("В отчёте нет файлов для загрузки или перезаписи.");
    return;
  }

  console.log(
    `${dryRun ? "[DRY-RUN] " : ""}Загрузка по отчёту ${resolvedReport}: файлов к обработке — ${planned.length} (новых: ${uploadItems.length}, перезапись: ${overwriteItems.length}). Бакет: "${bucketName}"...`,
  );

  const uniquePrefixes = Array.from(
    new Set(planned.map(({ item }) => getParentPrefix(item.key)).filter(Boolean)),
  );

  for (const prefix of uniquePrefixes) {
    await ensureR2Folder(prefix, dryRun);
  }

  const stats: UploadStats = { uploaded: 0, overwritten: 0, skipped: 0 };

  await runWithConcurrency(planned, 6, async ({ item, forceOverwrite }) => {
    const localPath = path.resolve(item.localPath);
    try {
      await fs.access(localPath);
    } catch {
      console.warn(`WARN: локальный файл не найден, пропущен: ${localPath}`);
      stats.skipped += 1;
      return;
    }

    const fileStat = await fs.stat(localPath);
    const localSize = fileStat.size;
    const key = normalizePrefix(item.key);
    const ext = path.extname(key).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const publicUrl =
      item.url || (publicBaseUrl ? `${publicBaseUrl}/${key}` : `r2://${bucketName}/${key}`);

    const remoteMeta = await getRemoteObjectMeta(key);
    const isOverwrite = forceOverwrite || remoteMeta.exists;
    const sizeInfo =
      isOverwrite && typeof remoteMeta.size === "number"
        ? `${remoteMeta.size} -> ${localSize} B`
        : `${localSize} B`;

    if (dryRun) {
      if (isOverwrite) {
        stats.overwritten += 1;
        console.log(`[DRY-RUN] OVERWRITE (${sizeInfo}): ${key} -> ${publicUrl}`);
      } else {
        stats.uploaded += 1;
        console.log(`[DRY-RUN] UPLOAD (${sizeInfo}): ${key} -> ${publicUrl}`);
      }
      return;
    }

    const body = await fs.readFile(localPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    if (isOverwrite) {
      stats.overwritten += 1;
    } else {
      stats.uploaded += 1;
    }

    const tag = isOverwrite ? "OVERWRITE" : "OK";
    console.log(`${tag} (${sizeInfo}): ${key} -> ${publicUrl}`);
  });

  const prefixSummary = dryRun ? "[DRY-RUN] План по отчёту завершён. " : "Загрузка по отчёту завершена. ";
  console.log(
    `${prefixSummary}Загружено: ${stats.uploaded}, перезаписано: ${stats.overwritten}, пропущено: ${stats.skipped}.`,
  );
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIdx = index++;
      await handler(items[currentIdx]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

async function writeDryRunReport(
  targetFile: string,
  report: DryRunReport,
): Promise<void> {
  const resolved = path.resolve(targetFile);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[DRY-RUN] JSON-отчёт сохранён в: ${resolved}`);
}

async function run(): Promise<void> {
  const { sourceDir, keyPrefix, dryRun, reportPath, fromReportPath } = parseCliArgs(
    process.argv.slice(2),
  );

  if (fromReportPath) {
    await runFromReport(fromReportPath, dryRun);
    return;
  }

  try {
    await fs.access(sourceDir);
  } catch {
    console.error(`Директория не найдена: ${sourceDir}`);
    process.exit(1);
  }

  const batches = await collectFolderBatches(sourceDir, sourceDir, keyPrefix);
  const totalFiles = batches.reduce((acc, b) => acc + b.files.length, 0);

  if (totalFiles === 0) {
    console.log("Подходящих изображений не найдено.");
    return;
  }

  console.log(
    `${dryRun ? "[DRY-RUN] " : ""}Найдено папок: ${batches.length}, изображений: ${totalFiles}. Бакет: "${bucketName}"...`,
  );

  const stats: UploadStats = { uploaded: 0, overwritten: 0, skipped: 0 };
  const reportLists = {
    toUpload: [] as ReportEntry[],
    toOverwrite: [] as ReportEntry[],
    skipped: [] as ReportEntry[],
  };

  for (const batch of batches) {
    if (batch.r2Prefix) {
      await ensureR2Folder(batch.r2Prefix, dryRun);
    }

    if (batch.files.length > 0) {
      await runWithConcurrency(batch.files, 6, (filePath) =>
        uploadFileToFolder(filePath, batch.r2Prefix, stats, dryRun, reportLists),
      );
    }
  }

  const summaryPrefix = dryRun ? "[DRY-RUN] План завершён. " : "Загрузка завершена. ";
  const uploadLabel = dryRun ? "К загрузке" : "Загружено";
  const overwriteLabel = dryRun ? "К перезаписи" : "Перезаписано";

  console.log(
    `${summaryPrefix}${uploadLabel}: ${stats.uploaded}, ${overwriteLabel}: ${stats.overwritten}, пропущено: ${stats.skipped}.`,
  );

  if (dryRun) {
    const outFile = reportPath || "./r2-dry-run-report.json";
    const report: DryRunReport = {
      generatedAt: new Date().toISOString(),
      bucket: bucketName!,
      sourceDir,
      keyPrefix,
      summary: {
        toUpload: reportLists.toUpload.length,
        toOverwrite: reportLists.toOverwrite.length,
        skipped: reportLists.skipped.length,
      },
      toUpload: reportLists.toUpload,
      toOverwrite: reportLists.toOverwrite,
      skipped: reportLists.skipped,
    };
    await writeDryRunReport(outFile, report);
  }
}

run().catch((err) => {
  console.error("Ошибка загрузки в R2:", err);
  process.exit(1);
});
