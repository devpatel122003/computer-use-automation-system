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

  function labelForInput(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const name = el.getAttribute("name");
    if (name) return name.trim();
    return "";
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  const results: Array<{ role: string; name: string; value?: string; testId?: string; cssPath?: string; sensitive?: boolean }> = [];
  const seenTextElements = new Set<Element>();

  // Interactive controls first.
  document.querySelectorAll("a[href], button, input, select, textarea").forEach((el) => {
    if (!isVisible(el)) return;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid") ?? undefined;
    let role = "";
    let name = "";
    let value: string | undefined;
    let sensitive = false;

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
        name = labelForInput(el);
      } else if (type === "radio") {
        role = "radio";
        name = labelForInput(el);
      } else {
        role = "textbox";
        name = labelForInput(el);
        value = (el as HTMLInputElement).value;
        sensitive = type === "password";
      }
    } else if (tag === "select") {
      role = "combobox";
      name = labelForInput(el);
      value = (el as HTMLSelectElement).value;
    } else if (tag === "textarea") {
      role = "textbox";
      name = labelForInput(el);
      value = (el as HTMLTextAreaElement).value;
    }

    if (!name) return;
    results.push({ role, name, value, testId, cssPath: cssPathFor(el), sensitive });
  });

  // Leaf text nodes: elements with direct text and no interactive/text-bearing descendants.
  document.querySelectorAll("td, span, div, p, li, h1, h2, h3, b, font").forEach((el) => {
    if (!isVisible(el)) return;
    const hasElementChildren = Array.from(el.children).length > 0;
    if (hasElementChildren) return;
    const text = (el.textContent ?? "").trim();
    if (!text || text.length > 200) return;
    if (seenTextElements.has(el)) return;
    seenTextElements.add(el);
    const testId = el.getAttribute("data-testid") ?? undefined;
    results.push({ role: "text", name: text, testId, cssPath: cssPathFor(el) });
  });

  return results;
}
