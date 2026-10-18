// Reference validator for the NOD digest contract (docs/spec/digest-contract.md).
// Returns a list of human-readable problems; an empty list means valid.

export const CONTRACT_VERSION = 1;
export const PLATFORMS = ["shopify", "monday"];
export const STAGES = ["live", "in_review", "submitted", "building"];
export const ERROR_CATEGORIES = ["api", "webhook", "token", "encryption", "job", "billing", "other"];
const MERCHANT_KEYS = ["id", "plan", "installedAt", "lastActiveAt", "actions7d", "actions30d"];
const TOP_KEYS = [
  "contractVersion", "app", "generatedAt", "lifecycle", "installs", "revenue",
  "value", "engagement", "nudges", "errors", "series", "journey", "merchants",
];
// Object built-ins: as keys they would shadow or replace prototype properties when stage times are merged.
const RESERVED_KEYS = ["__proto__", "constructor"];
const JOURNEY_MERCHANT_KEYS = ["id", "installedAt", "uninstalledAt", "plan", "reached"];
// ADR-004: an ID that looks like a domain or email leaks identity.
const opaqueId = (id) => typeof id === "string" && id.length > 0 && !/[@.]/.test(id.replace(/^gid:\/\/shopify\/Shop\//, ""));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const KEY_RE = /^[a-z0-9_-]+$/;
// Strict ISO-8601: a real calendar date, optionally with a UTC/offset time. Rejects "1" or "2026-02-30".
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const isIso = (v) => {
  const m = typeof v === "string" && v.match(ISO_RE);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

export function validateDigest(d) {
  const errs = [];
  const req = (cond, msg) => { if (!cond) errs.push(msg); };
  const counts = (obj, path, keys) => {
    for (const k of keys) req(isCount(obj[k]), `${path}.${k} must be a non-negative integer`);
  };
  const noExtra = (obj, path, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${path}.${k} is not an allowed field`);
  };

  if (!isObj(d)) return ["payload must be a JSON object"];
  noExtra(d, "$", TOP_KEYS);
  req(d.contractVersion === CONTRACT_VERSION, `contractVersion must be ${CONTRACT_VERSION}`);

  if (!isObj(d.app)) errs.push("app is required");
  else {
    noExtra(d.app, "app", ["key", "name", "platform"]);
    req(typeof d.app.key === "string" && /^[a-z0-9-]+$/.test(d.app.key), "app.key must be lowercase kebab-case");
    req(typeof d.app.name === "string" && d.app.name.length > 0, "app.name is required");
    req(PLATFORMS.includes(d.app.platform), `app.platform must be one of ${PLATFORMS.join(", ")}`);
  }
  req(isIso(d.generatedAt), "generatedAt must be an ISO-8601 timestamp");

  if (!isObj(d.lifecycle)) errs.push("lifecycle is required");
  else {
    noExtra(d.lifecycle, "lifecycle", ["stage", "since"]);
    req(STAGES.includes(d.lifecycle.stage), `lifecycle.stage must be one of ${STAGES.join(", ")}`);
    if (d.lifecycle.since !== undefined) req(isIso(d.lifecycle.since), "lifecycle.since must be a date");
  }

  if (!isObj(d.installs)) errs.push("installs is required");
  else {
    noExtra(d.installs, "installs", ["active", "installed7d", "uninstalled7d", "installed30d", "uninstalled30d", "excludedInternal"]);
    counts(d.installs, "installs", ["active", "installed7d", "uninstalled7d", "installed30d", "uninstalled30d"]);
    if (d.installs.excludedInternal !== undefined) counts(d.installs, "installs", ["excludedInternal"]);
    if (isCount(d.installs.installed7d) && isCount(d.installs.installed30d))
      req(d.installs.installed7d <= d.installs.installed30d, "installs.installed7d cannot exceed installed30d");
    if (isCount(d.installs.uninstalled7d) && isCount(d.installs.uninstalled30d))
      req(d.installs.uninstalled7d <= d.installs.uninstalled30d, "installs.uninstalled7d cannot exceed uninstalled30d");
  }

  if (d.revenue !== undefined) {
    const r = d.revenue;
    if (!isObj(r)) errs.push("revenue must be an object");
    else {
      noExtra(r, "revenue", ["currency", "mrrCents", "plans"]);
      req(typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency), "revenue.currency must be a 3-letter code");
      counts(r, "revenue", ["mrrCents"]);
      if (!Array.isArray(r.plans)) errs.push("revenue.plans must be an array");
      else {
        r.plans.forEach((p, i) => {
          if (!isObj(p)) return errs.push(`revenue.plans[${i}] must be an object`);
          noExtra(p, `revenue.plans[${i}]`, ["plan", "installs", "mrrCents"]);
          req(typeof p.plan === "string" && p.plan.length > 0, `revenue.plans[${i}].plan is required`);
          counts(p, `revenue.plans[${i}]`, ["installs", "mrrCents"]);
        });
        const sum = r.plans.reduce((s, p) => s + (isCount(p?.mrrCents) ? p.mrrCents : 0), 0);
        if (isCount(r.mrrCents)) req(sum === r.mrrCents, `revenue.mrrCents (${r.mrrCents}) must equal the sum of plans (${sum})`);
        const installs = r.plans.reduce((s, p) => s + (isCount(p?.installs) ? p.installs : 0), 0);
        if (isCount(d.installs?.active)) req(installs === d.installs.active, `revenue.plans installs (${installs}) must equal installs.active (${d.installs.active})`);
      }
    }
  }

  const valueKeys = new Set();
  if (d.value !== undefined) {
    if (!Array.isArray(d.value)) errs.push("value must be an array");
    else d.value.forEach((v, i) => {
      if (!isObj(v)) return errs.push(`value[${i}] must be an object`);
      noExtra(v, `value[${i}]`, ["key", "label", "d1", "d7", "d30", "caveat"]);
      if (v.caveat !== undefined) req(typeof v.caveat === "string" && v.caveat.trim().length > 0 && v.caveat.length <= 200 && !/[\r\n]/.test(v.caveat),
        `value[${i}].caveat must be one non-empty line of at most 200 characters`);
      req(typeof v.key === "string" && KEY_RE.test(v.key), `value[${i}].key must match ${KEY_RE}`);
      req(typeof v.label === "string" && v.label.length > 0, `value[${i}].label is required`);
      counts(v, `value[${i}]`, ["d1", "d7", "d30"]);
      if ([v.d1, v.d7, v.d30].every(isCount)) req(v.d1 <= v.d7 && v.d7 <= v.d30, `value[${i}] must satisfy d1 <= d7 <= d30`);
      if (valueKeys.has(v.key)) errs.push(`value key "${v.key}" is duplicated`);
      valueKeys.add(v.key);
    });
  }

  if (d.engagement !== undefined) {
    const e = d.engagement;
    if (!isObj(e)) errs.push("engagement must be an object");
    else {
      noExtra(e, "engagement", ["activeMerchants7d", "returningMerchants7d", "visits7d"]);
      counts(e, "engagement", ["activeMerchants7d", "returningMerchants7d"]);
      if (e.visits7d !== undefined) counts(e, "engagement", ["visits7d"]);
      if (isCount(e.activeMerchants7d) && isCount(e.returningMerchants7d))
        req(e.returningMerchants7d <= e.activeMerchants7d, "engagement.returningMerchants7d cannot exceed activeMerchants7d");
    }
  }

  if (d.nudges !== undefined) {
    if (!Array.isArray(d.nudges)) errs.push("nudges must be an array");
    else d.nudges.forEach((n, i) => {
      if (!isObj(n)) return errs.push(`nudges[${i}] must be an object`);
      noExtra(n, `nudges[${i}]`, ["key", "label", "shown", "clicked", "dismissed", "converted"]);
      req(typeof n.key === "string" && KEY_RE.test(n.key), `nudges[${i}].key must match ${KEY_RE}`);
      req(typeof n.label === "string" && n.label.length > 0, `nudges[${i}].label is required`);
      counts(n, `nudges[${i}]`, ["shown", "clicked", "dismissed", "converted"]);
      // No clicked <= shown check: "shown" fires once per merchant, so a click in the window can follow a "shown" before it.
    });
  }

  if (d.errors !== undefined) {
    const e = d.errors;
    if (!isObj(e)) errs.push("errors must be an object");
    else {
      noExtra(e, "errors", ["count24h", "count7d", "byCode"]);
      counts(e, "errors", ["count24h", "count7d"]);
      if (isCount(e.count24h) && isCount(e.count7d)) req(e.count24h <= e.count7d, "errors.count24h cannot exceed count7d");
      if (!Array.isArray(e.byCode)) errs.push("errors.byCode must be an array");
      else e.byCode.forEach((c, i) => {
        if (!isObj(c)) return errs.push(`errors.byCode[${i}] must be an object`);
        noExtra(c, `errors.byCode[${i}]`, ["code", "category", "count24h", "count7d", "lastAt"]);
        req(typeof c.code === "string" && c.code.length > 0, `errors.byCode[${i}].code is required`);
        req(ERROR_CATEGORIES.includes(c.category), `errors.byCode[${i}].category must be one of ${ERROR_CATEGORIES.join(", ")}`);
        counts(c, `errors.byCode[${i}]`, ["count24h", "count7d"]);
        if (isCount(c.count24h) && isCount(c.count7d)) req(c.count24h <= c.count7d, `errors.byCode[${i}].count24h cannot exceed count7d`);
        if (c.lastAt !== undefined) req(isIso(c.lastAt), `errors.byCode[${i}].lastAt must be a timestamp`);
      });
    }
  }

  if (d.series !== undefined) {
    const s = d.series;
    if (!isObj(s)) errs.push("series must be an object");
    else {
      noExtra(s, "series", ["days", "installed", "uninstalled", "value"]);
      if (!Array.isArray(s.days) || s.days.length > 30 || !s.days.every(isIso))
        errs.push("series.days must be an array of <= 30 dates");
      else {
        for (const k of ["installed", "uninstalled", "value"]) {
          if (s[k] === undefined) continue;
          req(Array.isArray(s[k]) && s[k].length === s.days.length && s[k].every(isCount),
            `series.${k} must be ${s.days.length} non-negative integers`);
        }
        const sorted = [...s.days].sort();
        req(sorted.every((x, i) => x === s.days[i]), "series.days must be oldest first");
      }
    }
  }

  if (d.journey !== undefined) {
    const j = d.journey;
    if (!isObj(j)) errs.push("journey must be an object");
    else {
      noExtra(j, "journey", ["stages", "valueStage", "merchants"]);
      const stageKeys = new Set();
      if (!Array.isArray(j.stages) || j.stages.length < 1 || j.stages.length > 6) errs.push("journey.stages must be an array of 1 to 6 stages");
      else j.stages.forEach((st, i) => {
        if (!isObj(st)) return errs.push(`journey.stages[${i}] must be an object`);
        noExtra(st, `journey.stages[${i}]`, ["key", "label"]);
        req(typeof st.key === "string" && KEY_RE.test(st.key) && !RESERVED_KEYS.includes(st.key), `journey.stages[${i}].key must match ${KEY_RE} and not be a reserved name`);
        req(typeof st.label === "string" && st.label.length > 0 && st.label.length <= 60, `journey.stages[${i}].label must be 1 to 60 characters`);
        if (stageKeys.has(st.key)) errs.push(`journey stage "${st.key}" is duplicated`);
        stageKeys.add(st.key);
      });
      req(stageKeys.has(j.valueStage), "journey.valueStage must be one of journey.stages[].key");
      const ids = new Set();
      if (!Array.isArray(j.merchants)) errs.push("journey.merchants must be an array");
      else j.merchants.forEach((m, i) => {
        const p = `journey.merchants[${i}]`;
        if (!isObj(m)) return errs.push(`${p} must be an object`);
        noExtra(m, p, JOURNEY_MERCHANT_KEYS);
        req(opaqueId(m.id), `${p}.id must be an opaque non-empty string (no domain or email)`);
        if (ids.has(m.id)) errs.push(`${p}.id is duplicated`);
        ids.add(m.id);
        req(isIso(m.installedAt), `${p}.installedAt must be a timestamp`);
        if (m.uninstalledAt !== undefined) req(isIso(m.uninstalledAt), `${p}.uninstalledAt must be a timestamp`);
        if (m.plan !== undefined) req(typeof m.plan === "string" && m.plan.length <= 60, `${p}.plan must be a string of at most 60 characters`);
        if (!isObj(m.reached)) errs.push(`${p}.reached must be an object`);
        else for (const [k, v] of Object.entries(m.reached)) {
          req(stageKeys.has(k), `${p}.reached.${k} is not a journey stage`);
          req(isIso(v), `${p}.reached.${k} must be a timestamp`);
        }
      });
    }
  }

  // Same ids in both lists: NOD scrubs anonymized merchants out of stored merchants[] by journey id (ADR-010).
  if (Array.isArray(d.journey?.merchants) && Array.isArray(d.merchants)) {
    const jids = new Set(d.journey.merchants.map((m) => m?.id));
    d.merchants.forEach((m, i) => { if (typeof m?.id === "string" && !jids.has(m.id)) errs.push(`merchants[${i}].id is missing from journey.merchants (ids must match)`); });
  }

  if (d.merchants !== undefined) {
    if (!Array.isArray(d.merchants)) errs.push("merchants must be an array");
    else d.merchants.forEach((m, i) => {
      const p = `merchants[${i}]`;
      if (!isObj(m)) return errs.push(`${p} must be an object`);
      noExtra(m, p, MERCHANT_KEYS);
      req(typeof m.id === "string" && m.id.length > 0, `${p}.id is required`);
      if (typeof m.id === "string" && m.id.length > 0) req(opaqueId(m.id), `${p}.id must be opaque (no domain or email)`);
      req(typeof m.plan === "string", `${p}.plan is required`);
      req(isIso(m.installedAt), `${p}.installedAt must be a timestamp`);
      if (m.lastActiveAt !== undefined) req(isIso(m.lastActiveAt), `${p}.lastActiveAt must be a timestamp`);
      for (const k of ["actions7d", "actions30d"]) {
        if (m[k] === undefined) continue;
        if (!isObj(m[k])) { errs.push(`${p}.${k} must be an object`); continue; }
        for (const [ak, av] of Object.entries(m[k])) {
          req(isCount(av), `${p}.${k}.${ak} must be a non-negative integer`);
          if (valueKeys.size) req(valueKeys.has(ak), `${p}.${k}.${ak} does not match any value[].key`);
        }
      }
    });
  }

  return errs;
}
