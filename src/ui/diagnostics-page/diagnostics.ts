// SPDX-License-Identifier: MPL-2.0

import { extensionApi } from "@platform/bridge";
import { DiagnosticConnection, diagnosticErrorKey } from "./client";
import type { DiagnosticRequest, DiagnosticReportSummary } from "../../core/shared/diagnostics-ui";
import {
  parseDiagnosticReport,
  serializeDiagnosticReport,
  type DiagnosticReport,
} from "../../core/shared/diagnostic-report";
import { languageDirection, resolveLanguage, type Language } from "../../core/shared/language";
import { Translator } from "../../core/shared/translator";
import { configureLegalLinks } from "../../core/shared/legal-links";
import { requestDiagnosticsConsent } from "../../core/shared/data-consent";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("diagnostics_element_missing");
  return node as T;
}

const elements = {
  auto: element<HTMLInputElement>("autoReporting"),
  run: element<HTMLButtonElement>("runButton"),
  clear: element<HTMLButtonElement>("clearHistoryButton"),
  reload: element<HTMLButtonElement>("reloadButton"),
  select: element<HTMLSelectElement>("reportSelect"),
  consent: element<HTMLInputElement>("sendConsent"),
  send: element<HTMLButtonElement>("sendButton"),
  cancel: element<HTMLButtonElement>("cancelButton"),
  delete: element<HTMLButtonElement>("deleteButton"),
  export: element<HTMLButtonElement>("exportButton"),
  ipJournal: element<HTMLButtonElement>("exportIpJournalButton"),
};
const translator = new Translator();
let language: Language = resolveLanguage("auto", extensionApi.i18n.getUILanguage());
let requestedLanguage: Language | null = null;
let languageSequence = 0;
let message = (key: string, substitutions?: string[]): string =>
  extensionApi.i18n.getMessage(key, substitutions) || key;
let selectedId: string | null = null;
let content: DiagnosticReport | null = null;
let selectionRevision = 0;
let busy = false;
let localFailure: string | null = null;
let contentFailure = false;
let poll: ReturnType<typeof setTimeout> | undefined;
const urls = new Set<string>();
const client = new DiagnosticConnection(changed);

elements.ipJournal.addEventListener("click", () => {
  void extensionApi.runtime
    .sendMessage({ type: "get_ip_journal" })
    .then((journal) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(journal, null, 2)], { type: "application/json;charset=utf-8" }),
      );
      urls.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = "fuzevpn-journal-ip.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.delete(url);
      }, 60_000);
    })
    .catch(() => {
      localFailure = "diagnosticsFailure";
      render();
    });
});

