/**
 * Codemod: convert `obj.prop` -> `obj["prop"]` for every TS4111 site
 * (noPropertyAccessFromIndexSignature). Driven entirely by `tsc` output so it
 * only touches accesses TypeScript actually flags as index-signature access —
 * never a real typed property.
 *
 * Usage:
 *   bun run scripts/codemod-ts4111.ts <tsc-output-file>
 *
 * The tsc output must contain lines of the exact form:
 *   path/to/file.ts(LINE,COL): error TS4111: Property 'NAME' comes from an
 *   index signature, so it must be accessed with ['NAME'].
 *
 * COL (1-indexed) points at the first character of NAME (the char after the
 * dot). We rewrite the `.NAME` starting at COL-1 (the dot) into `["NAME"]`.
 *
 * Edits are applied bottom-up per file (highest line/col first) so earlier
 * edits never shift the offsets of later ones.
 */

import { readFileSync, writeFileSync } from "node:fs";

type Edit = { line: number; col: number; name: string };

const tscOutPath = process.argv[2];
if (!tscOutPath) {
  console.error("usage: bun run scripts/codemod-ts4111.ts <tsc-output-file>");
  process.exit(2);
}

const raw = readFileSync(tscOutPath, "utf8");
const re =
  /^(.+?)\((\d+),(\d+)\): error TS4111: Property '([^']+)' comes from an index signature/;

const byFile = new Map<string, Edit[]>();
for (const lineStr of raw.split("\n")) {
  const m = lineStr.match(re);
  if (!m) continue;
  const [, file, lineNo, colNo, name] = m;
  if (!file || !lineNo || !colNo || !name) continue;
  const edits = byFile.get(file) ?? [];
  edits.push({ line: Number(lineNo), col: Number(colNo), name });
  byFile.set(file, edits);
}

let totalEdits = 0;
let filesChanged = 0;
const skipped: string[] = [];

for (const [file, editsRaw] of byFile) {
  // Dedup identical (line,col) — tsc can emit the same site more than once.
  const seen = new Set<string>();
  const edits = editsRaw.filter((e) => {
    const k = `${e.line}:${e.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Apply bottom-up: highest line first, and within a line highest col first.
  edits.sort((a, b) => b.line - a.line || b.col - a.col);

  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  let fileEdits = 0;

  for (const e of edits) {
    const idx = e.line - 1;
    const text = lines[idx];
    if (text === undefined) {
      skipped.push(`${file}(${e.line},${e.col}): line out of range`);
      continue;
    }
    // col is 1-indexed, points at NAME's first char. The dot is at col-1.
    const dotPos = e.col - 2; // 0-indexed position of the '.'
    const namePos = e.col - 1; // 0-indexed position of NAME's first char
    if (text[dotPos] !== ".") {
      skipped.push(
        `${file}(${e.line},${e.col}): expected '.' at col ${e.col - 1}, found '${text[dotPos]}' — line: ${text.trim()}`,
      );
      continue;
    }
    // NAME must match exactly at namePos.
    if (text.slice(namePos, namePos + e.name.length) !== e.name) {
      skipped.push(
        `${file}(${e.line},${e.col}): expected '${e.name}' at col ${e.col}, found '${text.slice(namePos, namePos + e.name.length)}' — line: ${text.trim()}`,
      );
      continue;
    }
    // The char after NAME must be a non-identifier char (so we matched the
    // whole identifier, not a prefix). Identifier chars: [A-Za-z0-9_$].
    const after = text[namePos + e.name.length] ?? "";
    if (/[A-Za-z0-9_$]/.test(after)) {
      skipped.push(
        `${file}(${e.line},${e.col}): '${e.name}' is a prefix of a longer identifier — line: ${text.trim()}`,
      );
      continue;
    }
    const rest = text.slice(namePos + e.name.length);
    // Optional chaining: `obj?.NAME` must become `obj?.["NAME"]` (keep the `?.`),
    // not `obj?["NAME"]` which is a syntax error. The `?.` puts a `?` at dotPos-1.
    const isOptionalChain = text[dotPos - 1] === "?";
    if (isOptionalChain) {
      const before = text.slice(0, dotPos + 1); // keep through the `.` of `?.`
      lines[idx] = `${before}["${e.name}"]${rest}`;
    } else {
      const before = text.slice(0, dotPos); // drop the `.`
      lines[idx] = `${before}["${e.name}"]${rest}`;
    }
    fileEdits++;
  }

  if (fileEdits > 0) {
    writeFileSync(file, lines.join("\n"));
    filesChanged++;
    totalEdits += fileEdits;
  }
}

console.log(`Applied ${totalEdits} edits across ${filesChanged} files.`);
if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} sites (need manual review):`);
  for (const s of skipped) console.log(`  ${s}`);
}
