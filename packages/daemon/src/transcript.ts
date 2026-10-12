// Follows Claude Code's transcript files. Each read starts where the last one stopped, so
// following a long session only costs the bytes it appended since.
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TitleSource } from "./bots.js";

const CHUNK = 1 << 20;
/** Title lines are short; a huge unfinished line is a tool result. */
const MAX_TITLE_LINE = 1 << 16;

/** Paths come from hook bodies and the session registry; anything else isn't a transcript. */
export const isTranscriptPath = (path: string) => isAbsolute(path) && path.endsWith(".jsonl");

/** Reads a JSONL file incrementally. The decoder holds a character split between chunks. */
export class JsonlTail {
  private offset = 0;
  private rest = "";
  private decoder = new StringDecoder("utf8");

  constructor(readonly path: string, private readonly maxLine: number) {}

  /**
   * Complete lines appended since the last call. A file that shrank was rewritten, so it is read
   * again from the start and `reset` is set. An unfinished line over maxLine becomes a stub that
   * won't parse, so a huge line costs no memory while it streams in.
   */
  async read(): Promise<{ lines: string[]; reset: boolean }> {
    const file = await open(this.path, "r");
    try {
      const { size } = await file.stat();
      const reset = size < this.offset;
      if (reset) {
        this.offset = 0;
        this.rest = "";
        this.decoder = new StringDecoder("utf8");
      }
      const lines: string[] = [];
      const buffer = Buffer.alloc(Math.min(CHUNK, size - this.offset));
      while (this.offset < size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const parts = (this.rest + this.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
        this.rest = parts.pop()!;
        if (this.rest.length > this.maxLine) this.rest = "\0";
        for (const part of parts) lines.push(part);
      }
      return { lines, reset };
    } finally {
      await file.close();
    }
  }
}

/** Claude Code writes `ai-title` lines as the session goes on and a `custom-title` line on /rename. */
export function titleIn(line: string): { title: string; source: TitleSource } | undefined {
  if (!line.includes("-title")) return;
  try {
    const entry = JSON.parse(line);
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") return { title: entry.customTitle, source: "custom" };
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") return { title: entry.aiTitle, source: "ai" };
  } catch {}
}

const titleTails = new Map<string, JsonlTail>();

/** The titles appended to the transcript since the last call, oldest first. */
export async function newTitles(path: string): Promise<{ title: string; source: TitleSource }[]> {
  if (!isTranscriptPath(path)) return [];
  let tail = titleTails.get(path);
  if (!tail) titleTails.set(path, (tail = new JsonlTail(path, MAX_TITLE_LINE)));
  const found = [];
  for (const line of (await tail.read()).lines) {
    const t = titleIn(line);
    if (t) found.push(t);
  }
  return found;
}

export function forgetTranscript(path: string): void {
  titleTails.delete(path);
}
