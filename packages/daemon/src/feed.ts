// Follows one session's transcript, and its subagents' transcripts, for the chat view. Every open
// chat on a session shares one feed, which keeps the entries so another viewer gets them at once.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatEntry, ChatEvent, Command } from "@hamlet/shared";
import { commandsIn, toEntries } from "./chat.js";
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
  /** The session's "/" commands, from its transcript's skill listings. */
  private commands = new Map<string, Command>();
  private failed: "unreadable" | "no-transcript" | undefined;

  constructor(readonly path: string, private readonly onError: (e: unknown) => void = () => {}) {
    this.main = new JsonlTail(path, MAX_LINE);
  }

  get viewers(): number {
    return this.listeners.size;
  }

  /** Sends everything read so far, then each change. Returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    for (let i = 0; i < this.entries.length; i += BATCH) this.deliver(listener, { entries: this.entries.slice(i, i + BATCH) });
    if (this.commands.size) this.deliver(listener, { commands: [...this.commands.values()] });
    if (this.failed) this.deliver(listener, { error: this.failed });
    this.listeners.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  /** Removes and returns the listeners, so they can move to another feed for the same session. */
  takeListeners(): Listener[] {
    const taken = [...this.listeners];
    this.listeners.clear();
    return taken;
  }

  /** Moves listeners from a feed that was replaced: each is told to start over, then gets this feed's events. */
  adopt(listeners: Listener[]): void {
    for (const listener of listeners) {
      this.deliver(listener, { reset: true });
      this.listeners.add(listener);
    }
  }

  /** Reads what the main transcript and each subagent transcript appended since the last poll. */
  async poll(): Promise<void> {
    let read: { lines: string[]; reset: boolean };
    try {
      read = await this.main.read();
    } catch (e) {
      // A new session's transcript may not exist yet: that is waiting, not an error.
      const state = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "no-transcript" : "unreadable";
      if (this.failed !== state) {
        this.failed = state;
        if (state === "unreadable") this.onError(e);
        this.emit({ error: state });
      }
      return;
    }
    this.failed = undefined;
    if (read.reset) {
      this.entries.length = 0;
      this.subagents.clear();
      this.commands.clear();
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
    // Only the main transcript's listing is the session's; subagents get their own.
    let listed = false;
    for (const line of read.lines) {
      const found = commandsIn(line);
      if (!found) continue;
      if (found.initial) this.commands.clear();
      for (const c of found.commands) this.commands.set(c.name, c);
      listed = true;
    }
    if (listed) this.emit({ commands: [...this.commands.values()] });
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
    for (const listener of this.listeners) this.deliver(listener, e);
  }

  /** A listener that throws must not stop the others getting the event, or reject the poll. */
  private deliver(listener: Listener, e: ChatEvent): void {
    try {
      listener(e);
    } catch (err) {
      this.onError(err);
    }
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
    // A hook's path replaces one found in the session registry: the viewers move to a feed on that path.
    if (f && f.feed.path !== path) {
      const moved = f.feed.takeListeners();
      this.drop(sessionId);
      f = this.open(sessionId, path);
      f.feed.adopt(moved);
    }
    if (!f) f = this.open(sessionId, path);
    f.feed.subscribe(listener);
    // The feed can be replaced while the viewer is connected, so look it up when leaving.
    return () => this.feeds.get(sessionId)?.feed.unsubscribe(listener);
  }

  drop(sessionId: string): void {
    const f = this.feeds.get(sessionId);
    if (!f) return;
    clearInterval(f.timer);
    this.feeds.delete(sessionId);
  }

  private open(sessionId: string, path: string) {
    const feed = new ChatFeed(path, (e) => this.onError(sessionId, e));
    const f = { feed, timer: this.start(sessionId, feed) };
    this.feeds.set(sessionId, f);
    return f;
  }

  private start(sessionId: string, feed: ChatFeed): NodeJS.Timeout {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await feed.poll();
      } catch (e) {
        this.onError(sessionId, e);
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
