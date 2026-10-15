// Follows one session's transcript, and its subagents' transcripts, for the chat view. Every open
// chat on a session shares one feed, which keeps the entries so another viewer gets them at once.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatEntry, ChatEvent, Command, Subagent } from "@hamlet/shared";
import { applyQueueOp, commandsIn, toEntries, tokensOf, typed } from "./chat.js";
import { JsonlTail } from "./transcript.js";

/** Entries per SSE message, so a long backlog renders progressively. */
export const BATCH = 500;
/** Tool results can be megabytes; an unfinished line over this is dropped. */
const MAX_LINE = 8 << 20;

type Listener = (e: ChatEvent) => void;

export class ChatFeed {
  readonly entries: ChatEntry[] = [];
  private main: JsonlTail;
  private subagents = new Map<string, { tail: JsonlTail; info: Subagent }>();
  /** Tool calls that came back as errors, so a failed Agent call marks its subagent. */
  private failedCalls = new Set<string>();
  private listeners = new Set<Listener>();
  /** The session's "/" commands, from its transcript's skill listings. */
  private commands = new Map<string, Command>();
  private failed: "unreadable" | "no-transcript" | undefined;
  /** Claude Code's input queue, notifications included; viewers get only what was typed. */
  private queue: string[] = [];

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
    if (this.subagents.size) this.deliver(listener, { subagents: this.summaries() });
    if (this.queue.some(typed)) this.deliver(listener, { queued: this.queue.filter(typed) });
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
      this.failedCalls.clear();
      this.commands.clear();
      this.queue = [];
      this.emit({ reset: true });
    }
    const fresh = read.lines.flatMap((line) => toEntries(line));
    const known = this.subagents.size;
    let subChanged = false;
    for (const sub of await this.subagentTails()) {
      try {
        for (const line of (await sub.tail.read()).lines) {
          const entries = toEntries(line, sub.info.parent);
          fresh.push(...entries);
          sub.info.tokens = tokensOf(line) ?? sub.info.tokens;
          for (const e of entries) {
            if (e.kind === "tool") sub.info.tools++;
            if (e.at) (sub.info.start ??= e.at), (sub.info.last = e.at);
          }
          subChanged = true;
        }
      } catch (e) {
        this.onError(e);
      }
    }
    for (const entry of fresh) {
      this.entries.push(entry);
      if (entry.kind === "result" && entry.isError && !this.failedCalls.has(entry.toolUseId)) {
        this.failedCalls.add(entry.toolUseId);
        subChanged ||= [...this.subagents.values()].some((s) => s.info.parent === entry.toolUseId);
      }
    }
    for (let i = 0; i < fresh.length; i += BATCH) this.emit({ entries: fresh.slice(i, i + BATCH) });
    if (subChanged || this.subagents.size !== known) this.emit({ subagents: this.summaries() });
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
    let requeued = false;
    for (const line of read.lines) requeued = applyQueueOp(line, this.queue) || requeued;
    if (requeued) this.emit({ queued: this.queue.filter(typed) });
  }

  /** Subagents write <session>/subagents/agent-<id>.jsonl beside a meta file naming the call that started them. */
  private async subagentTails() {
    const dir = join(this.path.replace(/\.jsonl$/, ""), "subagents");
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const id = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
      if (!id || this.subagents.has(id)) continue;
      try {
        const meta = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), "utf8"));
        if (typeof meta.toolUseId !== "string") continue;
        const info: Subagent = { agentId: id, parent: meta.toolUseId, tokens: 0, tools: 0 };
        if (typeof meta.agentType === "string") info.type = meta.agentType;
        if (typeof meta.description === "string") info.description = meta.description;
        this.subagents.set(id, { tail: new JsonlTail(join(dir, name), MAX_LINE), info });
      } catch {} // the meta file may not be written yet; the next poll tries again
    }
    return [...this.subagents.values()];
  }

  private summaries(): Subagent[] {
    return [...this.subagents.values()].map(({ info }) => ({ ...info, ...(this.failedCalls.has(info.parent) ? { failed: true } : {}) }));
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
