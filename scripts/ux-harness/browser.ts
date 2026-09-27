/**
 * UX-I: a real Chrome, driven headless, against the local dev server. puppeteer-core (a few MB,
 * no bundled browser download — "keep the download small") launches whatever Chrome or Chromium
 * is already on the machine: GitHub Actions' ubuntu-latest runners ship google-chrome-stable by
 * default, and this dev machine has both google-chrome-stable and chromium. Set
 * PUPPETEER_EXECUTABLE_PATH to point at a different one.
 */
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const CANDIDATE_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p);

export function resolveExecutablePath(): string {
  const found = CANDIDATE_PATHS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "ux-harness: no Chrome or Chromium found. Install one (apt: chromium; brew: google-chrome) " +
      "or set PUPPETEER_EXECUTABLE_PATH. Checked: " + CANDIDATE_PATHS.join(", "),
    );
  }
  return found;
}

export type Viewport = "desktop" | "mobile";
export const VIEWPORTS: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
};

export type Locale = "en" | "it";
export type Theme = "light" | "dark";

export interface Session {
  browser: Browser;
  /** Opens a page pre-authenticated against `baseUrl` with the given viewport, locale and theme
   * already set in localStorage, before the dashboard's own scripts run. */
  newPage(opts: { baseUrl: string; token: string; viewport?: Viewport; locale?: Locale; theme?: Theme }): Promise<Page>;
  close(): Promise<void>;
}

export async function openBrowser(): Promise<Session> {
  const browser = await puppeteer.launch({
    executablePath: resolveExecutablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return {
    browser,
    async newPage({ baseUrl, token, viewport = "desktop", locale = "en", theme = "light" }) {
      const page = await browser.newPage();
      await page.setViewport(VIEWPORTS[viewport]);
      // Set before any dashboard script runs, so the first paint is already authenticated,
      // in the right locale and theme — no flash of the connect screen or the wrong language.
      await page.evaluateOnNewDocument((u: string, t: string, l: string, th: string) => {
        localStorage.setItem("sb_url", u);
        localStorage.setItem("sb_token", t);
        localStorage.setItem("sb-locale", l);
        localStorage.setItem("sb_theme", th);
      }, baseUrl, token, locale, theme);
      return page;
    },
    close: () => browser.close(),
  };
}
