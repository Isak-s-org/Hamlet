// Reads session titles from Claude Code's transcript files. Each read starts where the last one
// stopped, so following a long session only costs the bytes it appended since.
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TitleSource } from "./bots.js";

const CHUNK = 1 << 20;
const MAX_LINE = 1 << 16;

/** Read position per transcript, plus the unfinished last line. The decoder holds a character split between chunks. */
type Cursor = { offset: number; rest: string; decoder: StringDecoder };
const cursors = new Map<string, Cursor>();
const fresh = (): Cursor => ({ offset: 0, rest: "", decoder: new StringDecoder("utf8") });

/** Claude Code writes `ai-title` lines as the session goes on and a `custom-title` line on /rename. */
export function titleIn(line: string): { title: string; source: TitleSource } | undefined {
  if (!line.includes("-title")) return;
  try {
    const entry = JSON.parse(line);
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") return { title: entry.customTitle, source: "custom" };
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") return { title: entry.aiTitle, source: "ai" };
  } catch {}
}

/** The titles appended to the transcript since the last call, oldest first. */
export async function newTitles(path: string): Promise<{ title: string; source: TitleSource }[]> {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return [];
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let cursor = cursors.get(path) ?? fresh();
    if (size < cursor.offset) cursor = fresh(); // rewritten
    const found = [];
    const buffer = Buffer.alloc(Math.min(CHUNK, size - cursor.offset));
    while (cursor.offset < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - cursor.offset), cursor.offset);
      if (!bytesRead) break;
      cursor.offset += bytesRead;
      const lines = (cursor.rest + cursor.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      cursor.rest = lines.pop()!;
      // Title lines are short; a huge unfinished line is a tool result, so keep a stub that won't parse.
      if (cursor.rest.length > MAX_LINE) cursor.rest = "\0";
      for (const line of lines) {
        const t = titleIn(line);
        if (t) found.push(t);
      }
    }
    cursors.set(path, cursor);
    return found;
  } finally {
    await file.close();
  }
}

export function forgetTranscript(path: string): void {
  cursors.delete(path);
}
