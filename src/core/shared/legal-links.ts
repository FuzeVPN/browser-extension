// SPDX-License-Identifier: MPL-2.0

import type { Language } from "./language";

// Use the public site's available translations; all other interface languages use English.
export function configureLegalLinks(language: Language, root: ParentNode = document): void {
  const siteLanguage = ["fr", "en", "es", "de", "nl"].includes(language) ? language : "en";
  const contactPage =
    siteLanguage === "es" ? "contacto" : siteLanguage === "de" ? "kontakt" : "contact";
  const pages = { privacy: "privacy", terms: "terms", legal: "legal", contact: contactPage };

  root.querySelectorAll<HTMLAnchorElement>("a[data-legal-link]").forEach((link) => {
    const key = link.dataset.legalLink;
    if (!key || !Object.hasOwn(pages, key)) return;
    link.href = `https://fuzevpn.com/${siteLanguage}/${pages[key as keyof typeof pages]}.html`;
    link.hreflang = siteLanguage;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
}
