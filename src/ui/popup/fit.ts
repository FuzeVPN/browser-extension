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
    // viewport, which is taller than a popup when the page is opened in a tab.
    contentHeight: () => shell.offsetHeight,
    windowHeight: () => window.innerHeight,
    whenSettled(check) {
      clearTimeout(settling);
      settling = setTimeout(check, WINDOW_SETTLE_MS);
    },
  });
  const fit = () => void fitter.fit();
  fit();
  // Texts differ by language and state, and fonts load after the first layout.
  new ResizeObserver(fit).observe(shell);
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
