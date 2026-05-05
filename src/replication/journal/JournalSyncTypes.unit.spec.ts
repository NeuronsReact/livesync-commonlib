import { describe, expect, it } from "vitest";

import {
    ACTIVE_HEARTBEAT_WINDOW_MS,
    CURSOR_REPORT_MIN_INTERVAL_MS,
    compareRawJournalBoundaries,
    compareRawJournalKeys,
    computeCursorFromJournalFileSets,
    countRawJournalKeysBetween,
    getActiveDeviceStates,
    getDeviceStateObjectKey,
    isDeviceStateDocument,
    shouldReportDeviceStateByCursorAdvance,
    type DeviceStateDocument,
} from "./JournalSyncTypes.ts";

describe("JournalSyncTypes", () => {
    it("compares raw journal keys with numeric ordering", () => {
        expect(compareRawJournalKeys("2-docs.jsonl.gz", "10-docs.jsonl.gz")).toBeLessThan(0);
    });

    it("treats null boundary as before any raw journal key", () => {
        expect(compareRawJournalBoundaries(null, "1-docs.jsonl.gz")).toBeLessThan(0);
        expect(compareRawJournalBoundaries("1-docs.jsonl.gz", null)).toBeGreaterThan(0);
        expect(compareRawJournalBoundaries(null, null)).toBe(0);
    });

    it("computes cursor from received and sent file set union", () => {
        expect(computeCursorFromJournalFileSets(new Set(), new Set())).toBe(null);
        expect(
            computeCursorFromJournalFileSets(
                new Set(["_control/devices/a.json", "_compact/1.pack"]),
                new Set(["_obsidian_livesync_journal_sync_parameters.json"])
            )
        ).toBe(null);
        expect(
            computeCursorFromJournalFileSets(
                new Set(["2-docs.jsonl.gz", "10-docs.jsonl.gz"]),
                new Set(["1-docs.jsonl.gz"])
            )
        ).toBe("10-docs.jsonl.gz");
        expect(
            computeCursorFromJournalFileSets(
                new Set(["2-docs.jsonl.gz", "2-docs.jsonl.gz"]),
                new Set(["11-docs.jsonl.gz"])
            )
        ).toBe("11-docs.jsonl.gz");
    });

    it("counts raw journal keys in an exclusive/inclusive range", () => {
        const keys = ["1-docs.jsonl.gz", "2-docs.jsonl.gz", "10-docs.jsonl.gz", "_control/devices/a.json"];
        expect(countRawJournalKeysBetween(keys, null, "10-docs.jsonl.gz")).toBe(3);
        expect(countRawJournalKeysBetween(keys, "1-docs.jsonl.gz", "10-docs.jsonl.gz")).toBe(2);
        expect(countRawJournalKeysBetween(keys, "2-docs.jsonl.gz", "10-docs.jsonl.gz")).toBe(1);
        expect(countRawJournalKeysBetween(keys, "10-docs.jsonl.gz", "10-docs.jsonl.gz")).toBe(0);
    });

    it("builds encoded device state object keys", () => {
        expect(getDeviceStateObjectKey("device/a b")).toBe("_control/devices/device%2Fa%20b.json");
    });

    it("validates device state documents", () => {
        const valid = {
            cursor: "10-docs.jsonl.gz",
            manifest_seen_generation: 0,
            last_heartbeat: 1000,
        } satisfies DeviceStateDocument;
        expect(isDeviceStateDocument(valid)).toBe(true);
        expect(isDeviceStateDocument({ ...valid, cursor: 1 })).toBe(false);
        expect(isDeviceStateDocument({ ...valid, manifest_seen_generation: "0" })).toBe(false);
        expect(isDeviceStateDocument({ ...valid, last_heartbeat: "1000" })).toBe(false);
        expect(isDeviceStateDocument({ ...valid, state: "unknown" })).toBe(false);
        expect(isDeviceStateDocument({ ...valid, last_applied_edit_seq: "1" })).toBe(false);
    });

    it("filters active device states by heartbeat window and state", () => {
        const now = 10_000;
        const active = {
            cursor: null,
            manifest_seen_generation: 0,
            last_heartbeat: now - ACTIVE_HEARTBEAT_WINDOW_MS,
        } satisfies DeviceStateDocument;
        const old = {
            ...active,
            last_heartbeat: now - ACTIVE_HEARTBEAT_WINDOW_MS - 1,
        } satisfies DeviceStateDocument;
        const stale = { ...active, state: "stale" } satisfies DeviceStateDocument;
        const retired = { ...active, state: "retired" } satisfies DeviceStateDocument;
        expect(getActiveDeviceStates([active, old, stale, retired], now)).toEqual([active]);
    });

    it("reports cursor advance only after threshold and minimum interval", () => {
        const files = Array.from({ length: 40 }, (_, index) => `${index + 1}-docs.jsonl.gz`);
        const base = {
            previousReportedCursor: "1-docs.jsonl.gz",
            currentCursor: "34-docs.jsonl.gz",
            receivedFiles: files,
            sentFiles: [],
            lastReportedAt: 0,
            now: CURSOR_REPORT_MIN_INTERVAL_MS,
        };
        expect(shouldReportDeviceStateByCursorAdvance(base)).toBe(true);
        expect(
            shouldReportDeviceStateByCursorAdvance({ ...base, currentCursor: "33-docs.jsonl.gz" })
        ).toBe(false);
        expect(shouldReportDeviceStateByCursorAdvance({ ...base, now: CURSOR_REPORT_MIN_INTERVAL_MS - 1 })).toBe(
            false
        );
        expect(
            shouldReportDeviceStateByCursorAdvance({ ...base, currentCursor: "1-docs.jsonl.gz" })
        ).toBe(false);
        expect(shouldReportDeviceStateByCursorAdvance({ ...base, currentCursor: null })).toBe(false);
    });

    it("uses received and sent files when testing cursor advance", () => {
        const receivedFiles = Array.from({ length: 20 }, (_, index) => `${index + 1}-docs.jsonl.gz`);
        const sentFiles = Array.from({ length: 20 }, (_, index) => `${index + 21}-docs.jsonl.gz`);
        expect(
            shouldReportDeviceStateByCursorAdvance({
                previousReportedCursor: "1-docs.jsonl.gz",
                currentCursor: "34-docs.jsonl.gz",
                receivedFiles,
                sentFiles,
                lastReportedAt: 0,
                now: CURSOR_REPORT_MIN_INTERVAL_MS,
            })
        ).toBe(true);
    });
});
