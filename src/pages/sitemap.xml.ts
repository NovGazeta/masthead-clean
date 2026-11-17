import type { APIRoute } from "astro";
import { getAllPosts } from "@/lib/posts";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CATEGORIES = ["culture", "technology", "essays", "design"];

export const GET: APIRoute = async ({ site, url }) => {
  const posts = await getAllPosts();
  const baseUrl = (site?.toString() || url.origin).replace(/\/$/, "");

  // Дата последнего обновления сайта (по самой свежей статье)
  const latestPostDate = posts[0]?.pubDate
    ? posts[0].pubDate.toISOString()
    : new Date().toISOString();

  // Статические и служебные разделы
  const staticUrls = [
    {
      loc: `${baseUrl}/`,
      lastmod: latestPostDate,
      changefreq: "daily",
      priority: "1.0",
    },
    {
      loc: `${baseUrl}/archive`,
      lastmod: latestPostDate,
      changefreq: "weekly",
      priority: "0.9",
    },
    {
      loc: `${baseUrl}/tags`,
      lastmod: latestPostDate,
      changefreq: "weekly",
      priority: "0.8",
    },
    {
      loc: `${baseUrl}/authors`,
      lastmod: latestPostDate,
      changefreq: "weekly",
      priority: "0.7",
    },
    {
      loc: `${baseUrl}/about`,
      lastmod: latestPostDate,
      changefreq: "monthly",
      priority: "0.6",
    },
    {
      loc: `${baseUrl}/search`,
      lastmod: latestPostDate,
      changefreq: "weekly",
      priority: "0.5",
    },
  ];

  // Страницы рубрик
  const categoryUrls = CATEGORIES.map((slug) => ({
    loc: `${baseUrl}/category/${slug}`,
    lastmod: latestPostDate,
    changefreq: "weekly",
    priority: "0.8",
  }));

  // Динамические страницы статей
  const postUrls = posts.map((post) => ({
    loc: `${baseUrl}/articles/${encodeURIComponent(post.slug)}`,
    lastmod: post.pubDate.toISOString(),
    changefreq: "monthly",
    priority: "0.9",
  }));

  const allUrls = [...staticUrls, ...categoryUrls, ...postUrls];

  const urlsXml = allUrls
    .map(
      (item) => `
  <url>
    <loc>${escapeXml(item.loc)}</loc>
    <lastmod>${item.lastmod}</lastmod>
    <changefreq>${item.changefreq}</changefreq>
    <priority>${item.priority}</priority>
  </url>`,
    )
    .join("");

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlsXml}
</urlset>`;

  return new Response(sitemapXml.trim(), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
