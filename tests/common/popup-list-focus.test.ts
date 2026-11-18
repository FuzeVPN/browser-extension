// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "vitest";
import { focusNeighbour } from "../../src/ui/popup/list-focus";

describe("the entry which takes the focus of one removed from a list", () => {
  it("is the one which followed it", () => {
    expect(focusNeighbour(["a", "b", "c"], "b", ["a", "c"])).toBe("c");
    expect(focusNeighbour(["a", "b", "c"], "a", ["b", "c"])).toBe("b");
  });

  it("is the one before it when it was the last", () => {
    expect(focusNeighbour(["a", "b", "c"], "c", ["a", "b"])).toBe("b");
  });

  it("is the nearest one still listed when its neighbours left with it", () => {
    expect(focusNeighbour(["a", "b", "c", "d"], "b", ["a", "d"])).toBe("d");
    expect(focusNeighbour(["a", "b", "c", "d"], "c", ["a"])).toBe("a");
  });

  it("is found by name, wherever the list now puts it", () => {
    expect(focusNeighbour(["a", "b", "c"], "b", ["c", "new", "a"])).toBe("c");
  });

  it("is none when the list is empty, holds only new entries, or never held the entry", () => {
    expect(focusNeighbour(["a"], "a", [])).toBeNull();
    expect(focusNeighbour(["a", "b"], "a", ["new"])).toBeNull();
    expect(focusNeighbour(["a", "b"], "other", ["a", "b"])).toBeNull();
  });
});
