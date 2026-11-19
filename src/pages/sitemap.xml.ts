import type { APIRoute } from "astro";
import { turso } from "@/lib/turso";
import { slugify } from "@/lib/posts";

const ARTICLES_PER_PAGE = 12;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const GET: APIRoute = async ({ site, url }) => {
  const baseUrl = (site?.toString() || url.origin).replace(/\/$/, "");

  const staticSections = ["/", "/about", "/authors", "/archive", "/search"];
  const sectionUrls = new Set<string>(staticSections.map((path) => `${baseUrl}${path}`));

  try {
    const rubricsRes = await turso.execute(`
      SELECT
        r.name,
        r.slug,
        COUNT(p.id) as post_count
      FROM rubrics r
      LEFT JOIN posts p ON p.rubric_id = r.id AND p.draft = 0
      GROUP BY r.id, r.name, r.slug
      ORDER BY r.name COLLATE NOCASE ASC;
    `);

    for (const row of rubricsRes.rows as any[]) {
      const rubricSlug = String(row.slug || "").trim() || slugify(String(row.name || ""));
      if (!rubricSlug) continue;

      const baseRubricUrl = `${baseUrl}/category/${encodeURIComponent(rubricSlug)}`;
      sectionUrls.add(baseRubricUrl);

      const totalPosts = Number(row.post_count ?? 0);
      const totalPages = Math.max(1, Math.ceil(totalPosts / ARTICLES_PER_PAGE));

      for (let page = 2; page <= totalPages; page++) {
        sectionUrls.add(`${baseRubricUrl}/${page}`);
      }
    }
  } catch (error) {
    console.error("Ошибка получения рубрик из Turso для sitemap.xml:", error);
  }

  try {
    const yearsRes = await turso.execute(`
      SELECT DISTINCT CAST(strftime('%Y', COALESCE(pub_date, date)) AS INTEGER) as year
      FROM posts
      WHERE draft = 0
      ORDER BY year DESC;
    `);

    for (const row of yearsRes.rows as any[]) {
      const year = Number(row.year);
      if (Number.isFinite(year) && year > 0) {
        sectionUrls.add(`${baseUrl}/archive/${year}`);
      }
    }
  } catch (error) {
    console.error("Ошибка получения годов архива для sitemap.xml:", error);
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...Array.from(sectionUrls).map((loc) => `  <url>\n    <loc>${escapeXml(loc)}</loc>\n  </url>`),
    "</urlset>",
  ].join("\n");

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": import.meta.env.DEV
        ? "public, s-maxage=1, stale-while-revalidate=1"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};
