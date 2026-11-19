import type { APIRoute } from "astro";
import rss from "@astrojs/rss";
import pkg from "@/lib/pkg";
import { getRecentPosts } from "@/lib/posts";
import { applyAssetBaseUrlToHtml, toAbsoluteAssetUrl } from "@/lib/assets";

const RSS_MAX_ITEMS = 20;

function makeHtmlImagesAbsolute(html: string, baseSite: string): string {
  const withCdn = applyAssetBaseUrlToHtml(html);
  if (!baseSite) return withCdn;

  return withCdn.replace(
    /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (_full, prefix: string, src: string, suffix: string) => {
      return `${prefix}${toAbsoluteAssetUrl(src, baseSite)}${suffix}`;
    },
  );
}

function guessMimeType(url: string): string {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const GET: APIRoute = async (context) => {
  const latestPosts = await getRecentPosts(RSS_MAX_ITEMS);
  const siteUrl = (context.site ?? new URL(context.request.url)).toString();

  return rss({
    title: pkg.title,
    description: pkg.description,
    site: siteUrl,
    items: latestPosts.map((post) => {
      const link = `/articles/${post.slug}`;
      const imageUrl = toAbsoluteAssetUrl(post.image || post.images?.[0]?.url, siteUrl);
      const fullHtml = makeHtmlImagesAbsolute(post.htmlContent, siteUrl);
      const pubDate =
        post.pubDate instanceof Date && !Number.isNaN(post.pubDate.getTime())
          ? post.pubDate
          : new Date();

      const enclosureXml = imageUrl
        ? `<enclosure url="${escapeXmlAttr(imageUrl)}" type="${guessMimeType(imageUrl)}" length="0" />`
        : "";

      return {
        title: post.title,
        description: post.subtitle || post.plainText.slice(0, 240),
        pubDate,
        link,
        content: fullHtml,
        customData: enclosureXml,
      };
    }),
  });
};
