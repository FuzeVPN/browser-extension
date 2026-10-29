// SPDX-License-Identifier: MPL-2.0

import type { Language } from "./language";
import { extensionApi } from "@platform/bridge";

export const EXTENSION_PRIVACY_PAGE = "privacy-page/privacy.html";

// Service links use the site's available translations; the bundled notice follows the UI language.
export function configureLegalLinks(language: Language, root: ParentNode = document): void {
  const siteLanguage = ["fr", "en", "es", "de", "nl"].includes(language) ? language : "en";
  const contactPage =
    siteLanguage === "es" ? "contacto" : siteLanguage === "de" ? "kontakt" : "contact";
  const pages = {
    "general-privacy": "privacy",
    terms: "terms",
    legal: "legal",
    contact: contactPage,
  };

  root.querySelectorAll<HTMLAnchorElement>("a[data-legal-link]").forEach((link) => {
    const key = link.dataset.legalLink;
    if (key === "privacy") {
      const query = new URLSearchParams({ lang: language });
      link.href = `${extensionApi.runtime.getURL(EXTENSION_PRIVACY_PAGE)}?${query.toString()}`;
      link.hreflang = language;
    } else {
      if (!key || !Object.hasOwn(pages, key)) return;
      link.href = `https://fuzevpn.com/${siteLanguage}/${pages[key as keyof typeof pages]}.html`;
      link.hreflang = siteLanguage;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
}