extensionApi.runtime.onMessage.addListener((value: unknown) => client.receive(value));
elements.reload.addEventListener("click", () => location.reload());
elements.auto.addEventListener(
  "change",
  () => void command({ type: "diagnostics_set_auto", enabled: elements.auto.checked }),
);
elements.clear.addEventListener("click", () => void command({ type: "diagnostics_clear_history" }));
elements.run.addEventListener("click", () => {
  elements.consent.checked = false;
  void command({ type: "diagnostics_run" });
});
elements.select.addEventListener("change", () => selectReport(elements.select.value));
elements.consent.addEventListener("change", render);
elements.send.addEventListener("click", () => {
  const summary = selected();
  if (!summary?.canSend || !client.state?.signedIn || !elements.consent.checked || !content) return;
  elements.consent.checked = false;
  void command({ type: "diagnostics_send", reportId: summary.id, consent: true, noticeVersion: 1 });
});
elements.cancel.addEventListener("click", () => {
  if (selectedId) void command({ type: "diagnostics_cancel", reportId: selectedId });
});
elements.delete.addEventListener("click", () => {
  if (selectedId) void command({ type: "diagnostics_delete", reportId: selectedId });
});
elements.export.addEventListener("click", () => {
  if (!content || !selectedId || !client.available) return;
  try {
    const blob = new Blob([serializeDiagnosticReport(content)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    urls.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fuzevpn-diagnostic-${selectedId}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    // Keep the object alive while Chrome starts the download.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
    }, 60_000);
  } catch {
    localFailure = "diagnosticsFailure";
    render();
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(poll);
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
});
document.addEventListener("visibilitychange", schedulePoll);

void loadLanguage(language);
render();
void client.request({ type: "diagnostics_state" });

function changed(): void {
  const state = client.state;
  if (state && requestedLanguage !== state.language) void loadLanguage(state.language);
  if (selectedId && !state?.reports.some((item) => item.id === selectedId)) resetSelection();
  if (!state?.signedIn || !selected()?.canSend) elements.consent.checked = false;
  if (!selectedId && state?.reports[0] && client.available) selectReport(state.reports[0].id);
  render();
  schedulePoll();
}

async function loadLanguage(next: Language): Promise<void> {
  requestedLanguage = next;
  const sequence = ++languageSequence;
  try {
    const translated = await translator.forLanguage(next);
    if (sequence !== languageSequence) return;
    message = translated;
    language = next;
    render();
  } catch {
    if (sequence !== languageSequence) return;
    localFailure = "diagnosticsFailure";
    render();
  }
}

function selected(): DiagnosticReportSummary | undefined {
  return client.state?.reports.find((item) => item.id === selectedId);
}

function resetSelection(): void {
  ++selectionRevision;
  selectedId = null;
  content = null;
  contentFailure = false;
  elements.consent.checked = false;
  element<HTMLDetailsElement>("jsonDetails").open = false;
}

function selectReport(id: string): void {
  resetSelection();
  if (!client.state?.reports.some((item) => item.id === id)) {
    render();
    return;
  }
  selectedId = id;
  const revision = selectionRevision;
  render();
  void client.request({ type: "diagnostics_report", reportId: id }).then((response) => {
    if (revision !== selectionRevision || selectedId !== id || !selected()) return;
    try {
      if (!response?.ok || !response.report) throw new Error("diagnostics_content_unavailable");
      const report = parseDiagnosticReport(response.report);
      if (report.report_id !== id) throw new Error("diagnostics_content_unavailable");
      content = report;
      contentFailure = false;
    } catch {
      content = null;
      contentFailure = true;
    }
    render();
  });
}

async function command(request: DiagnosticRequest): Promise<void> {
  if (busy || !client.available) return;
  busy = true;
  localFailure = null;
  render();
  try {
    const needsDataConsent =
      request.type === "diagnostics_send" ||
      (request.type === "diagnostics_set_auto" && request.enabled);
    const response = needsDataConsent
      ? await client.requestWithDataConsent(request, requestDiagnosticsConsent)
      : await client.request(request);
    if (
      response?.ok &&
      request.type === "diagnostics_run" &&
      response.reportId &&
      client.state?.reports.some((item) => item.id === response.reportId)
    )
      selectReport(response.reportId);
  } finally {
    busy = false;
    render();
    schedulePoll();
  }
}

function schedulePoll(): void {
  clearTimeout(poll);
  if (!client.available || document.visibilityState !== "visible" || busy) return;
  if (
    client.state?.preparing ||
    client.state?.reports.some((item) => ["pending", "sending"].includes(item.status))
  ) {
    poll = setTimeout(() => {
      void client.request({ type: "diagnostics_state" }).then(schedulePoll);
    }, 5_000);
  }
}

function date(value: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function render(): void {
  configureLegalLinks(language);
  document.documentElement.lang = language;
  document.documentElement.dir = languageDirection(language);
  document.title = `FuzeVPN — ${message("diagnosticsTitle")}`;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    node.textContent = message(node.dataset.i18n ?? "");
  });
  const state = client.state;
  const unavailable = !client.available;
  const error = localFailure ?? (client.error ? diagnosticErrorKey(client.error) : null);
  const banner = element("pageError");
  banner.hidden = error === null;
  banner.textContent = error ? message(error) : "";
  elements.reload.hidden = client.error !== "unavailable";
  elements.auto.checked = state?.signedIn === true && state.autoReporting;
  elements.ipJournal.textContent = `IP · ${message("diagnosticsExport")}`;
  elements.auto.disabled = unavailable || busy || !state?.signedIn;
  elements.run.disabled = unavailable || busy || state?.preparing === true;
  elements.clear.disabled = unavailable || busy || !state?.historyCount;
  element("accountRequired").hidden = state?.signedIn === true;
  element("historyCount").textContent = state
    ? message("diagnosticsHistoryCount", [String(state.historyCount)])
    : "";
  element("preparing").hidden = state?.preparing !== true;
  const reports = state?.reports ?? [];
  element("emptyReports").hidden = reports.length !== 0;
  element("reportLabel").hidden = reports.length === 0;
  elements.select.hidden = reports.length === 0;
  elements.select.disabled = unavailable || busy;
  const options = reports.map(
    (item) =>
      new Option(
        message("diagnosticsReportLabel", [
          message(item.type === "full" ? "diagnosticsTypeFull" : "diagnosticsTypeSimple"),
          date(item.createdAt),
          message(`diagnosticsStatus_${item.status}`),
        ]),
        item.id,
      ),
  );
  elements.select.replaceChildren(...options);
  if (selectedId) elements.select.value = selectedId;
  const summary = selected();
  element("reportView").hidden = !summary;
  element("reportStatus").dataset.status = summary?.status ?? "";
  element("reportStatus").textContent = summary
    ? message(`diagnosticsStatus_${summary.status}`) +
      (summary.status === "received" && summary.receipt
        ? ` · ${message("diagnosticsReceivedAt", [date(summary.receipt.received_at)])}`
        : "")
    : "";
  element("reportFailure").hidden = !summary?.error;
  element("reportFailure").textContent = summary?.error
    ? message(diagnosticErrorKey(summary.error))
    : "";
  element("reportContentError").hidden = !contentFailure;
  element("reportContentError").textContent = contentFailure
    ? message("diagnosticsContentUnavailable")
    : "";
  element("reportSummary").textContent = content
    ? message("diagnosticsSummary", [date(content.created_at), content.app_version]) +
      (content.error ? ` ${message(`error_${content.error.code}`)}` : "")
    : "";
  const checks = content?.checks ?? [];
  element("checksSection").hidden = checks.length === 0;
  const labels: Record<string, string> = {
    proxy_settings: "diagnosticsProxy",
    secure_storage: "diagnosticsStorage",
    connectivity: "diagnosticsNetwork",
    api_reachability: "diagnosticsNetwork",
    kill_switch: "killSwitch",
    webrtc: "webRtcProtection",
    cleanup: "diagnosticsCleanup",
  };
  element("checkList").replaceChildren(
    ...checks.map((check) => {
      const li = document.createElement("li");
      li.dataset.result = check.result;
      const label = labels[check.id];
      const name = label ? message(label) : message("diagnosticsCheckFallback", [check.id]);
      li.textContent = message("diagnosticsCheckLine", [
        name,
        message(`diagnosticsResult_${check.result}`),
      ]);
      return li;
    }),
  );
  element("jsonDetails").hidden = content === null;
  element("reportJson").textContent = content ? JSON.stringify(content, null, 2) : "";
  elements.export.disabled = unavailable || content === null;
  elements.delete.disabled = unavailable || busy || !summary;
  const canSend =
    !unavailable &&
    !busy &&
    state?.signedIn === true &&
    summary?.canSend === true &&
    content !== null;
  elements.consent.disabled = !canSend;
  elements.send.disabled = !canSend || !elements.consent.checked;
  const canCancel = summary && ["pending", "sending", "session_required"].includes(summary.status);
  elements.cancel.hidden = !canCancel;
  elements.cancel.disabled = unavailable || busy || !canCancel;
}
