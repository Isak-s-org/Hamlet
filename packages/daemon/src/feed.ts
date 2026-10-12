// Follows one session's transcript, and its subagents' transcripts, for the chat view. Every open
// chat on a session shares one feed, which keeps the entries so another viewer gets them at once.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatEntry, ChatEvent } from "@hamlet/shared";
import { toEntries } from "./chat.js";
import { JsonlTail } from "./transcript.js";

/** Entries per SSE message, so a long backlog renders progressively. */
export const BATCH = 500;
/** Tool results can be megabytes; an unfinished line over this is dropped. */
const MAX_LINE = 8 << 20;

type Listener = (e: ChatEvent) => void;

export class ChatFeed {
  readonly entries: ChatEntry[] = [];
  private main: JsonlTail;
  private subagents = new Map<string, { tail: JsonlTail; parent: string }>();
  private listeners = new Set<Listener>();
  private failed = false;

  constructor(readonly path: string, private readonly onError: (e: unknown) => void = () => {}) {
    this.main = new JsonlTail(path, MAX_LINE);
  }

  get viewers(): number {
    return this.listeners.size;
  }

  /** Sends everything read so far, then each change. Returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    for (let i = 0; i < this.entries.length; i += BATCH) listener({ entries: this.entries.slice(i, i + BATCH) });
    if (this.failed) listener({ error: "unreadable" });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads what the main transcript and each subagent transcript appended since the last poll. */
  async poll(): Promise<void> {
    let read: { lines: string[]; reset: boolean };
    try {
      read = await this.main.read();
    } catch (e) {
      if (!this.failed) {
        this.failed = true;
        this.onError(e);
        this.emit({ error: "unreadable" });
      }
      return;
    }
    this.failed = false;
    if (read.reset) {
      this.entries.length = 0;
      this.subagents.clear();
      this.emit({ reset: true });
    }
    const fresh = read.lines.flatMap((line) => toEntries(line));
    for (const sub of await this.subagentTails()) {
      try {
        for (const line of (await sub.tail.read()).lines) fresh.push(...toEntries(line, sub.parent));
      } catch (e) {
        this.onError(e);
      }
    }
    for (const entry of fresh) this.entries.push(entry);
    for (let i = 0; i < fresh.length; i += BATCH) this.emit({ entries: fresh.slice(i, i + BATCH) });
  }

  /** Subagents write <session>/subagents/agent-<id>.jsonl beside a meta file naming the call that started them. */
  private async subagentTails() {
    const dir = join(this.path.replace(/\.jsonl$/, ""), "subagents");
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const id = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
      if (!id || this.subagents.has(id)) continue;
      try {
        const meta = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), "utf8"));
        if (typeof meta.toolUseId === "string") this.subagents.set(id, { tail: new JsonlTail(join(dir, name), MAX_LINE), parent: meta.toolUseId });
      } catch {} // the meta file may not be written yet; the next poll tries again
    }
    return [...this.subagents.values()];
  }

  private emit(e: ChatEvent): void {
    for (const listener of this.listeners) listener(e);
  }
}

/** One feed per session, polled while anyone watches it and dropped a while after the last viewer leaves. */
export class Feeds {
  private feeds = new Map<string, { feed: ChatFeed; timer: NodeJS.Timeout; idleSince?: number }>();

  constructor(
    private readonly onError: (sessionId: string, e: unknown) => void,
    private readonly everyMs = 500,
    private readonly graceMs = 30_000,
  ) {}

  get size(): number {
    return this.feeds.size;
  }

  subscribe(sessionId: string, path: string, listener: Listener): () => void {
    let f = this.feeds.get(sessionId);
    // A hook's path replaces one found in the session registry.
    if (f && f.feed.path !== path) this.drop(sessionId), (f = undefined);
    if (!f) {
      const feed = new ChatFeed(path, (e) => this.onError(sessionId, e));
      f = { feed, timer: this.start(sessionId, feed) };
      this.feeds.set(sessionId, f);
    }
    return f.feed.subscribe(listener);
  }

  drop(sessionId: string): void {
    const f = this.feeds.get(sessionId);
    if (!f) return;
    clearInterval(f.timer);
    this.feeds.delete(sessionId);
  }

  private start(sessionId: string, feed: ChatFeed): NodeJS.Timeout {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await feed.poll();
      } finally {
        busy = false;
      }
      const f = this.feeds.get(sessionId);
      if (!f || f.feed !== feed) return;
      if (feed.viewers) delete f.idleSince;
      else if ((f.idleSince ??= Date.now()) + this.graceMs <= Date.now()) this.drop(sessionId);
    };
    void tick();
    const timer = setInterval(tick, this.everyMs);
    timer.unref();
    return timer;
  }
}
