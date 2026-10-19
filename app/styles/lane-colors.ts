/**
 * Consequence-lane colour mapping: the ONE place a lane picks its colours.
 * Shared by Home's "What it's costing you" lane cards and the "Start here"
 * cards (TopFindings), so a lane looks the same everywhere.
 */
import {
  ACCENT_BORDER,
  ACCENT_FILL,
  ACCENT_INK,
  ACCENT_TINT,
  COLOR_CRITICAL,
  CRIT_BD,
  CRIT_BG,
  CRIT_TEXT_STRONG,
  LANE_BLUE_BD,
  LANE_BLUE_FILL,
  LANE_BLUE_INK,
  LANE_BLUE_TINT,
  LANE_GREY_BD,
  LANE_GREY_FILL,
  LANE_GREY_INK,
  LANE_GREY_TINT,
  LANE_PURPLE_BD,
  LANE_PURPLE_FILL,
  LANE_PURPLE_INK,
  LANE_PURPLE_TINT,
  LANE_TEAL_BD,
  LANE_TEAL_FILL,
  LANE_TEAL_INK,
  LANE_TEAL_TINT,
} from "./shared";
import type { LaneKey } from "../lib/finding-consequence";

/** fill = stripe / dot / number circle, ink = text on white or tint, tint = card bg, bd = card border. */
export type LanePalette = { fill: string; ink: string; tint: string; bd: string };

/** Per-lane brand identity. */
export const LANE_COLOR: Record<LaneKey, LanePalette> = {
  "customers-see-it": {
    fill: LANE_BLUE_FILL,
    ink: LANE_BLUE_INK,
    tint: LANE_BLUE_TINT,
    bd: LANE_BLUE_BD,
  },
  discoverability: {
    fill: LANE_PURPLE_FILL,
    ink: LANE_PURPLE_INK,
    tint: LANE_PURPLE_TINT,
    bd: LANE_PURPLE_BD,
  },
  speed: { fill: LANE_TEAL_FILL, ink: LANE_TEAL_INK, tint: LANE_TEAL_TINT, bd: LANE_TEAL_BD },
  privacy: { fill: ACCENT_FILL, ink: ACCENT_INK, tint: ACCENT_TINT, bd: ACCENT_BORDER },
  housekeeping: {
    fill: LANE_GREY_FILL,
    ink: LANE_GREY_INK,
    tint: LANE_GREY_TINT,
    bd: LANE_GREY_BD,
  },
};

/**
 * Security findings (malicious code, an affected-app advisory) are not shown
 * in a lane's colours: they use the critical red tokens, like the Security
 * risk banner.
 */
export const SECURITY_RISK_COLOR: LanePalette = {
  fill: COLOR_CRITICAL,
  ink: CRIT_TEXT_STRONG,
  tint: CRIT_BG,
  bd: CRIT_BD,
};
