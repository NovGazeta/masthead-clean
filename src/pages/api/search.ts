import type { APIRoute } from 'astro';
import { turso } from "../src/lib/turso";

export const GET: APIRoute = async ({ url }) => {
  const query = url.searchParams.get('q');

  if (!query || query.trim() === '') {
    return new Response(JSON.stringify({ error: 'Поисковый запрос не задан' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Очищаем и подготавливаем поисковый запрос для FTS5 (убираем спецсимволы)
  const sanitizedQuery = query.trim().replace(/['"()*+-]/g, ' ');

  try {
    // Выполняем полнотекстовый поиск по FTS5 таблице с сортировкой по релевантности (rank)
    const result = await turso.execute({
      sql: `
        SELECT p.slug, p.title, p.subtitle, p.description, p.pub_date, p.rubric
        FROM posts_fts fts
        JOIN posts p ON fts.rowid = p.id
        WHERE posts_fts MATCH ? AND p.draft = 0
        ORDER BY rank
        LIMIT 20;
      `,
      args: [sanitizedQuery],
    });

    const posts = result.rows.map((row: any) => ({
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      pubDate: row.pub_date,
      rubric: row.rubric,
    }));

    return new Response(JSON.stringify({ query: sanitizedQuery, results: posts }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', // Кэшируем на Edge
      },
    });
  } catch (err) {
    console.error('[Search API Error]:', err);
    return new Response(JSON.stringify({ error: 'Ошибка сервера при выполнении поиска' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
