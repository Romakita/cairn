// JSON au format de Foundation (JSONSerialization, `.sortedKeys`) : mêmes octets que la 0.8.0,
// pour les sorties `--json` de la CLI, les manifests et les fichiers d'état.

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue | undefined };

/** Chaîne JSON comme Foundation : `/` échappé en `\/`, caractères non ASCII laissés tels quels. */
function quote(text: string): string {
  return JSON.stringify(text).replace(/\//g, "\\/");
}

/**
 * Nombre comme Foundation, qui écrit les doubles en `%.17g` : `0.1` → `0.10000000000000001`, `12.3` →
 * `12.300000000000001`, `1e-05` → `1.0000000000000001e-05`, `1e20` → `1e+20` ; les entiers restent tels quels.
 */
function formatNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e17) return String(v);
  const [mantissa = "", exponent = "0"] = v.toExponential(16).split("e");
  const exp = Number(exponent);
  const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 17) {
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${trim(mantissa)}e${exp < 0 ? "-" : "+"}${digits}`;
  }
  return trim(v.toFixed(16 - exp));
}

function encode(value: JSONValue | undefined, pretty: boolean, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON cannot encode a non-finite number");
    return formatNumber(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!pretty) return `[${value.map((v) => encode(v, false, "")).join(",")}]`;
    if (value.length === 0) return `[\n\n${indent}]`;
    return `[\n${value.map((v) => inner + encode(v, true, inner)).join(",\n")}\n${indent}]`;
  }
  // Clés triées par ordre des points de code, comme `.sortedKeys` ; une valeur `undefined` est omise.
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!pretty) return `{${keys.map((k) => `${quote(k)}:${encode(value[k], false, "")}`).join(",")}}`;
  if (keys.length === 0) return `{\n\n${indent}}`;
  return `{\n${keys.map((k) => `${inner}${quote(k)} : ${encode(value[k], true, inner)}`).join(",\n")}\n${indent}}`;
}

/** JSON indenté (2 espaces, `"clé" : valeur`), clés triées : sortie `--json`, manifests. */
export function prettyJSON(value: JSONValue): string {
  return encode(value, true, "");
}

/** JSON compact, clés triées : lignes du journal d'activité, fichiers d'état. */
export function compactJSON(value: JSONValue): string {
  return encode(value, false, "");
}
