import type { RiskLevel } from "../services/permission-scorer.server";
import type { ScopeSensitivity } from "../data/category-permissions.server";

type PolarisStatusTone = "critical" | "warning" | "info" | "success";

/** Map a risk level to a Polaris badge/banner tone. */
export function riskTone(level: RiskLevel): PolarisStatusTone {
  switch (level) {
    case "critical":
      return "critical";
    case "high":
      return "warning";
    case "medium":
      return "info";
    case "low":
      return "success";
  }
}

/** Map a risk level to a human-readable label. */
export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
  }
}

/** Map a scope sensitivity level to a Polaris badge tone. */
export function sensitivityTone(sensitivity: ScopeSensitivity): PolarisStatusTone {
  switch (sensitivity) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "warning";
    case "MEDIUM":
      return "info";
    case "LOW":
      return "success";
  }
}
