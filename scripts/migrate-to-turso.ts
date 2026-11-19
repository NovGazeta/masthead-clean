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

interface ExtractedImage {
  url: string;
  alt: string | null;
  position: number;
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
  const images: ExtractedImage[] = [];

  // 1. Markdown-изображения: ![alt](url) или ![alt](url "title")
  const mdImgRegex = /!\[([^\]]*)\]\((\S+?)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of markdown.matchAll(mdImgRegex)) {
    const rawUrl = match[2]?.trim();
    if (!rawUrl) continue;
    const altText = match[1]?.trim() || null;
    images.push({
      url: rawUrl,
      alt: altText,
      position: images.length,
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

    images.push({
      url: rawUrl,
      alt: altText,
      position: images.length,
    });
  }

  return images;
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

async function loadExistingHashes(): Promise> {
  const map = new Map<string, string>();

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

  return map;
}

async function migrate() {
  if (!fs.existsSync(articlesDir)) {
    console.error(`❌ Ошибка: Директория с контентом не найдена: ${articlesDir}`);
    return;
  }

  await ensureImagesTable();
  await ensureSyncHashesTable();

  const files = fs.readdirSync(articlesDir, { recursive: true }) as string[];
  const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));

  console.log(`📦 Найдено Markdown-файлов для миграции: ${mdFiles.length}`);

  const existingHashes = await loadExistingHashes();
  console.log(`⚡ В таблице хэшей записей: ${existingHashes.size}`);

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

    const pubDateValue = data.date ? new Date(String(data.date)).toISOString() : new Date().toISOString();
    const nextHash = computeArticleHash(data, trimmedMarkdown, pubDateValue);
    const prevHash = existingHashes.get(slug);

    // Быстрая проверка ДО marked.parse() / extractImagesFromMarkdown() / SQL-записи
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
      const plainText = stripMarkdown(rawMarkdown);
      const htmlContent = await marked.parse(rawMarkdown);

      // 1. Рубрика (1:M)
      let rubricId = null;
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
        rubricId = rubricRes.rows[0]?.id || null;
      }

      const authorsRaw = normalizeListField(data.authors);
      const tagsRaw = normalizeListField(data.tags);

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
          tagsRaw.length > 0 ? tagsRaw.join(", ") : null,
          calculateReadingTime(plainText) || null,
          trimmedMarkdown,
          htmlContent || null,
          rubricId,
          data.featured ? 1 : 0,
          data.draft ? 1 : 0,
          data.date ? String(data.date) : pubDateValue,
          pubDateValue,
        ],
      });

      // Получаем id сохраненного поста
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
        const authorsList = parseAuthors(authorsRaw.join(","));

        for (const author of authorsList) {
          await turso.execute({
            sql: `
              INSERT INTO authors (slug, name, role)
              VALUES (?, ?, ?)
              ON CONFLICT(slug) DO UPDATE SET
                name = excluded.name,
                role = COALESCE(excluded.role, authors.role);
            `,
            args: [author.slug, author.name, author.role || null],
          });
          const authorRes = await turso.execute({
            sql: `SELECT id FROM authors WHERE slug = ?;`,
            args: [author.slug],
          });
          const authorId = authorRes.rows[0]?.id;

          if (authorId) {
            await turso.execute({
              sql: `INSERT OR IGNORE INTO posts_authors (post_id, author_id) VALUES (?, ?);`,
              args: [postId, authorId],
            });

            if (rubricId) {
              await turso.execute({
                sql: `INSERT OR IGNORE INTO authors_rubrics (author_id, rubric_id) VALUES (?, ?);`,
                args: [authorId, rubricId],
              });
            }
          }
        }

        // 4. Теги (M:N)
        for (const tagName of tagsRaw) {
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

          if (tagId) {
            await turso.execute({
              sql: `INSERT OR IGNORE INTO posts_tags (post_id, tag_id) VALUES (?, ?);`,
              args: [postId, tagId],
            });
          }
        }

        // Сохраняем актуальный sha256 хэш статьи
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
      console.log(
        `[Успешно] Мигрирована статья: ${slug} (изображений: ${extractedImages.length})`,
      );
    } catch (err) {
      console.error(`[Ошибка] Не удалось мигрировать статью ${slug}:`, err);
    }
  }

  console.log(
    `📊 Итог: обработано ${insertedOrUpdated}, пропущено (без изменений / уже в БД): ${skipped}.`,
  );

  // Переиндексация FTS5 (только если были изменения или передан --force-all)
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
