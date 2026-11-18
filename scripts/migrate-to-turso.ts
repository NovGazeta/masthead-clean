import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { turso } from "../src/lib/turso";
import { calculateReadingTime, parseAuthors, slugify, stripMarkdown } from "../src/lib/posts";

const articlesDir = path.resolve("src/content/articles");

async function migrate() {
  if (!fs.existsSync(articlesDir)) {
    console.error(`❌ Ошибка: Директория с контентом не найдена: ${articlesDir}`);
    return;
  }

  const files = fs.readdirSync(articlesDir, { recursive: true }) as string[];
  const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));

  console.log(`📦 Найдено Markdown-файлов для миграции: ${mdFiles.length}`);

  for (const file of mdFiles) {
    const filePath = path.join(articlesDir, file);
    const fileContent = fs.readFileSync(filePath, "utf-8");

    const { data, content } = matter(fileContent);
    const plainText = stripMarkdown(content);
    const htmlContent = await marked.parse(content);
    const slug = data.slug || path.basename(file, path.extname(file));

    try {
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

      // 2. Вставка поста в таблицу posts
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
          content.trim(),
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
      const postId = postRes.rows[0]?.id;

      if (postId) {
        // 3. Авторы (M:N) и их связь с рубриками
        const authorsList = Array.isArray(data.authors)
          ? parseAuthors(data.authors.join(","))
          : parseAuthors(data.authors);

        for (const author of authorsList) {
          await turso.execute({
            sql: `INSERT INTO authors (slug, name, role) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
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
        const tagsList: string[] = Array.isArray(data.tags) ? data.tags : [];
        for (const tagName of tagsList) {
          const tagSlug = slugify(tagName);
          await turso.execute({
            sql: `INSERT INTO tags (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
            args: [tagSlug, tagName],
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
      }

      console.log(`[Успешно] Мигрирована статья: ${slug}`);
    } catch (err) {
      console.error(`[Ошибка] Не удалось мигрировать статью ${slug}:`, err);
    }
  }

  // Переиндексация FTS5
  try {
    console.log("🔄 Переиндексация FTS5...");
    await turso.execute("INSERT INTO posts_fts(posts_fts) VALUES('rebuild');");
    console.log("✨ Поисковый индекс FTS5 успешно обновлен!");
  } catch (err) {
    console.error("[Предупреждение] Ошибка переиндексации FTS5:", err);
  }

  console.log("🎉 Миграция под новую схему завершена!");
}

migrate();
