import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { turso } from "../src/lib/turso";
import { calculateReadingTime, parseAuthors, slugify, stripMarkdown } from "../src/lib/posts";

const articlesDir = path.resolve(".data/articles"); // src/content/articles

const args = process.argv.slice(2);
const updateExisting = args.includes("--update") || args.includes("--force");
const forceAll = args.includes("--force-all");
const dryRun = args.includes("--dry-run");

interface ExtractedImage {
  url: string;
  alt: string | null;
  position: number;
}

interface LocatedImage {
  index: number;
  url: string;
  alt: string | null;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeListField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveReadingTime(data: Record<string, unknown>, plainText: string): string | null {
  let customReadingTime: string | undefined;
  if (typeof data.readingTime === "string") {
    customReadingTime = data.readingTime;
  } else if (typeof data.reading_time === "string") {
    customReadingTime = data.reading_time;
  }

  if (plainText) {
    return calculateReadingTime(plainText, customReadingTime);
  }

  const trimmedCustom = customReadingTime?.trim();
  return trimmedCustom || null;
}

function computeArticleHash(
  data: Record<string, unknown>,
  trimmedMarkdown: string,
  pubDateValue: string,
): string {
  const payload = JSON.stringify({
    title: data.title ? String(data.title) : "Без названия",
    subtitle: data.subtitle ? String(data.subtitle) : null,
    source: data.source ? String(data.source) : null,
    genre: data.genre ? String(data.genre) : null,
    rubric: data.rubric ? String(data.rubric) : null,
    authors: normalizeListField(data.authors),
    tags: normalizeListField(data.tags),
    featured: Boolean(data.featured),
    draft: Boolean(data.draft),
    date: data.date ? String(data.date) : null,
    pubDate: pubDateValue,
    content: trimmedMarkdown,
  });

  return sha256(payload);
}

function extractImagesFromMarkdown(markdown: string): ExtractedImage[] {
  const located: LocatedImage[] = [];

  // 1. Markdown-изображения: ![alt](url) или ![alt](url "title")
  const mdImgRegex = /!\[([^\]]*)\]\((\S+?)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of markdown.matchAll(mdImgRegex)) {
    const rawUrl = match[2]?.trim();
    if (!rawUrl) continue;
    const altText = match[1]?.trim() || null;
    located.push({
      index: match.index ?? 0,
      url: rawUrl,
      alt: altText,
    });
  }

  // 2. HTML-теги <img ...> на случай, если они встречаются в тексте
  const htmlImgRegex = /<img\b[^>]*>/gi;
  for (const tagMatch of markdown.matchAll(htmlImgRegex)) {
    const tag = tagMatch[0];
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    const rawUrl = srcMatch?.[1]?.trim();
    if (!rawUrl) continue;

    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    const altText = altMatch?.[1]?.trim() || null;

    located.push({
      index: tagMatch.index ?? 0,
      url: rawUrl,
      alt: altText,
    });
  }

  located.sort((a, b) => a.index - b.index);

  return located.map((item, position) => ({
    url: item.url,
    alt: item.alt,
    position,
  }));
}

