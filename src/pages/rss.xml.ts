import type { APIRoute } from "astro";
import { getAllPosts } from "@/lib/posts";

// Экранирование спецсимволов для корректного XML
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const GET: APIRoute = async ({ site, url }) => {
  const posts = await getAllPosts();

  // Базовый URL сайта (берется из astro.config.mjs или из текущего запроса)
  const baseUrl = (site?.toString() || url.origin).replace(/\/$/, "");
  const lastBuildDate = posts[0]?.pubDate.toUTCString() || new Date().toUTCString();

  const itemsXml = posts
    .map((post) => {
      const postUrl = `${baseUrl}/articles/${encodeURIComponent(post.slug)}`;
      const pubDate = post.pubDate.toUTCString();

      return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <category>${escapeXml(post.category)}</category>
      <author>${escapeXml(post.author)}</author>
      <description>${escapeXml(post.description)}</description>
      <content:encoded><![CDATA[${post.htmlContent}]]></content:encoded>
    </item>`;
    })
    .join("");

  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>THE Журнал</title>
    <description>Журнал о цифровом ремесле, культуре и медленном чтении</description>
    <link>${baseUrl}/</link>
    <atom:link href="${baseUrl}/rss.xml" rel="self" type="application/rss+xml" />
    <language>ru</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>${itemsXml}
  </channel>
</rss>`;

  return new Response(rssXml.trim(), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
