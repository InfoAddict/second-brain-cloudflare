#!/usr/bin/env node
// Shared logic for installing or updating Second Brain global instructions.
// Used by connect-ai-clients.{sh,ps1} and covered by unit tests.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const START_MARKER = "<!-- second-brain:instructions:start -->";
export const END_MARKER = "<!-- second-brain:instructions:end -->";
export const SENTINEL_PHRASE = "At the start of EVERY conversation, call recall";

const LEGACY_BLOCK_START_HINTS = [
  /you have access to a personal second brain/i,
  /^MANDATORY RULES\b/i,
  /^#{1,3}\s+.*second brain/i,
  /^#{1,3}\s+.*mandatory rules/i,
];

const LEGACY_BLOCK_END_LINES = [
  /never fall back to built-in memory silently/i,
  /only report ["']second brain unavailable["'] if a real tool call returns an error/i,
  /if the second brain MCP tools are unavailable/i,
  /always set source to ["']claude-desktop["']/i,
];

const USER_SECTION_HEADING = /^#{1,3}\s+/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

export function buildMarkedBlock(body) {
  const trimmed = normalizeNewlines(body).replace(/^\s+/, "").replace(/\s+$/, "");
  return `${START_MARKER}\n${trimmed}\n${END_MARKER}`;
}

function isSecondBrainHeading(line) {
  return /second brain|mandatory rules|tool guidance|tags to use|mcp availability/i.test(line);
}

/**
 * Find the line range of a legacy (unmarked) Second Brain instruction block.
 *
 * Returns `null` when the end of the block cannot be established, because the
 * caller deletes whatever range this reports. The file is the user's own global
 * instructions: prose we cannot attribute to Second Brain is theirs, and the
 * cost of guessing wrong is content they may not notice missing for weeks. So
 * every line removed has to be positively identified, and where identification
 * runs out the answer is "don't" rather than "probably".
 *
 * Two rules follow from that:
 *
 * - Walking up, an unrecognised line ends the search. It does not extend the
 *   block on the assumption that anything near the sentinel belongs to it —
 *   a note written just above the block is the likeliest thing to sit there.
 * - Walking down, the block must end at something we recognise: a closing line
 *   or the user's next heading. Running to the end of the file instead is the
 *   original defect this bounding was added to fix, and it survives for any
 *   block whose tail has been edited — which, in a file that exists to be
 *   edited, is not the rare case.
 */
export function findLegacyBlockRange(lines, sentinelLine) {
  let startLine = sentinelLine;

  for (let i = sentinelLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;

    if (LEGACY_BLOCK_START_HINTS.some((pattern) => pattern.test(line))) {
      startLine = i;
      continue;
    }

    if (USER_SECTION_HEADING.test(line)) {
      if (isSecondBrainHeading(line)) startLine = i;
      break;
    }

    if (/^\d+\.\s/.test(line)) {
      startLine = i;
      continue;
    }

    // Not recognisably ours. Leave it, and everything above it, alone.
    break;
  }

  let endLine = -1;
  for (let i = sentinelLine; i < lines.length; i++) {
    const line = lines[i];

    if (i > sentinelLine && USER_SECTION_HEADING.test(line) && !isSecondBrainHeading(line)) {
      endLine = i - 1;
      break;
    }

    if (LEGACY_BLOCK_END_LINES.some((pattern) => pattern.test(line))) {
      endLine = i;
      break;
    }
  }

  if (endLine < 0) return null;

  while (endLine > startLine && lines[endLine].trim() === "") endLine--;

  return { startLine, endLine };
}

function offsetBeforeLine(lines, lineIndex) {
  if (lineIndex <= 0) return 0;
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
  return offset;
}

function offsetAfterLine(lines, lineIndex) {
  let offset = 0;
  for (let i = 0; i <= lineIndex; i++) offset += lines[i].length + 1;
  return offset;
}

function replaceLegacyBlock(normalizedExisting, newBody) {
  const lines = normalizedExisting.split("\n");
  const sentinelLine = lines.findIndex((line) => line.includes(SENTINEL_PHRASE));
  if (sentinelLine < 0) {
    return null;
  }

  const range = findLegacyBlockRange(lines, sentinelLine);
  // Unbounded block: fall through to appending. The old copy stays in the file
  // and the user is told to remove it, which is a minute's tidying — where
  // deleting to the end of the file is not something they can undo once the
  // backup has aged out of memory.
  if (!range) return null;

  const { startLine, endLine } = range;
  const block = buildMarkedBlock(newBody);
  const before = normalizedExisting.slice(0, offsetBeforeLine(lines, startLine)).replace(/\s*$/, "");
  const after = normalizedExisting.slice(offsetAfterLine(lines, endLine)).replace(/^\n+/, "");
  const prefix = before.length === 0 ? "" : `${before}\n`;
  const suffix = after.length === 0 ? "" : `\n${after}`;
  return { content: `${prefix}${block}${suffix}\n`, action: "updated-legacy" };
}

/**
 * Install or refresh Second Brain instructions in a target markdown file.
 * - Marked block present → replace in place
 * - Legacy sentinel without markers → replace bounded legacy block, preserve surrounding content
 * - Otherwise → append a new marked block
 */
export function applyInstructionBlock(existing, newBody) {
  const normalizedExisting = normalizeNewlines(existing);
  const block = buildMarkedBlock(newBody);
  const markedPattern = new RegExp(
    `${escapeRegex(START_MARKER)}\\r?\\n[\\s\\S]*?\\r?\\n${escapeRegex(END_MARKER)}`,
  );

  if (markedPattern.test(normalizedExisting)) {
    return { content: normalizedExisting.replace(markedPattern, block), action: "updated" };
  }

  const hasLegacy = normalizedExisting.includes(SENTINEL_PHRASE);
  if (hasLegacy) {
    const legacy = replaceLegacyBlock(normalizedExisting, newBody);
    if (legacy) return legacy;
  }

  if (normalizedExisting.length === 0) {
    return { content: `${block}\n`, action: "appended" };
  }

  const separator = normalizedExisting.endsWith("\n") ? "\n" : "\n\n";
  const content = `${normalizedExisting}${separator}${block}\n`;
  // Distinct from a plain append: there is an older copy above that we declined
  // to delete, and the file now says two things. The user has to be told, or
  // they are left with duplicate instructions and no idea why.
  const action = hasLegacy ? "appended-legacy-kept" : "appended";
  return { content, action };
}

function readTarget(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function writeInstructionBlock(targetFile, newBody) {
  const original = readTarget(targetFile);
  const { content, action } = applyInstructionBlock(original, newBody);
  let backupPath = null;

  if (action === "updated-legacy" && original) {
    backupPath = `${targetFile}.bak`;
    writeFileSync(backupPath, original, "utf8");
  }

  writeFileSync(targetFile, content, "utf8");
  return { action, backupPath };
}

function runCli() {
  const targetFile = process.argv[2];
  if (!targetFile) {
    console.error("Usage: node instruction-block.mjs <target-file>  # body on stdin");
    process.exit(1);
  }

  const body = readFileSync(0, "utf8");
  const { action } = writeInstructionBlock(targetFile, body);
  process.stdout.write(action);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runCli();
}
