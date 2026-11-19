import "dotenv/config";
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

interface ExistingPostRecord {
  id: number;
  contentLength: number;
  htmlLength: number;
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

async function loadExistingPosts(): Promise> {
  const map = new Map<string, ExistingPostRecord>();

  const res = await turso.execute(`
    SELECT
      id,
      slug,
      COALESCE(LENGTH(content), 0) AS md_len,
      COALESCE(LENGTH(htmlContent), 0) AS html_len
    FROM posts;
  `);

  for (const row of res.rows as any[]) {
    const slug = String(row.slug || "").trim();
    if (!slug) continue;
    map.set(slug, {
      id: Number(row.id),
      contentLength: Number(row.md_len ?? 0),
      htmlLength: Number(row.html_len ?? 0),
    });
  }

  return map;
}

async function migrate() {
  if (!fs.existsSync(articlesDir)) {
    console.error(`❌ Ошибка: Директория с контентом не найдена: ${articlesDir}`);
    return;
  }

  await ensureImagesTable();

  const files = fs.readdirSync(articlesDir, { recursive: true }) as string[];
  const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));

  console.log(`📦 Найдено Markdown-файлов для миграции: ${mdFiles.length}`);

  const existingPosts = await loadExistingPosts();
  console.log(`⚡ В Turso уже существует постов: ${existingPosts.size}`);

  let insertedOrUpdated = 0;
  let skipped = 0;
  let hadChanges = false;

  for (const file of mdFiles) {
    const filePath = path.join(articlesDir, file);
    const fileContent = fs.readFileSync(filePath, "utf-8");

    const parsed = matter(fileContent);
    const data = parsed.data;
    const rawMarkdown = parsed.content.replaceAll("[](_assets/", "[](/_assets/");
    const trimmedMarkdown = rawMarkdown.trim();
    const slug = String(data.slug || path.basename(file, path.extname(file))).trim();

    const existing = existingPosts.get(slug);

    // Быстрая проверка до marked.parse() / extractImagesFromMarkdown() / SQL-записи
    if (existing && !updateExisting && !forceAll) {
      skipped++;
      continue;
    }

    if (existing && updateExisting && !forceAll) {
      if (existing.contentLength === trimmedMarkdown.length && existing.htmlLength > 0) {
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
        const rubricSlug = slugify(data.rubric);
        await turso.execute({
          sql: `INSERT INTO rubrics (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
          args: [rubricSlug, data.rubric],
        });
        const rubricRes = await turso.execute({
          sql: `SELECT id FROM rubrics WHERE slug = ?;`,
          args: [rubricSlug],
        });
        rubricId = rubricRes.rows[0]?.id || null;
      }

      // Подготовка даты публикации
      const pubDateValue = data.date ? new Date(data.date).toISOString() : new Date().toISOString();

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
          data.title || "Без названия",
          data.subtitle || null,
          data.source || null,
          data.genre || null,
          Array.isArray(data.authors) ? data.authors.join(", ") : data.authors || null,
          Array.isArray(data.tags) ? data.tags.join(", ") : data.tags || null,
          calculateReadingTime(plainText) || null,
          trimmedMarkdown,
          htmlContent || null,
          rubricId,
          !!data.featured ? 1 : 0,
          !!data.draft ? 1 : 0,
          data.date || pubDateValue,
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
        const authorsList = Array.isArray(data.authors)
          ? parseAuthors(data.authors.join(","))
          : parseAuthors(data.authors);

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
        const tagsList: string[] = Array.isArray(data.tags)
          ? data.tags
          : typeof data.tags === "string"
            ? data.tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            : [];

        for (const tagName of tagsList) {
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

        existingPosts.set(slug, {
          id: postId,
          contentLength: trimmedMarkdown.length,
          htmlLength: String(htmlContent || "").length,
        });
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
    `📊 Итог: обработано ${insertedOrUpdated}, пропущено (уже в БД): ${skipped}.`,
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
