// SPDX-License-Identifier: MPL-2.0

import { setContent, setText } from "../../src/ui/popup/dom";

/**
 * The writers of the popup, for the tests which run its functions against stand-ins of
 * its elements. Texts and children go through the real writers. The stand-ins have no
 * document and no keyboard focus: a control is disabled there as a plain property, and
 * the focus which a disabled control gets back is tested with the writer itself.
 */
export const popupDom = {
  setText,
  setContent,
  setDisabled(control: { disabled: boolean }, disabled: boolean): void {
    control.disabled = disabled;
  },
};
