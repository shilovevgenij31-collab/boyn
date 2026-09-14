/**
 * RFC-4180-style CSV encoding shared by every export (Phase 7 brief
 * §38-39). UTF-8 BOM + CRLF rows so Excel renders Cyrillic/emoji/Unicode
 * hashtags correctly rather than guessing the wrong codepage.
 */
const BOM = "﻿";

export function csvEscapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvEscapeField).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}
