/**
 * Однозначная таблица транслитерации (кириллица -> латиница)
 * Построена так, чтобы ни одна комбинация символов не пересекалась
 * при обратном разборе (жадный поиск от длинных токенов к коротким).
 */
const CYR_TO_LAT: Record<string, string> = {
  // Трёхбуквенные
  щ: "shh",

  // Двухбуквенные (важно: одиночные s, c, z, y, e не должны давать коллизий)
  ё: "jo",
  ж: "zh",
  х: "kh",
  ц: "cz",
  ч: "ch",
  ш: "sh",
  ъ: "xx",
  ы: "y",
  ь: "x",
  э: "eh",
  ю: "ju",
  я: "ja",

  // Однобуквенные
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  з: "z",
  и: "i",
  й: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
};

// Автоматически строим обратный словарь (латиница -> кириллица)
const LAT_TO_CYR: Record<string, string> = Object.fromEntries(
  Object.entries(CYR_TO_LAT).map(([cyr, lat]) => [lat, cyr]),
);

// Сортируем латинские токены по убыванию длины (сначала 'shh', потом 'sh', 'zh' и т.д.)
const SORTED_LAT_TOKENS = Object.keys(LAT_TO_CYR).sort((a, b) => b.length - a.length);

/**
 * Переводит кириллическую строку в URL-безопасный slug.
 * Дефисы внутри слов заменяются на '--', чтобы отличать их от пробелов ('-').
 */
export function toSlug(text: string): string {
  if (!text) return "";

  const normalized = text
    .trim()
    .toLowerCase()
    // Сохраняем дефисы внутри слов как двойной дефис '--'
    .replace(/-/g, "--")
    // Пробелы и разделители превращаем в одиночный дефис '-'
    .replace(/\s+/g, "-");

  let result = "";
  for (const char of normalized) {
    if (CYR_TO_LAT[char] !== undefined) {
      result += CYR_TO_LAT[char];
    } else if (/[a-z0-9-]/.test(char)) {
      result += char;
    }
    // Остальная пунктуация (кавычки, точки, запятые) отбрасывается для чистого URL
  }

  return result.replace(/-{3,}/g, "--").replace(/^-+|-+$/g, "");
}

/**
 * Восстанавливает кириллическую строку из slug.
 * Опция capitalizeFirst делает первую букву заглавной (по умолчанию true).
 */
export function fromSlug(slug: string, capitalizeFirst = true): string {
  if (!slug) return "";

  // Разбиваем по одиночному дефису (пробелы), сохраняя двойные дефисы '--'
  const words = slug
    .toLowerCase()
    .replace(/--/g, "\u0000") // временный маркер для реального дефиса
    .split("-")
    .map((word) => {
      let decoded = "";
      let i = 0;

      while (i < word.length) {
        if (word[i] === "\u0000") {
          decoded += "-";
          i += 1;
          continue;
        }

        let matched = false;
        for (const token of SORTED_LAT_TOKENS) {
          if (word.startsWith(token, i)) {
            decoded += LAT_TO_CYR[token];
            i += token.length;
            matched = true;
            break;
          }
        }

        if (!matched) {
          decoded += word[i];
          i += 1;
        }
      }

      return decoded;
    });

  const sentence = words.join(" ");
  if (!capitalizeFirst || sentence.length === 0) return sentence;

  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
