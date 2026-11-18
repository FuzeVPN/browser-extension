// SPDX-License-Identifier: MPL-2.0

/**
 * The popup renders its whole state at each reply of the worker, and the worker is asked
 * every few seconds. A text written again with the value it had is a change of the page
 * all the same: the browser lays it out again, and a screen reader reads again the
 * regions which announce their changes. These writers change the page only when what
 * it shows changes.
 */

/** The control which had the keyboard focus when it was disabled. */
let parked: object | null = null;

interface Control {
  disabled: boolean;
  readonly ownerDocument: { readonly activeElement: unknown; readonly body: unknown };
  focus(options?: { preventScroll?: boolean }): void;
}

/**
 * Disables or enables a control. A control disabled while it has the keyboard focus,
 * as one which waits for its own action does, loses that focus to the page: it gets it
 * back when it is enabled again, unless the focus went elsewhere meanwhile.
 */
export function setDisabled(control: Control, disabled: boolean): void {
  if (control.disabled === disabled) return;
  const page = control.ownerDocument;
  if (disabled) {
    if (page.activeElement === control) parked = control;
    control.disabled = true;
    return;
  }
  control.disabled = false;
  if (parked !== control) return;
  parked = null;
  // The focus is given back only when nothing took it meanwhile.
  const active = page.activeElement;
  if (active === null || active === page.body) control.focus({ preventScroll: true });
}

/** What each element was last given by `setContent`. */
const contents = new WeakMap<object, string>();

/** Writes the text of an element when it differs from the one it has. */
export function setText(target: { textContent: string | null }, text: string): void {
  contents.delete(target);
  if (target.textContent !== text) target.textContent = text;
}

/**
 * Replaces the children of an element when `key` changes. `key` names everything the
 * children show; `build` is called only when they are replaced.
 */
export function setContent(
  target: { replaceChildren(...nodes: (Node | string)[]): void },
  key: string,
  build: () => (Node | string)[],
): void {
  if (contents.get(target) === key) return;
  target.replaceChildren(...build());
  contents.set(target, key);
}
