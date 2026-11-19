const RAW_ASSETS_BASE_URL =
  import.meta.env.PUBLIC_ASSETS_BASE_URL ||
  process.env.PUBLIC_ASSETS_BASE_URL ||
  "";

export function getAssetsBaseUrl(): string {
  return RAW_ASSETS_BASE_URL.trim().replace(/\/+$/, "");
}

export function resolveAssetUrl(url: string | undefined | null): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";

  // Внешние ссылки, protocol-relative и data URI оставляем как есть
  if (/^(https?:\/\/|\/\/|data:|blob:)/i.test(trimmed)) {
    return trimmed;
  }

  const normalizedPath = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const baseUrl = getAssetsBaseUrl();

  if (!baseUrl) {
    return normalizedPath;
  }

  return `${baseUrl}${normalizedPath}`;
}

/**
 * Подставляет префикс CDN в src тегов <img> внутри уже готового HTML статьи
 */
export function applyAssetBaseUrlToHtml(html: string): string {
  const baseUrl = getAssetsBaseUrl();
  if (!baseUrl || !html) return html;

  return html.replace(
    /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (_full, prefix: string, src: string, suffix: string) => {
      return `${prefix}${resolveAssetUrl(src)}${suffix}`;
    },
  );
}

export function toAbsoluteAssetUrl(
  url: string | undefined | null,
  site?: URL | string | null,
): string {
  const resolved = resolveAssetUrl(url);
  if (!resolved) return "";

  // Уже абсолютный URL или data/blob URI
  if (/^(https?:\/\/|data:|blob:)/i.test(resolved)) {
    return resolved;
  }

  if (resolved.startsWith("//")) {
    const protocol = site instanceof URL ? site.protocol : "https:";
    return `${protocol}${resolved}`;
  }

  const baseSite =
    site instanceof URL
      ? site.toString()
      : typeof site === "string" && site.trim()
        ? site.trim()
        : import.meta.env.SITE || process.env.SITE || "";

  if (!baseSite) {
    return resolved;
  }

  try {
    return new URL(resolved, baseSite).toString();
  } catch {
    return `${baseSite.replace(/\/+$/, "")}/${resolved.replace(/^\/+/, "")}`;
  }
}
