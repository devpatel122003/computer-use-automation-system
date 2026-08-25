import { describe, expect, it } from "vitest";
import { escapeHtml, renderDashboard, type CapabilityView } from "./render.js";
import { CapabilityArtifactSchema } from "../artifact/schema.js";

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert('x')&"y"</script>`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;"
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("Savings, Checking, or CD.")).toBe("Savings, Checking, or CD.");
  });
});

describe("renderDashboard", () => {
  it("escapes free-text artifact fields (name/description/param description) so no raw markup survives", () => {
    const artifact = CapabilityArtifactSchema.parse({
      id: "x",
      name: `Evil <img src=x onerror=alert(1)>`,
      description: `<script>alert(1)</script>`,
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
      inputParams: [{ name: "p", type: "string", required: true, sensitive: false, description: `"><b>bold</b>` }],
      outputSchema: [],
      steps: [],
      successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
      knownOutcomes: [],
    });

    const view: CapabilityView = {
      artifact,
      fingerprint: "deadbeefdeadbeef",
      approvalState: "draft",
      confidence: { totalRuns: 0, successCount: 0, hardFailureCount: 0, score: 0, label: "unproven" },
      drift: [],
      driftRunsMatched: 0,
      discoveryMetrics: null,
      replayMetrics: null,
    };

    const html = renderDashboard([view]);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><b>bold</b>`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
