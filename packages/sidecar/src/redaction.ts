export type RedactionMode = "none" | "secrets" | "secrets+pii";

// "secrets" over "secrets+pii": most false positives live in the PII rules,
// and a default should never be the mode most likely to mangle content.
export const DEFAULT_REDACTION_MODE: RedactionMode = "secrets";
export const REDACTION_MODES: readonly RedactionMode[] = ["none", "secrets", "secrets+pii"];

// Digit-leading keys (2FA_TOKEN) are as sensitive as any other.
const KEY_NAME_PATTERN = String.raw`[A-Za-z0-9_][A-Za-z0-9_-]*`;
// `key: "value"`, `key='value'`, and `"key": "value"` in one pattern: the key
// quote is optional (a word boundary otherwise), and the quoted value runs to
// the matching close quote, so it may contain spaces, the other quote char,
// and escapes.
const QUOTED_SECRET_REGEX = new RegExp(
  String.raw`(?:(?<keyQuote>["'])|\b)(?<key>${KEY_NAME_PATTERN})\k<keyQuote>` +
    // The escape branch is the only one that can consume a backslash, so the
    // alternation is unambiguous — an unterminated value can't trigger
    // exponential backtracking.
    String.raw`(?<separator>\s*[:=]\s*)(?<valueQuote>["'])(?<value>(?:\\[^\r\n]|(?!\k<valueQuote>)[^\\\r\n])+)\k<valueQuote>`,
  "g",
);

const BARE_ASSIGNMENT_SECRET_REGEX = new RegExp(
  String.raw`\b(${KEY_NAME_PATTERN})(\s*[:=]\s*)([^\s"',;` + "`" + String.raw`]+)`,
  "g",
);

// Shell parameter expansion reads a variable; it never assigns one. `${PWD:t}`
// (zsh's tail modifier), `${PASSWORD:0:3}`, and `$TOKEN:foo` look like
// `key: value` to the assignment patterns above, and redacting the "value"
// eats the closing brace: the published file no longer parses, and every
// other machine receives it as its working copy. So a key read through `$` or
// `${` is skipped there, and the one part of an expansion that can carry a
// literal secret — the word of a default (`${DB_PASSWORD:-hunter2}`), assign
// (`:=`), or alternate (`:+`) — is redacted here instead, keeping the braces.
const SHELL_NAME_PATTERN = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
// `${`, then zsh's `(flags)` and the `!`/`^`/`=`/`~` prefixes, then the name.
const SHELL_EXPANSION_OPEN = String.raw`\$\{(?:\([^()\s]*\))?[!^=~]*`;
const SHELL_DEFAULT_REGEX = new RegExp(
  String.raw`(${SHELL_EXPANSION_OPEN})(${SHELL_NAME_PATTERN})(:?[-=+])`,
  "g",
);
const SHELL_EXPANSION_KEY_PREFIX = new RegExp(String.raw`\$\{(?:\([^()\s]*\))?[#!^=~]*$`);
// The shell's working directories. In an expansion they are always the
// variable, never an ODBC-style `PWD=` password.
const SHELL_DIRECTORY_NAMES = new Set(["PWD", "OLDPWD"]);
// Upper case only: in a `.env` file, `PASSWORD=$ecret` may be a literal.
const SHELL_VARIABLE_REFERENCE = new RegExp(String.raw`^\$(?:[A-Z_][A-Z0-9_]*)$`);

function redactShellDefaults(text: string): string {
  let output = "";
  let copied = 0;
  for (const match of text.matchAll(SHELL_DEFAULT_REGEX)) {
    const [whole, open, name, operator] = match;
    const wordStart = match.index + whole.length;
    // A default nested in an earlier, already-redacted word is gone with it.
    if (match.index < copied || SHELL_DIRECTORY_NAMES.has(name) || !isSensitiveKey(name)) continue;
    const end = shellWordEnd(text, wordStart, "}");
    // Unterminated on this line: there is no closing brace to keep, so the
    // rest of the line goes, as the assignment pattern would have taken it.
    const wordEnd = end === -1 ? lineEnd(text, wordStart) : end;
    const word = text.slice(wordStart, wordEnd);
    if (!word || isShellReference(word) || isPlaceholder(word)) continue;
    output += `${text.slice(copied, match.index)}${open}${name}${operator}${placeholderForKey(name)}`;
    copied = wordEnd;
  }
  return output + text.slice(copied);
}

