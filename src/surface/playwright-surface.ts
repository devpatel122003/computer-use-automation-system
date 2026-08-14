import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { scanPage } from "./dom-scan.js";
import type {
  Action,
  ActionResult,
  ElementRole,
  LocatorCandidate,
  ObservedElement,
  PredictedNavigation,
  StateSnapshot,
  Surface,
} from "./types.js";

export interface PlaywrightSurfaceOptions {
  /** Directory to write screenshots into (created if missing). */
  evidenceDir: string;
  /** Run headed so a human can literally take the wheel during escalation. Defaults to true. */
  headed?: boolean;
}

const VALID_ARIA_ROLES = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio"]);

/** Escapes a value for use inside a CSS attribute selector, e.g. [data-testid="..."]. */
function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildLocatorCandidates(
  role: string,
  name: string,
  testId: string | undefined,
  cssPath: string | undefined,
  nth: number,
  isUniqueRoleName: boolean
): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];

  if (testId) {
    candidates.push({
      strategy: "test_id",
      testId,
      nth: 0,
      confidence: "high",
      rationale: "Explicit data-testid present on the element -- the most stable identifier available.",
    });
  }

  if (VALID_ARIA_ROLES.has(role)) {
    candidates.push({
      strategy: "role",
      role: role as ElementRole,
      name,
      nth,
      confidence: isUniqueRoleName ? "high" : "medium",
      rationale: isUniqueRoleName
        ? "Accessible role + name uniquely identifies this control, independent of markup/CSS."
        : "Accessible role + name matches multiple elements; disambiguated by position (nth).",
    });
  }

  candidates.push({
    strategy: "text",
    name,
    nth,
    confidence: "medium",
    rationale: "Exact visible text match; stable as long as copy doesn't change.",
  });

  if (cssPath) {
    candidates.push({
      strategy: "css_structural",
      cssPath,
      nth: 0,
      confidence: "low",
      rationale: "Structural DOM position fallback; brittle to markup reordering, used only if the above fail.",
    });
  }

  return candidates;
}

export class PlaywrightSurface implements Surface {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private stepCounter = 0;

  constructor(private readonly options: PlaywrightSurfaceOptions) {
    fs.mkdirSync(options.evidenceDir, { recursive: true });
  }

  async launch(startUrl: string): Promise<void> {
    this.browser = await chromium.launch({ headless: this.options.headed === false });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.goto(startUrl, { waitUntil: "load" });
  }

  /** Exposes the live page so the escalation module can hand the same session to a human. */
  getPage(): Page {
    if (!this.page) throw new Error("Surface not launched yet");
    return this.page;
  }

  currentUrl(): string {
    return this.page?.url() ?? "";
  }

  async observe(): Promise<StateSnapshot> {
    const page = this.getPage();
    // tsx/esbuild wraps named functions in a __name(fn, "label") helper for stack traces;
    // Playwright serializes only scanPage's own source via toString(), not that helper, so
    // a plain `page.evaluate(scanPage)` throws "__name is not defined" in the browser. Shim
    // it locally as a passthrough when evaluating the function as a source string instead.
    const shimmedSource = `(() => { const __name = (fn) => fn; return (${scanPage.toString()})(); })()`;
    const raw = (await page.evaluate(shimmedSource)) as ReturnType<typeof scanPage>;

    const seenKeyCounts = new Map<string, number>();
    const keyTotals = new Map<string, number>();
    for (const el of raw) {
      const key = `${el.role}::${el.name}`;
      keyTotals.set(key, (keyTotals.get(key) ?? 0) + 1);
    }

    const elements: ObservedElement[] = raw.map((el) => {
      const key = `${el.role}::${el.name}`;
      const nth = seenKeyCounts.get(key) ?? 0;
      seenKeyCounts.set(key, nth + 1);
      const isUnique = (keyTotals.get(key) ?? 1) === 1;
      return {
        role: el.role as ElementRole,
        name: el.name,
        value: el.value,
        nth,
        locatorCandidates: buildLocatorCandidates(el.role, el.name, el.testId, el.cssPath, nth, isUnique),
        sensitive: el.sensitive,
      };
    });

    const screenshotPath = await this.screenshot("observe");
    return { url: page.url(), title: await page.title(), elements, screenshotPath };
  }

