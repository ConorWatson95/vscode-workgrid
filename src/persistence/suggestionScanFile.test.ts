import { describe, expect, it } from "vitest";
import {
  decodeSuggestionScanFile,
  encodeSuggestionScanFile,
  scanStillRunning,
  StoredScan,
} from "./suggestionScanFile";

const stored: StoredScan = {
  scan: {
    scannedAt: "2026-10-12T09:00:00.000Z",
    outcomes: [
      {
        sourceId: "jira",
        sourceLabel: "JIRA",
        suggestions: [{ sourceId: "jira", ref: "NMGB-1", title: "Export drops a row" }],
      },
    ],
  },
  scanning: { startedAt: "2026-10-12T09:05:00.000Z", pid: 7 },
};

describe("suggestion scan file", () => {
  it("round-trips", () => {
    expect(decodeSuggestionScanFile(encodeSuggestionScanFile(stored))).toEqual(stored);
  });

  it("reads anything unreadable as no scan, never throwing", () => {
    expect(decodeSuggestionScanFile(undefined)).toEqual({});
    expect(decodeSuggestionScanFile("{ not json")).toEqual({});
    expect(decodeSuggestionScanFile('{"scan":{"outcomes":"x"}}')).toEqual({});
  });

  it("drops a malformed outcome and keeps the rest", () => {
    const text = JSON.stringify({
      scan: { scannedAt: "t", outcomes: [{ sourceId: "x" }, stored.scan!.outcomes[0]] },
    });
    expect(decodeSuggestionScanFile(text).scan?.outcomes).toEqual(stored.scan!.outcomes);
  });

  it("treats a scan whose process has gone as not running", () => {
    expect(scanStillRunning(stored, () => true)).toEqual(stored.scanning);
    expect(scanStillRunning(stored, () => false)).toBeUndefined();
  });
});
