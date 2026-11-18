// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from "vitest";
import { setContent, setDisabled, setText } from "../../src/ui/popup/dom";

/** An element which counts what is written in it. */
function element(text = "") {
  let current = text;
  const target = {
    writes: 0,
    get textContent(): string {
      return current;
    },
    set textContent(value: string) {
      target.writes += 1;
      current = value;
    },
    replaceChildren(...nodes: (Node | string)[]): void {
      target.writes += 1;
      current = nodes.map(String).join("");
    },
  };
  return target;
}

/** A page whose focus leaves a control which is disabled, as browsers do. */
function page() {
  const body = {};
  const document = { activeElement: body as unknown, body };
  const control = () => {
    let disabled = false;
    const self = {
      ownerDocument: document,
      get disabled(): boolean {
        return disabled;
      },
      set disabled(value: boolean) {
        disabled = value;
        if (value && document.activeElement === self) document.activeElement = body;
      },
      focus: vi.fn(() => {
        if (!disabled) document.activeElement = self;
      }),
    };
    return self;
  };
  return { document, body, control };
}

describe("a control disabled while its own action is pending", () => {
  it("gets back the keyboard focus it had, once it is enabled again", () => {
    const { document, body, control } = page();
    const refresh = control();
    refresh.focus();
    refresh.focus.mockClear();

    setDisabled(refresh, true);
    expect(document.activeElement).toBe(body);
    setDisabled(refresh, false);

    expect(document.activeElement).toBe(refresh);
    expect(refresh.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("does not take the focus which went elsewhere meanwhile", () => {
    const { document, control } = page();
    const refresh = control();
    const other = control();
    refresh.focus();
    setDisabled(refresh, true);
    other.focus();
    refresh.focus.mockClear();

    setDisabled(refresh, false);

    expect(document.activeElement).toBe(other);
    expect(refresh.focus).not.toHaveBeenCalled();
  });

  it("does not take a focus it never had", () => {
    const { document, body, control } = page();
    const refresh = control();
    setDisabled(refresh, true);
    setDisabled(refresh, false);
    expect(document.activeElement).toBe(body);
    expect(refresh.focus).not.toHaveBeenCalled();
  });

  it("gives the focus back once only", () => {
    const { control } = page();
    const refresh = control();
    refresh.focus();
    setDisabled(refresh, true);
    setDisabled(refresh, false);
    refresh.focus.mockClear();

    // Disabled again without the focus, by an action which is not its own.
    const other = control();
    other.focus();
    setDisabled(refresh, true);
    (refresh.ownerDocument as { activeElement: unknown }).activeElement =
      refresh.ownerDocument.body;
    setDisabled(refresh, false);
    expect(refresh.focus).not.toHaveBeenCalled();
  });

  it("remembers the last control which lost the focus that way", () => {
    const { document, control } = page();
    const first = control();
    const second = control();
    first.focus();
    setDisabled(first, true);
    second.focus();
    setDisabled(second, true);

    setDisabled(first, false);
    expect(document.activeElement).not.toBe(first);
    setDisabled(second, false);
    expect(document.activeElement).toBe(second);
  });

  it("writes the state of a control only when it changes", () => {
    const { control } = page();
    const refresh = control();
    const written = vi.spyOn(refresh, "disabled", "set");
    setDisabled(refresh, false);
    setDisabled(refresh, true);
    setDisabled(refresh, true);
    expect(written).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("the writers of the popup, which change the page only when it changes", () => {
  it("writes a text once, however often it is given", () => {
    const target = element();
    setText(target, "Paris");
    setText(target, "Paris");
    setText(target, "Paris");
    expect(target.textContent).toBe("Paris");
    expect(target.writes).toBe(1);
  });

  it("does not write the text which the page already has", () => {
    const target = element("Paris");
    setText(target, "Paris");
    expect(target.writes).toBe(0);
  });

  it("writes a text which changes, and an empty one", () => {
    const target = element("Paris");
    setText(target, "Berlin");
    setText(target, "");
    expect(target.textContent).toBe("");
    expect(target.writes).toBe(2);
  });

  it("builds and replaces children only when their key changes", () => {
    const target = element();
    const build = vi.fn(() => ["IP · ", "8.8.8.8"]);
    setContent(target, "a", build);
    setContent(target, "a", build);
    expect(build).toHaveBeenCalledOnce();
    expect(target.writes).toBe(1);

    setContent(target, "b", () => ["IP · ", "8.8.4.4"]);
    expect(target.textContent).toBe("IP · 8.8.4.4");
    expect(target.writes).toBe(2);
  });

  it("replaces children again after a text was written in their place", () => {
    const target = element();
    setContent(target, "a", () => ["IP · ", "8.8.8.8"]);
    // Another state of the popup writes this element as a plain text.
    setText(target, "unavailable");
    setContent(target, "a", () => ["IP · ", "8.8.8.8"]);
    expect(target.textContent).toBe("IP · 8.8.8.8");
    expect(target.writes).toBe(3);
  });

  it("forgets the key even when the text written is the one shown", () => {
    const target = element();
    setContent(target, "a", () => ["same"]);
    setText(target, "same");
    setContent(target, "a", () => ["same"]);
    // The children are built again: a text node is not the children which were built.
    expect(target.writes).toBe(2);
  });

  it("keeps a key for each element", () => {
    const first = element();
    const second = element();
    setContent(first, "a", () => ["one"]);
    setContent(second, "a", () => ["two"]);
    expect(second.textContent).toBe("two");
  });
});
