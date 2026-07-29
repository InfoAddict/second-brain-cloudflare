#!/usr/bin/env node
// Shared logic for installing or updating Second Brain global instructions.
// Used by connect-ai-clients.{sh,ps1} and covered by unit tests.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const START_MARKER = "<!-- second-brain:instructions:start -->";
export const END_MARKER = "<!-- second-brain:instructions:end -->";
export const SENTINEL_PHRASE = "At the start of EVERY conversation, call recall";

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

/**
 * Install or refresh Second Brain instructions in a target markdown file.
 * - Marked block present → replace in place
 * - Legacy sentinel without markers → replace from sentinel through EOF
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

  if (normalizedExisting.includes(SENTINEL_PHRASE)) {
    const idx = normalizedExisting.indexOf(SENTINEL_PHRASE);
    const before = normalizedExisting.slice(0, idx).replace(/\s*$/, "");
    const prefix = before.length === 0 ? "" : `${before}\n`;
    return { content: `${prefix}${block}\n`, action: "updated-legacy" };
  }

  if (normalizedExisting.length === 0) {
    return { content: `${block}\n`, action: "appended" };
  }

  const separator = normalizedExisting.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${normalizedExisting}${separator}${block}\n`, action: "appended" };
}

function readTarget(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function runCli() {
  const targetFile = process.argv[2];
  if (!targetFile) {
    console.error("Usage: node instruction-block.mjs <target-file>  # body on stdin");
    process.exit(1);
  }

  const body = readFileSync(0, "utf8");
  const { content, action } = applyInstructionBlock(readTarget(targetFile), body);
  writeFileSync(targetFile, content, "utf8");
  process.stdout.write(action);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runCli();
}