async function ensureImagesTable(): Promise<void> {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      alt TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
  `);
  await turso.execute(`
    CREATE INDEX IF NOT EXISTS idx_images_post_id ON images(post_id);
  `);
}

async function ensureSyncHashesTable(): Promise<void> {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS post_sync_hashes (
      slug TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

async function loadExistingHashes(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  try {
    const res = await turso.execute(`
      SELECT slug, content_hash
      FROM post_sync_hashes;
    `);

    for (const row of res.rows as any[]) {
      const slug = String(row.slug || "").trim();
      const hash = String(row.content_hash || "").trim();
      if (slug && hash) {
        map.set(slug, hash);
      }
    }
  } catch (err) {
    if (dryRun) {
      console.warn(
        "[DRY-RUN] Таблица post_sync_hashes пока не создана или недоступна — сверка хэшей пропущена.",
      );
      return map;
    }
    throw err;
  }

  return map;
}

async function syncPostAuthors(
  postId: number,
  rubricId: string | number | null,
  authorsList: ReturnType<typeof parseAuthors>,
): Promise<void> {
  const syncedAuthorIds: Array<string | number> = [];

  for (const author of authorsList) {
    await turso.execute({
      sql: `
        INSERT INTO authors (slug, name, role)
        VALUES (?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          role = COALESCE(excluded.role, authors.role);
      `,
      args: [author.slug, author.name, author.role ?? null],
    });

    const authorRes = await turso.execute({
      sql: `SELECT id FROM authors WHERE slug = ?;`,
      args: [author.slug],
    });
    const authorId = authorRes.rows[0]?.id;

    if (authorId != null) {
      syncedAuthorIds.push(authorId);

      await turso.execute({
        sql: `INSERT OR IGNORE INTO posts_authors (post_id, author_id) VALUES (?, ?);`,
        args: [postId, authorId],
      });

      if (rubricId != null) {
        await turso.execute({
          sql: `INSERT OR IGNORE INTO authors_rubrics (author_id, rubric_id) VALUES (?, ?);`,
          args: [authorId, rubricId],
        });
      }
    }
  }

  if (syncedAuthorIds.length === 0) {
    await turso.execute({
      sql: `DELETE FROM posts_authors WHERE post_id = ?;`,
      args: [postId],
    });
    return;
  }

  const placeholders = syncedAuthorIds.map(() => "?").join(", ");
  await turso.execute({
    sql: `DELETE FROM posts_authors WHERE post_id = ? AND author_id NOT IN (${placeholders});`,
    args: [postId, ...syncedAuthorIds],
  });
}

async function syncPostTags(postId: number, tagsListRaw: string[]): Promise<void> {
  const syncedTagIds: Array<string | number> = [];

  for (const tagName of tagsListRaw) {
    const cleanTag = String(tagName).trim();
    if (!cleanTag) continue;
    const tagSlug = slugify(cleanTag);
    if (!tagSlug) continue;

    await turso.execute({
      sql: `INSERT INTO tags (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
      args: [tagSlug, cleanTag],
    });

    const tagRes = await turso.execute({
      sql: `SELECT id FROM tags WHERE slug = ?;`,
      args: [tagSlug],
    });
    const tagId = tagRes.rows[0]?.id;

    if (tagId != null) {
      syncedTagIds.push(tagId);

      await turso.execute({
        sql: `INSERT OR IGNORE INTO posts_tags (post_id, tag_id) VALUES (?, ?);`,
        args: [postId, tagId],
      });
    }
  }

  if (syncedTagIds.length === 0) {
    await turso.execute({
      sql: `DELETE FROM posts_tags WHERE post_id = ?;`,
      args: [postId],
    });
    return;
  }

  const placeholders = syncedTagIds.map(() => "?").join(", ");
  await turso.execute({
    sql: `DELETE FROM posts_tags WHERE post_id = ? AND tag_id NOT IN (${placeholders});`,
    args: [postId, ...syncedTagIds],
  });
}

