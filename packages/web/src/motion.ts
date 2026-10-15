// The app's motion, as named effects: callers say what moves, the timing lives here. Every effect
// leaves no inline styles behind once it ends, and with reduced motion each one ends at once.
import { animate, frame, stagger } from "motion";

/** The one spring everything moves on: quick, with a little give. */
const SPRING: { type: "spring"; visualDuration: number; bounce: number } = { type: "spring", visualDuration: 0.35, bounce: 0.2 };
/** The same spring without the give, for height: past 0 is not a height, so a collapse would stall there. */
const FIRM = { ...SPRING, bounce: 0 };
// Ends are spelled out in full: Motion reads "none" as all zeros, which would scale to nothing.
// Opacity goes as numbers: given strings, Motion jumps straight to the end.
const PROPS = ["opacity", "transform", "height", "overflow"];

type Frames = { opacity?: [number, number] } & Partial<Record<"transform" | "height", [string, string]>>;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The effect running on each element, so a new one takes over instead of fighting it. */
const running = new WeakMap<Element, { stop(): void }>();

const clear = (el: HTMLElement) => PROPS.forEach((p) => el.style.removeProperty(p));
/** Motion writes an effect's end values once more on its next frame, so clearing waits until after that. */
const afterMotion = () => (reduced() ? Promise.resolve() : new Promise<void>((r) => frame.render(() => r())));

/** Resolves true when the effect played to the end, false when another one took over the element. */
function play(el: HTMLElement, frames: Frames, spring = SPRING): Promise<boolean> {
  running.get(el)?.stop();
  running.delete(el);
  if (reduced()) return Promise.resolve(true);
  // Motion starts on a later frame; showing the first frame now keeps the end state from flashing.
  for (const [k, v] of Object.entries(frames) as [keyof Frames, [string | number, unknown]][]) el.style[k] = String(v[0]);
  return new Promise((resolve) => {
    const controls = animate(el, frames, spring);
    const effect = { stop: () => (controls.stop(), resolve(false)) };
    running.set(el, effect);
    controls.finished.then(
      () => {
        if (running.get(el) === effect) running.delete(el);
        resolve(true);
      },
      () => resolve(false),
    );
  });
}

/** Plays an effect and clears its styles once it ends; an interrupted effect leaves them to its successor. */
async function settle(el: HTMLElement, frames: Frames, spring = SPRING): Promise<boolean> {
  if (!(await play(el, frames, spring))) return false;
  await afterMotion();
  if (!running.has(el)) clear(el);
  return true;
}

/** The chat sheet slides in from the right edge; mid-slide-out it turns around where it is. */
export function slideIn(el: HTMLElement): Promise<boolean> {
  const now = running.has(el) ? getComputedStyle(el).transform : "none";
  return settle(el, { transform: [now === "none" ? "translateX(100%)" : now, "translateX(0px)"] });
}

/** The reverse: the sheet slides out to the right. The caller hides it once this resolves true. */
export function slideOut(el: HTMLElement): Promise<boolean> {
  const now = getComputedStyle(el).transform;
  return settle(el, { transform: [now === "none" ? "translateX(0px)" : now, "translateX(100%)"] });
}

/** New entries fade in and rise into place, one after another. */
export function enter(els: HTMLElement[]): void {
  if (!els.length || reduced()) return;
  for (const el of els) (el.style.opacity = "0"), (el.style.transform = "translateY(8px)");
  animate(els, { opacity: [0, 1], transform: ["translateY(8px)", "translateY(0px)"] }, { ...SPRING, delay: stagger(0.04) })
    .then(afterMotion)
    .then(() => els.forEach(clear));
}

/** A disclosure body opens from 0 to its height; mid-collapse it opens again from where it is. */
export function expand(el: HTMLElement): Promise<boolean> {
  const mid = running.has(el);
  const from = mid ? `${el.offsetHeight}px` : "0px";
  const opacity = mid ? Number(getComputedStyle(el).opacity) : 0;
  running.get(el)?.stop();
  el.style.removeProperty("height");
  const to = `${el.offsetHeight}px`;
  el.style.overflow = "hidden";
  return settle(el, { height: [from, to], opacity: [opacity, 1] }, FIRM);
}

/** A disclosure body closes to 0. The caller closes its <details> once this resolves true. */
export function collapse(el: HTMLElement): Promise<boolean> {
  const from = `${el.offsetHeight}px`;
  el.style.overflow = "hidden";
  return settle(el, { height: [from, "0px"], opacity: [Number(getComputedStyle(el).opacity), 0] }, FIRM);
}

/** A popup springs up from its bottom centre, where its tail is. */
export function pop(el: HTMLElement): void {
  el.style.transformOrigin = "50% 100%";
  void settle(el, { transform: ["translateY(6px) scale(0.94)", "translateY(0px) scale(1)"] });
}
