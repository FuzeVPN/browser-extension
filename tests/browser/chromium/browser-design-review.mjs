// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";

// Measure rendered colors rather than pinning the design to a particular palette.
// The comparison uses each element's declared color against its nearest painted
// background. Decorative gradients are inspected separately in the saved captures.
export async function inspectDesign(
  page,
  { text = [], controls = [], primary = [], inView = [] } = {},
) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      return iterations === Infinity || animation.playState !== "running";
    }),
  );
  const measurement = await page.evaluate(
    ({ text, controls, primary, inView }) => {
      const visible = (node) => node.getClientRects().length > 0;
      const rgba = (value) => value.match(/[\d.]+/g)?.map(Number) ?? [];
      const paintedBackground = (node) => {
        for (let current = node; current; current = current.parentElement) {
          const color = getComputedStyle(current).backgroundColor;
          const channels = rgba(color);
          if (channels.length >= 3 && (channels[3] ?? 1) >= 0.99) return color;
        }
        return "rgb(255, 255, 255)";
      };
      const contrast = (foreground, background) => {
        const luminance = (color) => {
          const channels = rgba(color)
            .slice(0, 3)
            .map((channel) => {
              const linear = channel / 255;
              return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        };
        const a = luminance(foreground);
        const b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const nodes = (selectors) =>
        selectors.flatMap((selector) =>
          [...document.querySelectorAll(selector)]
            .filter(visible)
            .map((node) => ({ selector, node })),
        );
      return {
        viewport: { width: innerWidth, height: innerHeight },
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        missingImages: [...document.images]
          .filter(visible)
          .filter((node) => !node.complete || node.naturalWidth === 0)
          .map((node) => node.getAttribute("src")),
        text: nodes(text)
          .filter(({ node }) => !node.matches(":disabled") && node.textContent.trim())
          .map(({ selector, node }) => {
            const style = getComputedStyle(node);
            const background = paintedBackground(node);
            const size = Number.parseFloat(style.fontSize);
            const large = size >= 24 || (size >= 18.66 && Number.parseInt(style.fontWeight) >= 700);
            return {
              selector,
              foreground: style.color,
              background,
              contrast: contrast(style.color, background),
              required: large ? 3 : 4.5,
            };
          }),
        controls: nodes(controls).map(({ selector, node }) => {
          const box = node.getBoundingClientRect();
          return { selector, width: box.width, height: box.height };
        }),
        primary: nodes(primary).map(({ selector, node }) => {
          const box = node.getBoundingClientRect();
          return { selector, width: box.width, height: box.height };
        }),
        inView: nodes(inView).map(({ selector, node }) => {
          const box = node.getBoundingClientRect();
          return { selector, top: box.top, right: box.right, bottom: box.bottom, left: box.left };
        }),
        direction: document.documentElement.dir,
      };
    },
    { text, controls, primary, inView },
  );
  assert(measurement.horizontalOverflow <= 1, JSON.stringify(measurement));
  assert.deepEqual(measurement.missingImages, [], "A visible local image failed to load");
  for (const color of measurement.text)
    assert(
      color.contrast >= color.required,
      `Insufficient text contrast: ${JSON.stringify(color)}`,
    );
  for (const control of measurement.controls)
    assert(
      control.width >= 24 && control.height >= 24,
      `Small interactive target: ${JSON.stringify(control)}`,
    );
  for (const control of measurement.primary)
    assert(
      control.width >= 44 && control.height >= 44,
      `Small primary action: ${JSON.stringify(control)}`,
    );
  for (const control of measurement.inView)
    assert(
      control.left >= -1 &&
        control.top >= -1 &&
        control.right <= measurement.viewport.width + 1 &&
        control.bottom <= measurement.viewport.height + 1,
      `Primary action outside the popup viewport: ${JSON.stringify(control)}`,
    );
  return measurement;
}

export async function inspectKeyboardFocus(page) {
  const measurement = await page.evaluate(() => {
    const node = document.activeElement;
    const style = getComputedStyle(node);
    const channels = (value) => value.match(/[\d.]+/g)?.map(Number) ?? [];
    let background = "rgb(255, 255, 255)";
    for (let current = node.parentElement; current; current = current.parentElement) {
      const color = getComputedStyle(current).backgroundColor;
      const values = channels(color);
      if (values.length >= 3 && (values[3] ?? 1) >= 0.99) {
        background = color;
        break;
      }
    }
    const luminance = (color) => {
      const values = channels(color)
        .slice(0, 3)
        .map((channel) => {
          const linear = channel / 255;
          return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const a = luminance(style.outlineColor);
    const b = luminance(background);
    return {
      id: node.id,
      visible: node.matches(":focus-visible"),
      outline: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      opaque: (channels(style.outlineColor)[3] ?? 1) >= 0.99,
      background,
      contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
  });
  assert(measurement.visible, JSON.stringify(measurement));
  assert.notEqual(measurement.outlineStyle, "none");
  assert(measurement.outlineWidth >= 2 && measurement.opaque, JSON.stringify(measurement));
  assert(measurement.contrast >= 3, `Insufficient focus contrast: ${JSON.stringify(measurement)}`);
  return measurement;
}

export async function inspectReducedMotion(page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((node) =>
      [null, "::before", "::after"].map((pseudo) => {
        const style = getComputedStyle(node, pseudo);
        return {
          animation: style.animationName,
          duration: style.animationDuration.split(",").map(Number.parseFloat),
          iterations: style.animationIterationCount,
          transition: style.transitionDuration.split(",").map(Number.parseFloat),
        };
      }),
    ),
  );
  for (const style of animations) {
    assert(
      style.duration.every((duration) => duration <= 0.01),
      JSON.stringify(style),
    );
    assert(
      style.transition.every((duration) => duration <= 0.01),
      JSON.stringify(style),
    );
    if (style.animation !== "none") assert.notEqual(style.iterations, "infinite");
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  return { checkedStyles: animations.length };
}
