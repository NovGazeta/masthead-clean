import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { createClient } from '@libsql/client';
import 'dotenv/config';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

const articlesDir = path.resolve('src/content/articles');

// Вспомогательная функция для создания слага из строки
function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
}

async function migrate() {
  if (!fs.existsSync(articlesDir)) {
    console.error(`❌ Ошибка: Директория с контентом не найдена: ${articlesDir}`);
    return;
  }

  const files = fs.readdirSync(articlesDir, { recursive: true }) as string[];
  const mdFiles = files.filter(f => f.endsWith('.md') || f.endsWith('.mdx'));

  console.log(`📦 Найдено Markdown-файлов для миграции: ${mdFiles.length}`);

  for (const file of mdFiles) {
    const filePath = path.join(articlesDir, file);
    const fileContent = fs.readFileSync(filePath, 'utf-8');

    const { data, content } = matter(fileContent);
    const slug = data.slug || path.basename(file, path.extname(file));

    try {
      // 1. Обработка рубрики (связь 1:M)
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

      // 2. Сохранение статьи в таблицу posts
      await turso.execute({
        sql: `
          INSERT INTO posts (slug, title, subtitle, description, pub_date, rubric_id, genre, draft, content, reading_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            title = excluded.title,
            subtitle = excluded.subtitle,
            description = excluded.description,
            pub_date = excluded.pub_date,
            rubric_id = excluded.rubric_id,
            genre = excluded.genre,
            draft = excluded.draft,
            content = excluded.content,
            reading_time = excluded.reading_time;
        `,
        args: [
          slug,
          data.title || 'Без названия',
          data.subtitle || null,
          data.description || null,
          data.pubDate ? new Date(data.pubDate).toISOString() : new Date().toISOString(),
          rubricId,
          data.genre || null,
          data.draft ? 1 : 0,
          content.trim(),
          data.readingTime || null,
        ],
      });

      // Получаем id сохраненного поста
      const postRes = await turso.execute({
        sql: `SELECT id FROM posts WHERE slug = ?;`,
        args: [slug],
      });
      const postId = postRes.rows[0]?.id;

      if (postId) {
        // 3. Обработка авторов (связь M:N)
        const authors: string[] = Array.isArray(data.authors) ? data.authors : (data.author ? [data.author] : []);
        for (const authorName of authors) {
          const authorSlug = slugify(authorName);
          await turso.execute({
            sql: `INSERT INTO authors (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name;`,
            args: [authorSlug, authorName],
          });
          const authorRes = await turso.execute({
            sql: `SELECT id FROM authors WHERE slug = ?;`,
            args: [authorSlug],
          });
          const authorId = authorRes.rows[0]?.id;

          if (authorId) {
            await turso.execute({
              sql: `INSERT OR IGNORE INTO posts_authors (post_id, author_id) VALUES (?, ?);`,
              args: [postId, authorId],
            });
          }
        }

        // 4. Обработка тегов (связь M:N)
        const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
        for (const tagName of tags) {
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

      console.log(`[Успешно] Мигрирована статья со связями: ${slug}`);
    } catch (err) {
      console.error(`[Ошибка] Не удалось мигрировать статью ${slug}:`, err);
    }
  }

  // Обновление поискового индекса FTS5
  try {
    console.log('🔄 Переиндексация FTS5...');
    await turso.execute("INSERT INTO posts_fts(posts_fts) VALUES('rebuild');");
    console.log('✨ Поисковый индекс успешно обновлен!');
  } catch (err) {
    console.error('[Предупреждение] Ошибка переиндексации FTS5:', err);
  }

  console.log('🎉 Полная реляционная миграция в Turso завершена!');
}

migrate();
