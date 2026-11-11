// YAML-subset frontmatter parser for design-resources SKILL.md files; no dependencies.
// Supports nested maps, "- " lists (scalars and maps), flow lists (also across lines), | and > block scalars,
// quoted scalars and " #" comments. Anything else throws instead of being skipped.

export function splitFrontmatter(text) {
  const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

function parseScalar(raw) {
  let s = raw.trim();
  if (/^[&*!{|>]/.test(s)) throw new Error(`unsupported YAML construct: ${s}`);
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) throw new Error(`unsupported quoted scalar: ${s}`);
    return JSON.parse(s);
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`unsupported quoted scalar: ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  s = s.replace(/(^|\s)#.*$/, "").trim();
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`unterminated flow list: ${s}`);
    const inner = s.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map(parseScalar);
  }
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseFrontmatter(source) {
  const lines = [];
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const prev = lines[lines.length - 1];
    // Join a flow list that continues on the next lines.
    if (prev !== undefined && /:\s*\[[^\]]*$/.test(prev)) lines[lines.length - 1] = `${prev} ${line.trim()}`;
    else lines.push(line);
  }
  let i = 0;
  const indentOf = (line) => line.match(/^ */)[0].length;
  const blank = (line) => line.trim() === "" || line.trim().startsWith("#");
  const keyLine = /^([A-Za-z0-9_.-]+):(?:\s+(.*)|\s*)$/;

  function block(parentIndent) {
    while (i < lines.length && blank(lines[i])) i++;
    if (i >= lines.length || indentOf(lines[i]) <= parentIndent) return null;
    const indent = indentOf(lines[i]);
    return /^-(?:\s|$)/.test(lines[i].slice(indent)) ? list(indent) : map(indent);
  }
  function blockScalar(style, parentIndent) {
    const out = [];
    let indent = -1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        out.push("");
        i++;
        continue;
      }
      if (indentOf(line) <= parentIndent) break;
      if (indent < 0) indent = indentOf(line);
      out.push(line.slice(indent));
      i++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return style.startsWith("|") ? out.join("\n") : out.join(" ").replace(/ +/g, " ");
  }
  function value(rest, parentIndent) {
    const s = rest.trim();
    if (s === "" || s.startsWith("#")) return block(parentIndent);
    if (/^[|>][+-]?$/.test(s)) return blockScalar(s, parentIndent);
    return parseScalar(s);
  }
  function map(indent) {
    const out = {};
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        i++;
        continue;
      }
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      if (lineIndent > indent) throw new Error(`unexpected indent: ${line}`);
      const match = line.slice(lineIndent).match(keyLine);
      if (!match) throw new Error(`unsupported YAML line: ${line}`);
      i++;
      out[match[1]] = value(match[2] ?? "", indent);
    }
    return out;
  }
  function list(indent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        i++;
        continue;
      }
      const lineIndent = indentOf(line);
      if (lineIndent < indent || !/^-(?:\s|$)/.test(line.slice(lineIndent))) break;
      if (lineIndent > indent) throw new Error(`unexpected indent: ${line}`);
      const rest = line.slice(lineIndent + 1).replace(/^ /, "");
      if (keyLine.test(rest) && !/^["']/.test(rest)) {
        lines[i] = " ".repeat(lineIndent + 2) + rest;
        out.push(map(lineIndent + 2));
      } else {
        i++;
        out.push(value(rest, lineIndent));
      }
    }
    return out;
  }
  return map(0);
}
