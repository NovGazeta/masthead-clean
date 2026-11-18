import { test, expect } from "@playwright/test";
import pkg from "../../src/lib/pkg";

test.describe("The Masthead E2E Tests", () => {
  test("Главная страница открывается и содержит логотип", async ({ page }) => {
    await page.goto("/");

    // Проверяем заголовок/логотип издания
    const logo = page.locator(".logo");
    await expect(logo).toBeVisible();
    await expect(logo).toHaveText(pkg.title);
  });

  test("Переключатель темы меняет атрибут data-theme и сохраняет в localStorage", async ({
    page,
  }) => {
    await page.goto("/");

    // Проверяем начальное состояние (по умолчанию или светлая)
    const html = page.locator("html");

    // Находим кнопку смены темы в шапке
    const themeBtn = page.locator("#theme-toggle");
    await expect(themeBtn).toBeVisible();

    const initialTheme = await html.getAttribute("data-theme");

    // Кликаем по кнопке смены темы
    await themeBtn.click();

    // Проверяем, что тема сменилась
    const newTheme = await html.getAttribute("data-theme");
    expect(newTheme).not.toBe(initialTheme);

    // Проверяем сохранение в localStorage
    const storedTheme = await page.evaluate(() => localStorage.getItem("theme"));
    expect(storedTheme).toBe(newTheme);
  });

  test("Форма поиска перенаправляет на ЧПУ URL вида /search/...", async ({ page }) => {
    await page.goto("/search");

    const searchInput = page.locator("#search-input");
    await expect(searchInput).toBeVisible();

    // Вводим поисковый запрос
    await searchInput.fill("тест");

    // Отправляем форму (нажатием Enter или кнопкой)
    await page.locator('#search-form button[type="submit"]').click();

    // Проверяем, что урл изменился на ЧПУ формат /search/тест
    await expect(page).toHaveURL(/\/search\/%D1%82%D0%B5%D1%81%D1%82/);
  });

  test("Ссылка GitHub в шапке ведет на репозиторий", async ({ page }) => {
    await page.goto("/");

    const githubLink = page.locator(".github-link");
    await expect(githubLink).toBeVisible();
    await expect(githubLink).toHaveAttribute("href", /github\.com/);
  });
});
