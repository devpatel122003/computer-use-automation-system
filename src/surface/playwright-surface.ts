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

interface LocatorCandidateInputs {
  role: string;
  name: string;
  testId?: string;
  cssPath?: string;
  /** nth within elements sharing this exact (role, name) -- for the "role" strategy. */
  roleNameNth: number;
  isUniqueRoleName: boolean;
  /** nth within ALL elements sharing this exact name regardless of role -- for the "text"
   *  strategy, since `page.getByText()` matches across roles. Reusing the role-scoped nth
   *  here would pick the wrong element whenever the same name appears under >1 role. */
  nameOnlyNth: number;
  /** nth within elements sharing this exact testId -- test ids are normally unique, but
   *  don't assume it. */
  testIdNth: number;
  /** True when `name` came from `dom-scan.ts`'s last-resort raw `name`-ATTRIBUTE fallback,
   *  not a real accessible-name source. Found live, adapting to a target with no `<label>`
   *  elements at all: a "role" candidate built from this name can never resolve via
   *  Playwright's real `getByRole()` (the `name` attribute isn't part of any browser's
   *  accessible-name computation), and a "text" candidate built from it can't resolve via
   *  `getByText()` either (the attribute value was never rendered as visible page text) --
   *  both would PERMANENTLY fall through to css_structural on every single replay, which
   *  `drift-report` would then flag as "drifting" forever for a target that was simply
   *  never going to resolve any other way, not because anything actually changed. */
  nameFromAttributeFallback?: boolean;
}

function buildLocatorCandidates(inputs: LocatorCandidateInputs): LocatorCandidate[] {
  const { role, name, testId, cssPath, roleNameNth, isUniqueRoleName, nameOnlyNth, testIdNth, nameFromAttributeFallback } = inputs;
  const candidates: LocatorCandidate[] = [];

  if (testId) {
    candidates.push({
      strategy: "test_id",
      testId,
      nth: testIdNth,
      confidence: "high",
      rationale: "Explicit data-testid present on the element -- the most stable identifier available.",
    });
  }

  if (VALID_ARIA_ROLES.has(role) && !nameFromAttributeFallback) {
    candidates.push({
      strategy: "role",
      role: role as ElementRole,
      name,
      nth: roleNameNth,
      confidence: isUniqueRoleName ? "high" : "medium",
      rationale: isUniqueRoleName
        ? "Accessible role + name uniquely identifies this control, independent of markup/CSS."
        : "Accessible role + name matches multiple elements; disambiguated by position (nth).",
    });
  }

  if (!nameFromAttributeFallback) {
    candidates.push({
      strategy: "text",
      name,
      nth: nameOnlyNth,
      confidence: "medium",
      rationale: "Exact visible text match; stable as long as copy doesn't change.",
    });
  }

  if (cssPath) {
    candidates.push({
      strategy: "css_structural",
      cssPath,
      nth: 0,
      confidence: nameFromAttributeFallback ? "medium" : "low",
      rationale: nameFromAttributeFallback
        ? "No real accessible name or visible text available for this control (a raw HTML `name` attribute is neither) -- structural position is the only strategy that can ever resolve it, not a last-ditch fallback below better options."
        : "Structural DOM position fallback; brittle to markup reordering, used only if the above fail.",
    });
  }

  return candidates;
}

export class PlaywrightSurface implements Surface {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private stepCounter = 0;
  /** The most recent main-frame navigation response status -- reset at the start of each
   *  `perform()` call and read back at the end, so it's only ever attributed to the action
   *  that actually caused it (see `ActionResult.httpStatus`'s own doc comment). */
  private lastResponseStatus?: number;

  constructor(private readonly options: PlaywrightSurfaceOptions) {
    fs.mkdirSync(options.evidenceDir, { recursive: true });
  }

