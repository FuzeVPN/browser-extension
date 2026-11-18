// SPDX-License-Identifier: MPL-2.0

import { FIT_LEVELS, POPUP_MAX_HEIGHT, PopupFitter, fitPopup } from "../../src/ui/popup/fit";

/** A page whose height depends on the level its shell asks for. */
function page(heights: number[], initial?: string) {
  const shell: { dataset: DOMStringMap } = {
    dataset: initial === undefined ? {} : { fit: initial },
  };
  const measured: number[] = [];
  const height = () => {
    const level = Number(shell.dataset.fit ?? 0);
    measured.push(level);
    return heights[level] ?? heights.at(-1) ?? 0;
  };
  return { shell, height, measured };
}

describe("fitting the popup page to the height a browser gives it", () => {
  it("keeps the full layout of a page which fits", () => {
    const p = page([POPUP_MAX_HEIGHT, 580, 560, 540]);

    expect(fitPopup(p.shell, p.height)).toBe(0);
    expect(p.shell.dataset.fit).toBeUndefined();
    expect(p.measured).toEqual([0]);
  });

  it("tightens only as far as the page needs", () => {
    const p = page([620, 604, 590, 560]);

    expect(fitPopup(p.shell, p.height)).toBe(2);
    expect(p.shell.dataset.fit).toBe("2");
  });

  it("stops at the last level when the page still does not fit", () => {
    const p = page([900, 880, 860, 840]);

    expect(fitPopup(p.shell, p.height)).toBe(FIT_LEVELS);
    expect(p.shell.dataset.fit).toBe(String(FIT_LEVELS));
    expect(p.measured).toEqual([0, 1, 2]);
  });

  it("returns to the full layout once the content is shorter again", () => {
    const p = page([590, 570, 550, 530], "3");

    expect(fitPopup(p.shell, p.height)).toBe(0);
    expect(p.shell.dataset.fit).toBeUndefined();
  });

  it("treats a page of exactly the popup height as fitting", () => {
    const p = page([POPUP_MAX_HEIGHT + 1, POPUP_MAX_HEIGHT]);

    expect(fitPopup(p.shell, p.height)).toBe(1);
  });
});

/** A popup whose window follows its page up to what the browser gives it. */
function popup(heights: number[], given: number) {
  const shell: { dataset: DOMStringMap } = { dataset: {} };
  let settled: (() => void) | null = null;
  const content = () => heights[Number(shell.dataset.fit ?? 0)] ?? heights.at(-1) ?? 0;
  const window = {
    given,
    contentHeight: content,
    windowHeight: () => Math.min(content(), window.given),
    whenSettled(check: () => void) {
      settled = check;
    },
  };
  const fitter = new PopupFitter(shell, window);
  return {
    shell,
    fitter,
    window,
    /** The window has followed its page: what was waiting for that runs, once. */
    settle() {
      const check = settled;
      settled = null;
      check?.();
      return shell.dataset.fit;
    },
    scrolls: () => content() > window.windowHeight(),
  };
}

describe("fitting the popup page to a window which the browser makes shorter", () => {
  it("keeps the full layout in the usual window, whose height follows the page", () => {
    const p = popup([560, 540, 520, 500], POPUP_MAX_HEIGHT);

    expect(p.fitter.fit()).toBe(0);
    expect(p.settle()).toBeUndefined();
    expect(p.scrolls()).toBe(false);
  });

  it("tightens the page to a window which stopped growing below it", () => {
    // Zoomed to 125 %, the popup is given 480 px of the page's own.
    const p = popup([560, 520, 490, 470], 480);

    expect(p.fitter.fit()).toBe(0);
    expect(p.scrolls()).toBe(true);

    expect(p.settle()).toBe("3");
    expect(p.scrolls()).toBe(false);
    // The window now follows the shorter page: nothing more is learnt from it.
    expect(p.settle()).toBe("3");
  });

  it("tightens only as far as that window needs", () => {
    const p = popup([560, 530, 500, 470], 540);
    p.fitter.fit();
    expect(p.settle()).toBe("1");
  });

  it("keeps the limit it learnt when the content changes", () => {
    const heights = [560, 520, 490, 470];
    const p = popup(heights, 480);
    p.fitter.fit();
    p.settle();

    // A banner leaves: the page is fitted again, to the window it knows.
    heights.splice(0, 4, 540, 500, 476, 460);
    expect(p.fitter.fit()).toBe(2);
    expect(p.scrolls()).toBe(false);
  });

  it("stops at the last level in a window which nothing fits, without trying again", () => {
    const p = popup([700, 680, 660, 640], 480);
    p.fitter.fit();
    expect(p.settle()).toBe(String(FIT_LEVELS));
    const measured = vi.spyOn(p.window, "contentHeight");

    expect(p.settle()).toBe(String(FIT_LEVELS));
    // One look at the settled window, which teaches nothing new: no other fitting.
    expect(measured).toHaveBeenCalledTimes(1);
  });

  it("does not take a pixel of rounding for a window which stopped growing", () => {
    const p = popup([547, 520, 490, 470], POPUP_MAX_HEIGHT);
    // A fractional display scale: the window is reported one pixel under its page.
    p.window.windowHeight = () => 546;
    p.fitter.fit();
    expect(p.settle()).toBeUndefined();
  });

  it("returns to the full layout when the zoom or the screen changes", () => {
    const p = popup([560, 520, 490, 470], 480);
    p.fitter.fit();
    expect(p.settle()).toBe("3");

    p.window.given = POPUP_MAX_HEIGHT;
    p.fitter.windowChanged();
    expect(p.shell.dataset.fit).toBeUndefined();
    expect(p.settle()).toBeUndefined();
  });

  it("learns a new limit after such a change", () => {
    const p = popup([560, 520, 490, 470], 480);
    p.fitter.fit();
    p.settle();

    p.window.given = 530;
    p.fitter.windowChanged();
    expect(p.settle()).toBe("1");
  });

  it("returns to the full layout in a window resized taller than the limit learnt", () => {
    // The page opened in a tab, whose window the user then enlarges.
    const p = popup([560, 520, 490, 470], 480);
    p.fitter.fit();
    expect(p.settle()).toBe("3");

    p.fitter.windowResized();
    expect(p.shell.dataset.fit).toBe("3");

    p.window.given = 900;
    p.window.windowHeight = () => 900;
    p.fitter.windowResized();
    expect(p.shell.dataset.fit).toBeUndefined();
  });

  it("never fits to more than the usual height, however tall the window", () => {
    // In a tab the window is taller than a popup: the page is fitted as for a popup.
    const p = popup([620, 604, 590, 560], 900);
    p.window.windowHeight = () => 900;
    expect(p.fitter.fit()).toBe(2);
    expect(p.settle()).toBe("2");
  });
});