async function migrate() {
  if (!fs.existsSync(articlesDir)) {
    console.error(`❌ Ошибка: Директория с контентом не найдена: ${articlesDir}`);
    return;
  }

  if (!dryRun) {
    await ensureImagesTable();
    await ensureSyncHashesTable();
  }

  const files = fs.readdirSync(articlesDir, { recursive: true }) as string[];
  const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));

  const runPrefix = dryRun ? "[DRY-RUN] " : "";
  console.log(`${runPrefix}📦 Найдено Markdown-файлов для миграции: ${mdFiles.length}`);

  const existingHashes = await loadExistingHashes();
  console.log(`${runPrefix}⚡ В таблице хэшей записей: ${existingHashes.size}`);

  let insertedOrUpdated = 0;
  let skipped = 0;
  let hadChanges = false;

  for (const file of mdFiles) {
    const filePath = path.join(articlesDir, file);
    const fileContent = fs.readFileSync(filePath, "utf-8");

    const parsed = matter(fileContent);
    const data = parsed.data as Record<string, unknown>;
    const rawMarkdown = parsed.content.replaceAll("[](_assets/", "[](/_assets/");
    const trimmedMarkdown = rawMarkdown.trim();
    const slug = String(data.slug || path.basename(file, path.extname(file))).trim();

    const pubDateValue = data.date
      ? new Date(String(data.date)).toISOString()
      : new Date().toISOString();
    const nextHash = computeArticleHash(data, trimmedMarkdown, pubDateValue);
    const prevHash = existingHashes.get(slug) ?? null;

    if (!forceAll && prevHash) {
      if (!updateExisting) {
        skipped++;
        continue;
      }
      if (prevHash === nextHash) {
        skipped++;
        continue;
      }
    }

    try {
      const extractedImages = extractImagesFromMarkdown(rawMarkdown);
      const authorsList = parseAuthors(data.authors);
      const authorsRaw = normalizeListField(data.authors);
      const tagsListRaw = normalizeListField(data.tags);

      const tagsFormattedList = tagsListRaw
        .map((tagName) => {
          const cleanTag = String(tagName).trim();
          const tagSlug = cleanTag ? slugify(cleanTag) : "";
          return cleanTag && tagSlug ? `${cleanTag} (${tagSlug})` : null;
        })
        .filter((t): t is string => Boolean(t));

      const rubricRaw = data.rubric ? String(data.rubric).trim() : null;
      const rubricFormatted = rubricRaw ? `${rubricRaw} (${slugify(rubricRaw)})` : "—";
      const authorsFormatted =
        authorsList.length > 0
          ? authorsList
              .map((a) => {
                const roleSuffix = a.role ? ` [role: ${a.role}]` : "";
                return `${a.name}${roleSuffix} (${a.slug})`;
              })
              .join(", ")
          : "—";
      const tagsFormatted = tagsFormattedList.length > 0 ? tagsFormattedList.join(", ") : "—";

      if (dryRun) {
        const modeLabel = prevHash ? "UPDATE" : "INSERT";
        const prevHashNote = prevHash ? ` (prev: ${prevHash})` : "";
        console.log(`\n[DRY-RUN] Статья: ${slug} (${modeLabel})`);
        console.log(`  • Рубрика: ${rubricFormatted}`);
        console.log(`  • Авторы: ${authorsFormatted}`);
        console.log(`  • Теги: ${tagsFormatted}`);
        console.log(`  • Изображений: ${extractedImages.length}`);
        console.log(`  • SHA-256: ${nextHash}${prevHashNote}`);
        insertedOrUpdated++;
        continue;
      }

      const plainText = stripMarkdown(rawMarkdown);
      const htmlContent = await marked.parse(rawMarkdown);
      const readingTimeValue = resolveReadingTime(data, plainText);

      // 1. Рубрика (1:M)
      let rubricId: string | number | null = null;
      if (data.rubric) {
        const rubricName = String(data.rubric);
        const rubricSlug = slugify(rubricName);
        await turso.execute({
          sql: `INSERT INTO rubrics (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
          args: [rubricSlug, rubricName],
        });
        const rubricRes = await turso.execute({
          sql: `SELECT id FROM rubrics WHERE slug = ?;`,
          args: [rubricSlug],
        });
        rubricId = (rubricRes.rows[0]?.id as string | number | undefined) ?? null;
      }

      // 2. Вставка / обновление поста в таблицу posts
      await turso.execute({
        sql: `
          INSERT INTO posts (
            slug, title, subtitle, source, genre, authors, tags,
            reading_time, content, htmlContent, rubric_id, featured, draft, date, pub_date
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            title = excluded.title,
            subtitle = excluded.subtitle,
            source = excluded.source,
            genre = excluded.genre,
            authors = excluded.authors,
            tags = excluded.tags,
            reading_time = excluded.reading_time,
            content = excluded.content,
            htmlContent = excluded.htmlContent,
            rubric_id = excluded.rubric_id,
            featured = excluded.featured,
            draft = excluded.draft,
            date = excluded.date,
            pub_date = excluded.pub_date;
        `,
        args: [
          slug,
          data.title ? String(data.title) : "Без названия",
          data.subtitle ? String(data.subtitle) : null,
          data.source ? String(data.source) : null,
          data.genre ? String(data.genre) : null,
          authorsRaw.length > 0 ? authorsRaw.join(", ") : null,
          tagsListRaw.length > 0 ? tagsListRaw.join(", ") : null,
          readingTimeValue,
          trimmedMarkdown,
          htmlContent || null,
          rubricId,
          data.featured ? 1 : 0,
          data.draft ? 1 : 0,
          data.date ? String(data.date) : pubDateValue,
          pubDateValue,
        ],
      });

      const postRes = await turso.execute({
        sql: `SELECT id FROM posts WHERE slug = ?;`,
        args: [slug],
      });
      const postId = Number(postRes.rows[0]?.id || 0);

      if (postId) {
        // 2.1. Изображения поста (1:M)
        await turso.execute({
          sql: `DELETE FROM images WHERE post_id = ?;`,
          args: [postId],
        });

        for (const img of extractedImages) {
          await turso.execute({
            sql: `INSERT INTO images (post_id, url, alt, position) VALUES (?, ?, ?, ?);`,
            args: [postId, img.url, img.alt, img.position],
          });
        }

        // 3. Авторы (M:N) и их связь с рубриками
        await syncPostAuthors(postId, rubricId, authorsList);

        // 4. Теги (M:N)
        await syncPostTags(postId, tagsListRaw);

        await turso.execute({
          sql: `
            INSERT INTO post_sync_hashes (slug, content_hash, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
              content_hash = excluded.content_hash,
              updated_at = excluded.updated_at;
          `,
          args: [slug, nextHash, new Date().toISOString()],
        });
        existingHashes.set(slug, nextHash);
      }

      insertedOrUpdated++;
      hadChanges = true;
      console.log(`[Успешно] Мигрирована статья: ${slug} (изображений: ${extractedImages.length})`);
    } catch (err) {
      console.error(`[Ошибка] Не удалось мигрировать статью ${slug}:`, err);
    }
  }

  console.log(
    `${runPrefix}📊 Итог: обработано ${insertedOrUpdated}, пропущено (без изменений / уже в БД): ${skipped}.`,
  );

  if (dryRun) {
    console.log("[DRY-RUN] Запись в Turso и переиндексация FTS5 не выполнялись.");
    return;
  }

  if (hadChanges || forceAll) {
    try {
      console.log("🔄 Переиндексация FTS5...");
      await turso.execute("INSERT INTO posts_fts(posts_fts) VALUES('rebuild');");
      console.log("✨ Поисковый индекс FTS5 успешно обновлен!");
    } catch (err) {
      console.error("[Предупреждение] Ошибка переиндексации FTS5:", err);
    }
  } else {
    console.log("⏭️ Изменений нет — переиндексация FTS5 пропущена.");
  }

  console.log("🎉 Миграция под новую схему завершена!");
}

migrate();