/**
 * Where the word starting at `start` ends: the index of the `close` that
 * ends its expansion, or -1 if the line ends first. Backslash escapes,
 * quotes, backticks, and nested `${…}` and `$(…)` are skipped, so a brace
 * inside them never ends the word early and leaves part of it behind.
 */
function shellWordEnd(text: string, start: number, close: "}" | ")"): number {
  const closers: string[] = [close];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") return -1;
    if (char === "\\") {
      index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      const quoteEnd = closingQuote(text, index + 1, char);
      if (quoteEnd === -1) return -1;
      index = quoteEnd;
    } else if (char === "$" && (text[index + 1] === "{" || text[index + 1] === "(")) {
      closers.push(text[index + 1] === "{" ? "}" : ")");
      index += 1;
    } else if (char === "(" && closers.at(-1) === ")") {
      closers.push(")");
    } else if (char === closers.at(-1)) {
      closers.pop();
      if (!closers.length) return index;
    }
  }
  return -1;
}

function closingQuote(text: string, start: number, quote: string): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") return -1;
    if (char === "\\" && quote !== "'") index += 1;
    else if (char === quote) return index;
  }
  return -1;
}

function lineEnd(text: string, start: number): number {
  const match = /[\r\n]/.exec(text.slice(start));
  return match ? start + match.index : text.length;
}

/** Whether the key at `offset` is read by `${KEY…}`, or by `$KEY` before a `:`. `$key = value` is an assignment (PHP, PowerShell). */
function isShellReadOfKey(text: string, offset: number, separator: string): boolean {
  if (SHELL_EXPANSION_KEY_PREFIX.test(text.slice(Math.max(0, offset - 64), offset))) return true;
  return text[offset - 1] === "$" && separator.trim().startsWith(":");
}

/**
 * Whether a value is only a reference to something else, which is never a
 * literal secret: `$NAME`, `$(command)`, or `${NAME}` (with a modifier, an
 * error message, or a default that is itself a reference or a placeholder).
 * One pair of double quotes around it is allowed.
 */
function isShellReference(value: string): boolean {
  const unquoted = value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (SHELL_VARIABLE_REFERENCE.test(unquoted)) return true;
  if (!unquoted.startsWith("${") && !unquoted.startsWith("$(")) return false;
  const close = unquoted[1] === "{" ? "}" : ")";
  if (shellWordEnd(unquoted, 2, close) !== unquoted.length - 1) return false;
  if (close === ")") return true;
  const inner = new RegExp(String.raw`^(?:\([^()\s]*\))?[#!^=~]*${SHELL_NAME_PATTERN}(?<rest>.*)$`, "s").exec(unquoted.slice(2, -1));
  const rest = inner?.groups?.rest;
  if (rest === undefined) return false;
  if (rest === "" || /^:?\?/.test(rest) || /^(?::[a-zA-Z0-9]+)+$/.test(rest)) return true;
  const word = /^:?[-=+](?<word>.*)$/s.exec(rest)?.groups?.word;
  return word !== undefined && (word === "" || isPlaceholder(word) || isShellReference(word));
}

/** Whether the bare value starting at `start` is wholly a reference: `KEY=$(gh auth token)`. */
function startsWithShellReference(text: string, start: number): boolean {
  if (text[start] !== "$") return false;
  let end: number;
  if (text[start + 1] === "{" || text[start + 1] === "(") {
    end = shellWordEnd(text, start + 2, text[start + 1] === "{" ? "}" : ")");
    if (end === -1) return false;
    end += 1;
  } else {
    end = start + 1 + (/^[A-Za-z0-9_]*/.exec(text.slice(start + 1))?.[0].length ?? 0);
  }
  if (end < text.length && !/[\s;&|)]/.test(text[end])) return false;
  return isShellReference(text.slice(start, end));
}

