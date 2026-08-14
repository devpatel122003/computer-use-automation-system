import type { ObservedElement, StateSnapshot } from "../surface/types.js";

export function formatObservation(snapshot: StateSnapshot): string {
  const lines: string[] = [`URL: ${snapshot.url}`, `Title: ${snapshot.title}`, "", "Elements:"];
  for (const el of snapshot.elements) {
    const suffix = el.nth > 0 ? ` (#${el.nth + 1})` : "";
    const value = el.value ? ` value="${el.value}"` : "";
    lines.push(`- [${el.role}] "${el.name}"${suffix}${value}`);
  }
  return lines.join("\n");
}

export function findElement(
  snapshot: StateSnapshot,
  query: { role?: string; name: string; nth?: number }
): ObservedElement | undefined {
  const nth = query.nth ?? 0;
  return snapshot.elements.find(
    (el) => (!query.role || el.role === query.role) && el.name === query.name && el.nth === nth
  );
}
