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
      driftAdjustedLabel: "unproven",
      tenantVariants: [
        {
          tenantId: `"><script>alert(2)</script>`,
          artifact,
          fingerprint: "cafebabecafebabe",
          approvalState: "draft",
          confidence: { totalRuns: 0, successCount: 0, hardFailureCount: 0, score: 0, label: "unproven" },
          drift: [],
        },
      ],
      discoveryMetrics: null,
      replayMetrics: null,
    };

    const html = renderDashboard([view]);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><b>bold</b>`);
    expect(html).not.toContain(`"><script>alert(2)</script>`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows a drift-capped badge only when the drift-adjusted label actually differs from the raw one", () => {
    const artifact = CapabilityArtifactSchema.parse({
      id: "x",
      name: "Cap Test",
      description: "d",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
      inputParams: [],
      outputSchema: [],
      steps: [],
      successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
      knownOutcomes: [],
    });
    const baseView: CapabilityView = {
      artifact,
      fingerprint: "deadbeefdeadbeef",
      approvalState: "approved",
      confidence: { totalRuns: 5, successCount: 5, hardFailureCount: 0, score: 1, label: "high" },
      drift: [],
      driftRunsMatched: 5,
      driftAdjustedLabel: "high",
      tenantVariants: [],
      discoveryMetrics: null,
      replayMetrics: null,
    };

    expect(renderDashboard([baseView])).not.toContain("drift-capped");
    expect(renderDashboard([{ ...baseView, driftAdjustedLabel: "medium" }])).toContain("drift-capped to medium");
  });

  it("renders a cross-tenant drift comparison only once at least one tenant variant exists, covering every step seen across base+variants", () => {
    const artifact = CapabilityArtifactSchema.parse({
      id: "x",
      name: "Cap Test",
      description: "d",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      target: { appId: "mock-bank", surfaceType: "web", baseUrlPattern: "http://localhost:4000" },
      inputParams: [],
      outputSchema: [],
      steps: [],
      successCheckpoint: { kind: "text_match", expr: "done", description: "d" },
      knownOutcomes: [],
    });
    const baseDrift = [
      { stepId: "step-4", description: 'Click "Sign On"', actionType: "click" as const, expectedStrategy: "role" as const, observedCounts: { role: 5 }, totalObservations: 5, driftCount: 0 },
    ];
    const viewNoVariants: CapabilityView = {
      artifact,
      fingerprint: "fp-base",
      approvalState: "approved",
      confidence: { totalRuns: 5, successCount: 5, hardFailureCount: 0, score: 1, label: "high" },
      drift: baseDrift,
      driftRunsMatched: 5,
      driftAdjustedLabel: "high",
      tenantVariants: [],
      discoveryMetrics: null,
      replayMetrics: null,
    };
    expect(renderDashboard([viewNoVariants])).not.toContain("Cross-tenant drift comparison");

    const viewWithVariant: CapabilityView = {
      ...viewNoVariants,
      tenantVariants: [
        {
          tenantId: "northgate-cu",
          artifact,
          fingerprint: "fp-northgate",
          approvalState: "approved",
          confidence: { totalRuns: 1, successCount: 1, hardFailureCount: 0, score: 1, label: "low" },
          drift: [
            { stepId: "step-4", description: 'Click "Log In"', actionType: "click" as const, expectedStrategy: "role" as const, observedCounts: { css_structural: 1 }, totalObservations: 1, driftCount: 1 },
          ],
        },
      ],
    };
    const html = renderDashboard([viewWithVariant]);
    expect(html).toContain("Cross-tenant drift comparison");
    expect(html).toContain("northgate-cu");
    // step-4 is stable on base, drifting on northgate-cu -- both badges should appear on
    // the same row (within the matrix section specifically, not the base-only drift table
    // above it, which also has its own "step-4" row).
    const matrixSection = html.slice(html.indexOf("Cross-tenant drift comparison"));
    const rowMatch = matrixSection.match(/<tr><td>step-4<\/td>[\s\S]*?<\/tr>/);
    expect(rowMatch?.[0]).toContain("stable");
    expect(rowMatch?.[0]).toContain("drift");
  });
});
