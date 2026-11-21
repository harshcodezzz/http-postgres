const scopedCommands = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "TABLE", "VALUES"]);
const restrictedReadOnlyFunctions = new Set([
  "pg_logical_emit_message",
  // These built-ins can execute SQL supplied as a value, outside the visible statement.
  "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema", "ts_stat",
]);

function skipTrivia(sql: string, start: number): number {
  const whitespace = /[ \t\n\r\f]+/y;
  let index = start;
  while (index < sql.length) {
    whitespace.lastIndex = index;
    if (whitespace.test(sql)) {
      index = whitespace.lastIndex;
    } else if (sql.startsWith("--", index)) {
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index++;
    } else if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
    } else {
      break;
    }
  }
  return index;
}

export function isScopedStatement(sql: string): boolean {
  const identifier = /[a-z0-9_$\u0080-\uffff]+/iy;
  identifier.lastIndex = skipTrivia(sql, 0);
  const keyword = identifier.exec(sql)?.[0];
  return keyword !== undefined && scopedCommands.has(keyword.toUpperCase());
}

function quotedEnd(sql: string, start: number, backslashEscapes: boolean): number {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === "\\") {
      index += 2;
    } else if (sql[index] === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index += 2;
    } else {
      index++;
    }
  }
  return sql.length;
}

function decodeIdentifier(identifier: string, escape: string): string {
  const pattern = escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return identifier.replace(new RegExp(`${pattern}(?:${pattern}|\\+[a-f0-9]{6}|[a-f0-9]{4})`, "gi"), (encoded) => {
    const suffix = encoded.slice(1);
    if (suffix === escape) return escape;
    const codePoint = Number.parseInt(suffix.replace(/^\+/, ""), 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : encoded;
  });
}

function hasRestrictedReadOnlyCall(sql: string, legacyEscapes: boolean): boolean {
  const name = /[a-z_\u0080-\uffff][a-z0-9_$\u0080-\uffff]*/iy;
  const dollarQuote = /\$(?:[a-z_\u0080-\uffff][a-z0-9_\u0080-\uffff]*)?\$/iy;
  const escapeKeyword = /uescape(?![a-z0-9_$\u0080-\uffff])/iy;
  const escapeValue = /'([^'])'/y;
  let index = skipTrivia(sql, 0);
  while (index < sql.length) {
    const char = sql[index];
    let identifier: string | undefined;
    name.lastIndex = index;
    dollarQuote.lastIndex = index;
    const prefix = sql.slice(index, index + 3).toLowerCase();
    if (char === '"' || prefix === 'u&"') {
      const start = char === '"' ? index : index + 2;
      index = quotedEnd(sql, start, false);
      identifier = sql.slice(start + 1, index - 1).replaceAll('""', '"');
      if (prefix === 'u&"') {
        escapeKeyword.lastIndex = skipTrivia(sql, index);
        let escape = "\\";
        if (escapeKeyword.test(sql)) {
          escapeValue.lastIndex = skipTrivia(sql, escapeKeyword.lastIndex);
          const value = escapeValue.exec(sql);
          if (value) {
            escape = value[1];
            index = escapeValue.lastIndex;
          }
        }
        identifier = decodeIdentifier(identifier, escape);
      }
    } else if (char === "'" || prefix.startsWith("e'")) {
      index = quotedEnd(sql, char === "'" ? index : index + 1, legacyEscapes || char !== "'");
    } else {
      const delimiter = dollarQuote.exec(sql)?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        index = end < 0 ? sql.length : end + delimiter.length;
      } else {
        identifier = name.exec(sql)?.[0];
        index = identifier ? name.lastIndex : index + 1;
      }
    }
    index = skipTrivia(sql, index);
    if (identifier && sql[index] === "(" && restrictedReadOnlyFunctions.has(identifier.toLowerCase())) return true;
  }
  return false;
}

export function isReadOnlySqlAllowed(sql: string): boolean {
  // The server can accept either setting of standard_conforming_strings.
  return !hasRestrictedReadOnlyCall(sql, false) && !hasRestrictedReadOnlyCall(sql, true);
}
