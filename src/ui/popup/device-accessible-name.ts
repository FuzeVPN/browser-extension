// SPDX-License-Identifier: MPL-2.0

/** Keep the complete visible action available to speech input in every locale. */
export function deviceAccessibleName(actionLabel: string, displayName: string): string {
  return `${actionLabel} — ${displayName}`;
}

function comparisonName(name: string, locale: string): string {
  // Removing an invisible character or mapping case can expose a new canonical
  // equivalence (e U+034F U+0301, W U+030A): only a fixed point is a stable key.
  let key = name;
  let previous: string;
  do {
    previous = key;
    // \s also matches the invisible U+FEFF: drop ignorables first, but keep
    // tab and line breaks as spaces before dropping the remaining controls.
    // Turkish and Lithuanian case mappings differ between canonically equivalent
    // forms (I U+0301 and U+00CD), so only normalized text is lowercased.
    key = previous
      .normalize("NFKC")
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
      .replace(/\s/gu, " ")
      .replace(/\p{Cc}/gu, "")
      .replace(/ +/gu, " ")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase(locale);
  } while (key !== previous);
  return key;
}

/** Use the same target name in the visible row, its action and its confirmation. */
export function deviceDisplayNames<T extends { deviceId: string }>(
  devices: readonly T[],
  displayName: (device: T) => string,
  locale: string,
  fallbackName: (device: T) => string,
): ReadonlyMap<string, string> {
  const entries = devices.map((device) => {
    const requestedName = displayName(device);
    const name = comparisonName(requestedName, locale) ? requestedName : fallbackName(device);
    return { deviceId: device.deviceId, name, key: comparisonName(name, locale) };
  });
  const counts = new Map<string, number>();
  for (const { key } of entries) counts.set(key, (counts.get(key) ?? 0) + 1);

  // Reserve existing names too: a real "Laptop (1)" must not collide with a suffix.
  const reserved = new Set(entries.map(({ key }) => key));
  const nextNumbers = new Map<string, number>();
  const numbers = new Intl.NumberFormat(locale, { useGrouping: false });
  const result = new Map<string, string>();
  // IDs determine order internally only; API ordering must not exchange two targets.
  entries.sort((left, right) =>
    left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
  );
  for (const { deviceId, name, key } of entries) {
    let distinctName = name;
    if ((counts.get(key) ?? 0) > 1) {
      let number = nextNumbers.get(key) ?? 1;
      do {
        distinctName = `${name} (${numbers.format(number++)})`;
      } while (reserved.has(comparisonName(distinctName, locale)));
      nextNumbers.set(key, number);
      reserved.add(comparisonName(distinctName, locale));
    }
    result.set(deviceId, distinctName);
  }
  return result;
}
