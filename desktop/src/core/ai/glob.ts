// `fnmatch(pattern, name, 0)` de la libc : `*` (y compris `/`, sans FNM_PATHNAME), `?`, classes `[…]`/`[!…]`,
// `\` pour échapper ; le point initial n'a rien de particulier (sans FNM_PERIOD).

const cache = new Map<string, RegExp>();

function escapeChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/** Échappement dans une classe `[…]`. */
function escapeInClass(ch: string): string {
  return /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
}

function compile(pattern: string): RegExp {
  const chars = [...pattern];
  let re = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === "*") {
      re += "[\\s\\S]*";
    } else if (c === "?") {
      re += "[\\s\\S]";
    } else if (c === "\\" && i + 1 < chars.length) {
      i++;
      re += escapeChar(chars[i] as string);
    } else if (c === "[") {
      // Classe : `]` juste après `[` ou `[!` est littéral ; une classe non fermée est un `[` littéral.
      let j = i + 1;
      let negate = false;
      if (chars[j] === "!" || chars[j] === "^") {
        negate = true;
        j++;
      }
      let body = "";
      let first = true;
      let closed = false;
      for (; j < chars.length; j++) {
        const d = chars[j] as string;
        if (d === "]" && !first) {
          closed = true;
          break;
        }
        first = false;
        if (d === "\\" && j + 1 < chars.length) {
          j++;
          body += escapeInClass(chars[j] as string);
        } else if (d === "-" && body !== "" && chars[j + 1] !== "]" && j + 1 < chars.length) {
          body += "-";
        } else {
          body += escapeInClass(d);
        }
      }
      if (!closed) {
        re += "\\[";
      } else {
        re += `[${negate ? "^" : ""}${body}]`;
        i = j;
      }
    } else {
      re += escapeChar(c);
    }
  }
  return new RegExp(`^${re}$`, "u");
}

/** Le nom correspond-il au motif ? */
export function globMatch(pattern: string, name: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = compile(pattern);
    cache.set(pattern, re);
  }
  return re.test(name);
}
