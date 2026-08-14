/**
 * The Surface is the boundary between "how we perceive/act on a UI" and everything
 * above it (agent loop, replay engine, escalation). A browser/Playwright implementation
 * is provided; a legacy-web or desktop implementation would satisfy the same interface
 * (see REPORT.md "Heterogeneity & multi-tenant").
 */

export type ElementRole = "button" | "link" | "textbox" | "combobox" | "checkbox" | "radio" | "text";

export type LocatorStrategy = "test_id" | "role" | "text" | "css_structural";

/** A single candidate way to relocate an element, ordered most -> least robust. */
export interface LocatorCandidate {
  strategy: LocatorStrategy;
  role?: ElementRole;
  name?: string;
  testId?: string;
  cssPath?: string;
  nth: number;
  /** why this candidate was proposed / how robust it's expected to be, for artifact review */
  confidence: "high" | "medium" | "low";
  rationale: string;
}

/** An element as perceived during observe(), carrying its own locator chain. */
export interface ObservedElement {
  role: ElementRole;
  name: string;
  value?: string;
  /** index among elements sharing the same (role, name), for disambiguation -- 0-based */
  nth: number;
  locatorCandidates: LocatorCandidate[];
  /** e.g. a password field -- callers must never log its value in cleartext. */
  sensitive?: boolean;
}

export interface StateSnapshot {
  url: string;
  title: string;
  elements: ObservedElement[];
  screenshotPath: string;
}

export type Action =
  | { type: "navigate"; url: string }
  | { type: "click"; target: LocatorCandidate[] }
  | { type: "type"; target: LocatorCandidate[]; text: string }
  | { type: "select_option"; target: LocatorCandidate[]; option: string }
  | { type: "extract"; target: LocatorCandidate[] }
  | { type: "wait"; ms: number };

export interface ActionResult {
  ok: boolean;
  error?: string;
  matchedStrategy?: LocatorStrategy;
  extractedValue?: string;
  url: string;
}

export interface PredictedNavigation {
  url: string;
  method: "GET" | "POST";
}

export interface Surface {
  observe(): Promise<StateSnapshot>;
  perform(action: Action): Promise<ActionResult>;
  /** Read-only: where would this action navigate to, without performing it? Used by guardrails. */
  predictNavigation(action: Action): Promise<PredictedNavigation | null>;
  /** All visible text on the current page -- used by known-outcome / checkpoint text_match detectors. */
  getVisibleText(): Promise<string>;
  screenshot(label: string): Promise<string>;
  currentUrl(): string;
  close(): Promise<void>;
}