  async launch(startUrl: string): Promise<void> {
    this.browser = await chromium.launch({ headless: this.options.headed === false });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === this.page?.mainFrame()) {
        this.lastResponseStatus = response.status();
      }
    });
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
    const raw = (await this.withNavigationRaceRetry(() => page.evaluate(shimmedSource))) as ReturnType<typeof scanPage>;

    const roleNameSeen = new Map<string, number>();
    const roleNameTotals = new Map<string, number>();
    const nameOnlySeen = new Map<string, number>();
    const testIdSeen = new Map<string, number>();
    for (const el of raw) {
      const key = `${el.role}::${el.name}`;
      roleNameTotals.set(key, (roleNameTotals.get(key) ?? 0) + 1);
    }

    const elements: ObservedElement[] = raw.map((el) => {
      const roleNameKey = `${el.role}::${el.name}`;
      const roleNameNth = roleNameSeen.get(roleNameKey) ?? 0;
      roleNameSeen.set(roleNameKey, roleNameNth + 1);

      const nameOnlyNth = nameOnlySeen.get(el.name) ?? 0;
      nameOnlySeen.set(el.name, nameOnlyNth + 1);

      const testIdNth = el.testId ? (testIdSeen.get(el.testId) ?? 0) : 0;
      if (el.testId) testIdSeen.set(el.testId, testIdNth + 1);

      const isUnique = (roleNameTotals.get(roleNameKey) ?? 1) === 1;
      return {
        role: el.role as ElementRole,
        name: el.name,
        value: el.value,
        nth: roleNameNth,
        locatorCandidates: buildLocatorCandidates({
          role: el.role,
          name: el.name,
          testId: el.testId,
          cssPath: el.cssPath,
          roleNameNth,
          isUniqueRoleName: isUnique,
          nameOnlyNth,
          testIdNth,
          nameFromAttributeFallback: el.nameFromAttributeFallback,
        }),
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
    const nthLocator = locator.nth(candidate.nth);
    // Reject invisible matches rather than treating "found in the DOM" as "found": a
    // display:none element with a coincidentally-matching name/testId shouldn't satisfy an
    // `element_visible` checkpoint (which resolves via this same path), and preferring a
    // visible fallback candidate over an invisible higher-priority one is strictly safer.
    const visible = await nthLocator.isVisible().catch(() => false);
    if (!visible) return null;
    return nthLocator;
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
  async predictNavigation(action: Action): Promise<PredictedNavigation | null | undefined> {
    const page = this.getPage();

    if (action.type === "navigate") {
      return { url: new URL(action.url, page.url()).toString(), method: "GET" };
    }
    if (action.type !== "click") {
      return undefined;
    }

    const resolved = await this.resolve(action.target);
    // Element doesn't exist on the page at all (e.g. this step's target is only rendered
    // on the happy path, and we're on a permission-denied/error variant of the page) --
    // that's not an authorization question, it's `perform()` about to fail on its own,
    // which the caller's normal known-outcome detection handles.
    if (!resolved) return undefined;

    const info = await this.withNavigationRaceRetry(() =>
      resolved.locator.evaluate((el) => {
        // Check anchor FIRST: a real <a href> click navigates via its href regardless of
        // whether it happens to sit inside a <form> -- forms don't intercept anchor clicks.
        // Checking form first (the previous order) would predict the wrong destination for
        // any off-allowlist link that happens to be nested inside a form.
        const anchor = el.closest("a[href]");
        if (anchor) {
          return { method: "GET", action: anchor.getAttribute("href") ?? "" };
        }
        const form = el.closest("form");
        if (form) {
          const method = (form.getAttribute("method") ?? "GET").toUpperCase();
          const action = form.getAttribute("action") ?? "";
          return { method, action };
        }
        return null;
      })
    );
    if (!info) return null;

    return {
      url: new URL(info.action, page.url()).toString(),
      method: info.method === "POST" ? "POST" : "GET",
    };
  }

  async perform(action: Action): Promise<ActionResult> {
    const page = this.getPage();
    // Reset first so httpStatus, if set below, is unambiguously attributable to whatever
    // navigation THIS action causes -- not a stale value left over from an earlier step.
    this.lastResponseStatus = undefined;
    try {
      if (action.type === "navigate") {
        await page.goto(action.url, { waitUntil: "load" });
        return { ok: true, url: page.url(), httpStatus: this.lastResponseStatus };
      }

      if (action.type === "click_coordinates") {
        await page.mouse.click(action.x, action.y);
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
        // No `matchedStrategy`: a coordinate click never consults a recorded
        // LocatorCandidate at all, so there's no strategy tier to report.
        return { ok: true, url: page.url(), httpStatus: this.lastResponseStatus };
      }

      const resolved = await this.resolve(action.target);
      if (!resolved) {
        return { ok: false, error: "No locator candidate resolved to an element.", url: page.url() };
      }
      const { locator, strategyUsed } = resolved;

      if (action.type === "click") {
        await locator.click({ timeout: action.timeoutMs ?? 5000 });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
        return { ok: true, matchedStrategy: strategyUsed, url: page.url(), httpStatus: this.lastResponseStatus };
      }

      if (action.type === "type") {
        await locator.fill(action.text, { timeout: action.timeoutMs ?? 5000 });
        return { ok: true, matchedStrategy: strategyUsed, url: page.url() };
      }

      if (action.type === "select_option") {
        await locator.selectOption(action.option, { timeout: action.timeoutMs ?? 5000 });
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
      return { ok: false, error: err instanceof Error ? err.message : String(err), url: page.url(), httpStatus: this.lastResponseStatus };
    }
  }

  /** Retries an evaluate-style callback once, after waiting for the page's own load state to
   *  settle, on this one specific known-transient Playwright race: `page.evaluate` (or a
   *  locator's own `.evaluate`) running while a navigation is still destroying the JS
   *  execution context it's mid-flight in, throwing "Execution context was destroyed, most
   *  likely because of a navigation." First found live via `getVisibleText()` (checkpoint/
   *  known-outcome detection's hot path, called after nearly every action) against MERIDIAN
   *  -- a real, network-latency-bound external target, unlike mock-bank's local single-hop
   *  navigations -- where it turned an ordinary transient timing hiccup into an immediate
   *  "Couldn't even start" failure for the whole run instead of the wait-and-retry treatment
   *  this exact class of condition is supposed to get elsewhere in this system. Shared here
   *  rather than copy-pasted at each of this file's three real `.evaluate()` call sites. Only
   *  ever retries once: a second real failure still throws, not silently swallowed or looped. */
  private async withNavigationRaceRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/Execution context was destroyed/.test(message)) throw err;
      await this.getPage()
        .waitForLoadState("load", { timeout: 5000 })
        .catch(() => undefined);
      return run();
    }
  }

  async getVisibleText(): Promise<string> {
    const page = this.getPage();
    return this.withNavigationRaceRetry(() => page.evaluate(() => document.body.innerText));
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
