import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site, url }) => {
  const baseUrl = (site?.toString() || url.origin).replace(/\/$/, "");

  const content = `User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
`;

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};
