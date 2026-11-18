// SPDX-License-Identifier: MPL-2.0

/**
 * The entry which takes the keyboard focus of one which left a list: the nearest one
 * which followed it and is still listed, else the nearest one before it.
 *
 * `before` and `after` name the entries of the list, in order, before and after the
 * change. Returns `null` when no entry of the previous list remains.
 */
export function focusNeighbour(
  before: readonly string[],
  left: string,
  after: readonly string[],
): string | null {
  const index = before.indexOf(left);
  if (index < 0) return null;
  const remaining = new Set(after);
  const following = before.slice(index + 1).find((key) => remaining.has(key));
  if (following !== undefined) return following;
  return (
    before
      .slice(0, index)
      .reverse()
      .find((key) => remaining.has(key)) ?? null
  );
}
