import type { Checkpoint, LocatorCandidate } from "../artifact/schema.js";
import type { Surface } from "../surface/types.js";

/** Matches a "/a/{param}/*" style template against an actual pathname. */
function matchUrlTemplate(template: string, actualPath: string, paramValues: Record<string, string>): boolean {
  const templateSegs = template.split("/").filter(Boolean);
  const actualSegs = actualPath.split("/").filter(Boolean);
  if (templateSegs.length !== actualSegs.length) return false;

  return templateSegs.every((seg, i) => {
    if (seg === "*") return true;
    const paramMatch = seg.match(/^\{(.+)\}$/);
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
    const currentPath = new URL(surface.currentUrl()).pathname;
    return matchUrlTemplate(checkpoint.expr, currentPath, paramValues);
  }

  if (checkpoint.kind === "text_match") {
    const text = await surface.getVisibleText();
    return text.toLowerCase().includes(checkpoint.expr.toLowerCase());
  }

  if (checkpoint.kind === "element_visible") {
    const candidates = JSON.parse(checkpoint.expr) as LocatorCandidate[];
    const result = await surface.perform({ type: "extract", target: candidates });
    return result.ok;
  }

  return false;
}