  private async resolveCandidate(candidate: LocatorCandidate): Promise<Locator | null> {
    const page = this.getPage();
    let locator: Locator | null = null;

    if (candidate.strategy === "test_id" && candidate.testId) {
      locator = page.locator(`[data-testid="${escapeAttrValue(candidate.testId)}"]`);
    } else if (candidate.strategy === "role" && candidate.role) {
      locator = page.getByRole(candidate.role as Parameters<Page["getByRole"]>[0], {
        name: candidate.name,
        exact: true,
      });
    } else if (candidate.strategy === "text" && candidate.name) {
      locator = page.getByText(candidate.name, { exact: true });
    } else if (candidate.strategy === "css_structural" && candidate.cssPath) {
      locator = page.locator(candidate.cssPath);
    }

    if (!locator) return null;
    const count = await locator.count().catch(() => 0);
    if (count <= candidate.nth) return null;
    return locator.nth(candidate.nth);
  }

  /** Tries each locator candidate in order (most -> least robust); reports which one matched. */
  private async resolve(
    candidates: LocatorCandidate[]
  ): Promise<{ locator: Locator; strategyUsed: LocatorCandidate["strategy"] } | null> {
    for (const candidate of candidates) {
      const locator = await this.resolveCandidate(candidate);
      if (locator) return { locator, strategyUsed: candidate.strategy };
    }
    return null;
  }

  /** Resolves where a click/navigate would go, without performing it -- used by guardrails. */
  async predictNavigation(action: Action): Promise<PredictedNavigation | null> {
    const page = this.getPage();

    if (action.type === "navigate") {
      return { url: new URL(action.url, page.url()).toString(), method: "GET" };
    }
    if (action.type !== "click") {
      return null;
    }

    const resolved = await this.resolve(action.target);
    if (!resolved) return null;

    const info = await resolved.locator.evaluate((el) => {
      const form = el.closest("form");
      if (form) {
        const method = (form.getAttribute("method") ?? "GET").toUpperCase();
        const action = form.getAttribute("action") ?? "";
        return { method, action };
      }
      const anchor = el.closest("a[href]");
      if (anchor) {
        return { method: "GET", action: anchor.getAttribute("href") ?? "" };
      }
      return null;
    });
    if (!info) return null;

    return {
      url: new URL(info.action, page.url()).toString(),
      method: info.method === "POST" ? "POST" : "GET",
    };
  }

  async perform(action: Action): Promise<ActionResult> {
    const page = this.getPage();
    try {
      if (action.type === "navigate") {
        await page.goto(action.url, { waitUntil: "load" });
        return { ok: true, url: page.url() };
      }

      if (action.type === "wait") {
        await page.waitForTimeout(action.ms);
        return { ok: true, url: page.url() };
      }

      const resolved = await this.resolve(action.target);
      if (!resolved) {
        return { ok: false, error: "No locator candidate resolved to an element.", url: page.url() };
      }
      const { locator, strategyUsed } = resolved;

      if (action.type === "click") {
        await locator.click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
        return { ok: true, matchedStrategy: strategyUsed, url: page.url() };
      }

      if (action.type === "type") {
        await locator.fill(action.text, { timeout: 5000 });
        return { ok: true, matchedStrategy: strategyUsed, url: page.url() };
      }

      if (action.type === "select_option") {
        await locator.selectOption(action.option, { timeout: 5000 });
        return { ok: true, matchedStrategy: strategyUsed, url: page.url() };
      }

      if (action.type === "extract") {
        const tagName = await locator.evaluate((el) => el.tagName.toLowerCase());
        const value =
          tagName === "input" || tagName === "select" || tagName === "textarea"
            ? await locator.inputValue()
            : ((await locator.textContent()) ?? "").trim();
        return { ok: true, matchedStrategy: strategyUsed, extractedValue: value, url: page.url() };
      }

      return { ok: false, error: `Unhandled action type: ${(action as Action).type}`, url: page.url() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), url: page.url() };
    }
  }

  async getVisibleText(): Promise<string> {
    const page = this.getPage();
    return page.evaluate(() => document.body.innerText);
  }

  async screenshot(label: string): Promise<string> {
    const page = this.getPage();
    this.stepCounter += 1;
    const filename = `${String(this.stepCounter).padStart(3, "0")}-${label}.png`;
    const filePath = path.join(this.options.evidenceDir, filename);
    await page.screenshot({ path: filePath }).catch(() => undefined);
    return filePath;
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}