const AUTHORIZATION_HEADER_REGEX = /\b(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)([^\s"',;`]+)/gi;
const PEM_PRIVATE_KEY_REGEX =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const URL_CREDENTIALS_REGEX = /(\/\/[^\s/:@"'`]+):([^\s/@"'`]+)@/g;
const BARE_BEARER_TOKEN_REGEX =
  /\b(Bearer\s+)(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9._~+/-]{20,})\b/g;

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, "<API_KEY>"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "<API_KEY>"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<API_KEY>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "<TOKEN>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<TOKEN>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<TOKEN>"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<TOKEN>"],
];

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// Requires phone-style separators so bare digit runs (IDs, counters) pass.
const PHONE_REGEX = /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_CANDIDATE_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

export function redactText(input: string, mode: RedactionMode = DEFAULT_REDACTION_MODE): string {
  if (mode === "none") return input;
  let output = redactShellDefaults(input)
    .replace(PEM_PRIVATE_KEY_REGEX, "<PRIVATEKEY>")
    .replace(AUTHORIZATION_HEADER_REGEX, (_match, prefix: string) => `${prefix}<TOKEN>`)
    .replace(BARE_BEARER_TOKEN_REGEX, (_match, prefix: string) => `${prefix}<TOKEN>`)
    .replace(URL_CREDENTIALS_REGEX, (_match, prefix: string) => `${prefix}:<SECRET>@`)
    .replace(QUOTED_SECRET_REGEX, (match, ...args) => {
      const { keyQuote = "", key, separator, valueQuote, value } = args.at(-1) as {
        keyQuote?: string;
        key: string;
        separator: string;
        valueQuote: string;
        value: string;
      };
      const offset = args.at(-3) as number;
      const text = args.at(-2) as string;
      if (!isSensitiveKey(key) || isShellReadOfKey(text, offset + keyQuote.length, separator)) return match;
      if (valueQuote === '"' && isShellReference(value)) return match;
      return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${placeholderForKey(key)}${valueQuote}`;
    })
    .replace(
      BARE_ASSIGNMENT_SECRET_REGEX,
      (match, key: string, separator: string, _value: string, offset: number, text: string) => {
        if (!isSensitiveKey(key) || isShellReadOfKey(text, offset, separator)) return match;
        if (startsWithShellReference(text, offset + key.length + separator.length)) return match;
        return `${key}${separator}${placeholderForKey(key)}`;
      },
    );

  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  if (mode === "secrets") return output;

  return output
    .replace(EMAIL_REGEX, "<EMAIL>")
    .replace(PHONE_REGEX, "<PHONENUMBER>")
    .replace(SSN_REGEX, "<SSN>")
    .replace(CREDIT_CARD_CANDIDATE_REGEX, (candidate) =>
      isLikelyCreditCard(candidate) ? "<CREDITCARD>" : candidate,
    );
}

const PLACEHOLDER_REGEX = /<(?:API_KEY|TOKEN|SECRET|PRIVATEKEY|EMAIL|PHONENUMBER|SSN|CREDITCARD)>/g;

function isPlaceholder(text: string): boolean {
  return /^<(?:API_KEY|TOKEN|SECRET|PRIVATEKEY|EMAIL|PHONENUMBER|SSN|CREDITCARD)>$/.test(text);
}

/** Whether a line carries a redaction placeholder. */
export function hasRedactionPlaceholder(text: string): boolean {
  return countRedactionPlaceholders(text) > 0;
}

export function countRedactionPlaceholders(text: string): number {
  return text.match(PLACEHOLDER_REGEX)?.length ?? 0;
}

function placeholderForKey(key: string): string {
  if (/api[_-]?key/i.test(key)) return "<API_KEY>";
  if (/password|passwd|pwd|passphrase|secret|private/i.test(key)) return "<SECRET>";
  return "<TOKEN>";
}

const COMPACT_SENSITIVE_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "githubtoken",
  "bearertoken",
  "clientsecret",
  "credential",
  "credentials",
  "secretkey",
  "privatekey",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "token",
  "secret",
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/-/g, "_");
  const lower = normalized.toLowerCase();
  const compact = lower.replace(/_/g, "");
  if (COMPACT_SENSITIVE_KEYS.has(compact)) return true;

  const parts = normalized
    .toUpperCase()
    .split("_")
    .filter(Boolean);
  const last = parts.at(-1);
  if (["PASSWORD", "PASSWD", "PWD", "PASSPHRASE", "TOKEN", "SECRET"].includes(last ?? "")) {
    return true;
  }
  if (parts.includes("API") && parts.includes("KEY")) return true;
  if (parts.includes("ACCESS") && parts.includes("TOKEN")) return true;
  if (parts.includes("REFRESH") && parts.includes("TOKEN")) return true;
  if (parts.includes("SECRET") && (parts.includes("KEY") || parts.includes("ACCESS"))) return true;
  if (parts.includes("PRIVATE") && parts.includes("KEY")) return true;

  return false;
}

function isLikelyCreditCard(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  // A separator-free digit run is only treated as a card at the two dominant
  // card lengths; anything else is far more likely an ID or hash.
  if (!/[ -]/.test(value) && digits.length !== 15 && digits.length !== 16) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }

  return sum % 10 === 0;
}
