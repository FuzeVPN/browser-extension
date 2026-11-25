// SPDX-License-Identifier: MPL-2.0

/** A browser shows a popup at most this tall: a taller page scrolls inside it. */
export const POPUP_MAX_HEIGHT = 600;
/** Each level tightens the layout a little more; see `.shell[data-fit]` in popup.css. */
export const FIT_LEVELS = 3;
/** How long the window of a popup is given to follow its page before its height is read. */
export const WINDOW_SETTLE_MS = 150;
/**
 * A window shorter than its page by no more than this is not taken for a limit: with a
 * fractional display scale, the browser rounds the two heights apart by a pixel.
 */
const ROUNDING = 1;

interface Fitted {
  dataset: DOMStringMap;
}

/**
 * Tightens the page level by level until it fits `limit` without scrolling, and
 * returns the level reached. A page which fits keeps its full layout; one which the
 * last level cannot fit, with an error banner for instance, scrolls as before.
 */
export function fitPopup(
  shell: Fitted,
  pageHeight: () => number,
  limit = POPUP_MAX_HEIGHT,
): number {
  let level = 0;
  delete shell.dataset.fit;
  while (level < FIT_LEVELS && pageHeight() > limit) {
    level += 1;
    shell.dataset.fit = String(level);
  }
  return level;
}

/** What has a height on the page, fractions of a pixel included. */
interface Box {
  getBoundingClientRect(): { height: number };
}

/** A disclosure of the page, as the fitter reads it. */
interface Disclosure extends Box {
  querySelector(selector: "summary"): Box | null;
}

/**
 * The height which the open disclosures add under their summary.
 *
 * A text the reader asked for by opening it is theirs to scroll: the page is fitted
 * for what it shows unasked, so that opening one moves nothing else. Heights are read
 * with their fractions: rounded one by one, they would not add up to the page's.
 */
export function openedHeight(disclosures: ArrayLike<Disclosure>): number {
  let height = 0;
  for (const disclosure of Array.from(disclosures))
    height += Math.max(
      0,
      disclosure.getBoundingClientRect().height -
        (disclosure.querySelector("summary")?.getBoundingClientRect().height ?? 0),
    );
  return height;
}

/** A change of the page, as its observer reports it. */
interface PageChange {
  type: string;
  target: unknown;
  attributeName?: string | null;
  oldValue?: string | null;
}

/**
 * Whether a change of the page may change its height. The level the fitting itself
 * writes on the shell does not, nor an attribute set again to the value it had: the
 * page sets many of these at every poll of its state, and fitting again for them would
 * take the level away and put it back each time.
 */
export function mayChangeHeight(
  change: PageChange,
  shell: unknown,
  value: (target: unknown, attribute: string) => string | null,
): boolean {
  if (change.type !== "attributes" || !change.attributeName) return true;
  if (change.target === shell && change.attributeName === "data-fit") return false;
  return value(change.target, change.attributeName) !== (change.oldValue ?? null);
}

/** What the fitter reads of the window which shows the page. */
export interface PopupWindow {
  /** The height of the content of the page. */
  contentHeight(): number;
  /** The height of the window which shows it. */
  windowHeight(): number;
  /**
   * Runs `check` once the window has had the time to follow its page. A new call
   * replaces the one which was waiting.
   */
  whenSettled(check: () => void): void;
}

/**
 * Keeps the page fitted to the height its window really has.
 *
 * A browser gives a popup 600 px at most, and less when the page is zoomed or the
 * screen is small. Nothing tells the page how much: the window of a popup grows with
 * its page up to that limit, then stops. A page still taller than its window, once the
 * window has had the time to follow, is in a window which will not grow: its height is
 * then the limit to fit, until the zoom or the screen changes.
 */
export class PopupFitter {
  /** The height the window was seen to stop at, when that is less than the usual one. */
  private windowLimit: number | null = null;

  constructor(
    private readonly shell: Fitted,
    private readonly popup: PopupWindow,
  ) {}

  /** Fits the page now, and looks at its window once it has settled. */
  fit(): number {
    const level = fitPopup(this.shell, () => this.popup.contentHeight(), this.limit());
    this.popup.whenSettled(() => this.observeWindow());
    return level;
  }

  /** The zoom or the screen changed: what was learnt of the window no longer holds. */
  windowChanged(): void {
    this.windowLimit = null;
    this.fit();
  }

  /** The window was resized: one now taller than the limit learnt has a new one. */
  windowResized(): void {
    if (this.windowLimit !== null && this.popup.windowHeight() > this.windowLimit)
      this.windowChanged();
  }

  private limit(): number {
    return Math.min(POPUP_MAX_HEIGHT, this.windowLimit ?? POPUP_MAX_HEIGHT);
  }

  private observeWindow(): void {
    const height = this.popup.windowHeight();
    if (this.popup.contentHeight() - height <= ROUNDING || height >= this.limit()) return;
    this.windowLimit = height;
    this.fit();
  }
}

/** Fits the page now, then again whenever its content or its window changes. */
export function keepPopupFitted(shell: HTMLElement): void {
  let settling: ReturnType<typeof setTimeout> | undefined;
  const fitter = new PopupFitter(shell, {
    // The height of the content itself: the root's scroll height is never below the
    // viewport, which is taller than a popup when the page is opened in a tab. What
    // the reader opened of a disclosure left apart from the fitting is not counted.
    contentHeight: () => {
      const opened = openedHeight(
        shell.querySelectorAll<HTMLElement>("details[open][data-fit-apart]"),
      );
      return opened === 0
        ? shell.offsetHeight
        : Math.round(shell.getBoundingClientRect().height - opened);
    },
    windowHeight: () => window.innerHeight,
    whenSettled(check) {
      clearTimeout(settling);
      settling = setTimeout(check, WINDOW_SETTLE_MS);
    },
  });
  const fit = () => void fitter.fit();
  fit();
  // Texts differ by language and state: the page is fitted as soon as its content
  // changes, before the browser lays it out, so that no frame shows it unfitted.
  const attribute = (target: unknown, name: string) => (target as Element).getAttribute(name);
  new MutationObserver((changes) => {
    if (changes.some((change) => mayChangeHeight(change, shell, attribute))) fit();
  }).observe(shell, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
  });
  // Whatever else changes the height, a font which loads for instance, is seen by its
  // size. That observer only asks for a fitting, made before the next frame: a callback
  // which resized what it observes is reported by the browser as an observer loop, among
  // the errors of the extension.
  let asked = false;
  new ResizeObserver(() => {
    if (asked) return;
    asked = true;
    requestAnimationFrame(() => {
      asked = false;
      fit();
    });
  }).observe(shell);
  void document.fonts.ready.then(fit);
  window.addEventListener("resize", () => fitter.windowResized());
  // A zoom, or a move to another screen, changes the pixel ratio of the page.
  const watchPixelRatio = () => {
    matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`).addEventListener(
      "change",
      () => {
        fitter.windowChanged();
        watchPixelRatio();
      },
      { once: true },
    );
  };
  watchPixelRatio();
}
