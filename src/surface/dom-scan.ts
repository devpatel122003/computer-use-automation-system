/**
 * Runs inside the page via page.evaluate(). Must be self-contained (no closures over
 * outer-scope variables) since Playwright serializes the function body to the browser.
 *
 * Produces a flattened, role-based view of the page that stands in for an accessibility
 * tree: interactive controls (button/link/textbox/combobox/checkbox/radio) plus leaf text
 * nodes worth reading (for extraction / error-banner detection). This is deliberately
 * DOM-shape-agnostic -- it does not depend on CSS classes or test IDs, which legacy
 * enterprise UIs essentially never have.
 */
export function scanPage(): Array<{
  role: string;
  name: string;
  value?: string;
  testId?: string;
  cssPath?: string;
  sensitive?: boolean;
  /** True when `name` came from this element's raw HTML `name` ATTRIBUTE (the last-resort
   *  fallback in `labelForInput`), as opposed to a real accessible-name source
   *  (`<label for>`, `aria-label`, or `placeholder`). Found live, adapting to a target with
   *  no `<label>` elements at all: the `name` attribute is never part of any browser's real
   *  accessible-name computation, so a "role" locator candidate built from it can never
   *  actually resolve via Playwright's `getByRole()` at replay time -- it would silently and
   *  PERMANENTLY fall back to a lower-confidence strategy on every single replay, not
   *  because anything changed, but because that candidate was never viable to begin with.
   *  `buildLocatorCandidates` (playwright-surface.ts) uses this to skip emitting a "role"
   *  candidate it already knows can't resolve, instead of recording one that drift-report
   *  would then flag as "drifting" forever for a target whose markup was always like this. */
  nameFromAttributeFallback?: boolean;
}> {
  function cssPathFor(el: Element): string {
    const segments: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node.id) {
        segments.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (!parent) {
        segments.unshift(node.tagName.toLowerCase());
        break;
      }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const index = siblings.indexOf(node) + 1;
      segments.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
      if (node.tagName === "BODY") {
        segments.unshift("body");
        break;
      }
    }
    return segments.join(" > ");
  }

  function labelForInput(el: Element): { name: string; fromAttributeFallback: boolean } {
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && label.textContent) return { name: label.textContent.trim(), fromAttributeFallback: false };
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return { name: ariaLabel.trim(), fromAttributeFallback: false };
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return { name: placeholder.trim(), fromAttributeFallback: false };
    // Last resort only: the `name` ATTRIBUTE is never part of any real accessible-name
    // computation, so a caller resolving this element by (role, name) via a real browser's
    // own accessibility APIs (not this scan) will never find it. Still returned -- it's the
    // only identifying text available on a target with no label/aria-label/placeholder at
    // all -- but flagged so a "role" locator candidate is never built from it.
    const name = el.getAttribute("name");
    if (name) return { name: name.trim(), fromAttributeFallback: true };
    return { name: "", fromAttributeFallback: false };
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // Tags that only ever carry inline formatting (bold/italic/font color/etc.) -- absorbed
  // into whichever block/cell ancestor wraps them, never queried as leaves in their own
  // right. Without this, `<font><b>Access denied.</b> the rest of the message</font>`
  // (real markup in this app's error banners) yields only "Access denied." -- the `<b>`
  // text -- because the container has an element child and gets skipped outright.
  const INLINE_ABSORB_TAGS = new Set(["b", "font", "strong", "em", "i", "tt", "u", "sub", "sup"]);

  function isInlineOnlyContent(el: Element): boolean {
    for (const child of Array.from(el.children)) {
      if (!INLINE_ABSORB_TAGS.has(child.tagName.toLowerCase())) return false;
      if (!isInlineOnlyContent(child)) return false;
    }
    return true;
  }

  const results: Array<{
    role: string;
    name: string;
    value?: string;
    testId?: string;
    cssPath?: string;
    sensitive?: boolean;
    nameFromAttributeFallback?: boolean;
  }> = [];

  // Interactive controls first.
  document.querySelectorAll("a[href], button, input, select, textarea").forEach((el) => {
    if (!isVisible(el)) return;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid") ?? undefined;
    let role = "";
    let name = "";
    let value: string | undefined;
    let sensitive = false;
    let nameFromAttributeFallback = false;

    if (tag === "a") {
      role = "link";
      name = (el.textContent ?? "").trim();
    } else if (tag === "button") {
      role = "button";
      name = (el.textContent ?? "").trim();
    } else if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button") {
        role = "button";
        name = el.getAttribute("value") ?? (el.textContent ?? "").trim();
      } else if (type === "checkbox") {
        role = "checkbox";
        ({ name, fromAttributeFallback: nameFromAttributeFallback } = labelForInput(el));
      } else if (type === "radio") {
        role = "radio";
        ({ name, fromAttributeFallback: nameFromAttributeFallback } = labelForInput(el));
      } else {
        role = "textbox";
        ({ name, fromAttributeFallback: nameFromAttributeFallback } = labelForInput(el));
        value = (el as HTMLInputElement).value;
        sensitive = type === "password";
      }
    } else if (tag === "select") {
      role = "combobox";
      ({ name, fromAttributeFallback: nameFromAttributeFallback } = labelForInput(el));
      value = (el as HTMLSelectElement).value;
    } else if (tag === "textarea") {
      role = "textbox";
      ({ name, fromAttributeFallback: nameFromAttributeFallback } = labelForInput(el));
      value = (el as HTMLTextAreaElement).value;
    }

    if (!name) return;
    results.push({ role, name, value, testId, cssPath: cssPathFor(el), sensitive, nameFromAttributeFallback });
  });

  // Leaf text nodes: elements whose content is plain text or inline-only formatting (no
  // block/structural children -- that would make this a container, not a leaf).
  document.querySelectorAll("td, th, span, div, p, li, h1, h2, h3, h4, h5, label, small, option").forEach((el) => {
    if (!isVisible(el)) return;
    if (!isInlineOnlyContent(el)) return;
    const text = (el.textContent ?? "").trim();
    if (!text || text.length > 200) return;
    const testId = el.getAttribute("data-testid") ?? undefined;
    results.push({ role: "text", name: text, testId, cssPath: cssPathFor(el) });
  });

  return results;
}
