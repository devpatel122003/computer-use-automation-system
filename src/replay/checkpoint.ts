import type { Checkpoint, LocatorCandidate } from "../artifact/schema.js";
import type { Surface } from "../surface/types.js";

/** Matches a "/a/{param}/*" style template against an actual path (optionally "path?query"
 *  if the template itself includes a "?", otherwise the query string is ignored). Segment
 *  values are percent-decoded before comparing against paramValues, which are raw. */
function matchUrlTemplate(template: string, actualPathAndQuery: string, paramValues: Record<string, string>): boolean {
  const [templatePath, templateQuery] = template.split("?");
  const [actualPath, actualQuery] = actualPathAndQuery.split("?");

  if (templateQuery !== undefined && templateQuery !== (actualQuery ?? "")) return false;

  const templateSegs = (templatePath ?? "").split("/").filter(Boolean);
  const actualSegs = (actualPath ?? "")
    .split("/")
    .filter(Boolean)
    .map((seg) => decodeURIComponent(seg));
  if (templateSegs.length !== actualSegs.length) return false;

  return templateSegs.every((seg, i) => {
    if (seg === "*") return true;
    const paramMatch = seg.match(/^\{(.+?)\}$/);
    if (paramMatch) {
      const paramName = paramMatch[1] as string;
      return actualSegs[i] === paramValues[paramName];
    }
    return seg === actualSegs[i];
  });
}

export async function evaluateCheckpoint(
  surface: Surface,
  checkpoint: Checkpoint,
  paramValues: Record<string, string>
): Promise<boolean> {
  if (checkpoint.kind === "url") {
    const currentUrl = surface.currentUrl();
    if (!currentUrl) return false;
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return false;
    }
    return matchUrlTemplate(checkpoint.expr, `${parsed.pathname}${parsed.search}`, paramValues);
  }

  if (checkpoint.kind === "text_match") {
    const text = await surface.getVisibleText();
    return text.toLowerCase().includes(checkpoint.expr.toLowerCase());
  }

  if (checkpoint.kind === "element_visible") {
    let candidates: LocatorCandidate[];
    try {
      candidates = JSON.parse(checkpoint.expr) as LocatorCandidate[];
    } catch {
      // A malformed checkpoint expression is a configuration bug, not a runtime page
      // state -- report it as "checkpoint didn't pass" rather than crashing the whole
      // replay, so the caller gets a normal failure result with debug context instead of
      // an uncaught exception.
      return false;
    }
    const result = await surface.perform({ type: "extract", target: candidates });
    return result.ok;
  }

  return false;
}
