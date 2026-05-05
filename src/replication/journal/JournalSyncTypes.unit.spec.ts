import { describe, expect, it } from "vitest";

import {
    ACTIVE_HEARTBEAT_WINDOW_MS,
    COMPACT_TRIGGER_MIN_RAW_JOURNALS,
    CURSOR_REPORT_MIN_INTERVAL_MS,
    compareRawJournalBoundaries,
    compareRawJournalKeys,
    computeCursorFromJournalFileSets,
    computePrefixCompactionPlan,
    countRawJournalKeysBetween,
    createCompactionRangeToken,
    formatCompactionEditKey,
    formatManifestKey,
    getActiveDeviceStates,
    getDeviceStateObjectKey,
    isCompactionEditDocument,
    isCompactionLeaseDocument,
    isCurrentManifestPointer,
    isDeviceStateDocument,
    isRawJournalKeyRange,
    isSnapshotManifestDocument,
    restoreCompactViewFromSnapshotAndEdits,
    shouldReportDeviceStateByCursorAdvance,
    type CompactionEditDocument,
    type DeviceStateDocument,
    type SnapshotManifestDocument,
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

    it("formats manifest, edit and lease-safe range keys", () => {
        expect(formatManifestKey(13)).toBe("_control/manifest/manifest-000013.json");
        expect(formatCompactionEditKey(104)).toBe("_control/compaction-edits/000000000104.json");
        expect(
            createCompactionRangeToken({
                from_exclusive: null,
                to_inclusive: "device/a 10-docs.jsonl.gz",
            })
        ).toBe("start__device%2Fa%2010-docs.jsonl.gz");
    });

    it("validates manifest, current pointer, edit and lease documents", () => {
        const range = { from_exclusive: null, to_inclusive: "10-docs.jsonl.gz" };
        expect(isRawJournalKeyRange(range)).toBe(true);
        expect(isRawJournalKeyRange({ ...range, to_inclusive: "_compact/10.pack" })).toBe(false);

        const snapshot = {
            generation: 0,
            created_at: 1000,
            compacted_boundary: "10-docs.jsonl.gz",
            segments: [
                {
                    id: "compact-start-10",
                    key: "_compact/start-10.pack",
                    covers: range,
                    size: 10,
                },
            ],
        } satisfies SnapshotManifestDocument;
        expect(isSnapshotManifestDocument(snapshot)).toBe(true);
        expect(isSnapshotManifestDocument({ ...snapshot, compacted_boundary: "2-docs.jsonl.gz" })).toBe(false);
        expect(isCurrentManifestPointer({ current: formatManifestKey(0), generation: 0 })).toBe(true);
        expect(isCurrentManifestPointer({ current: "manifest-000000.json", generation: 0 })).toBe(false);

        const edit = {
            edit_seq: 1,
            based_on_generation: 0,
            created_at: 2000,
            new_segment: {
                id: "compact-start-10",
                key: "_compact/start-10.pack",
                format: "journal-entry-stream-v1",
                covers: range,
                size: 10,
            },
            replaces: [],
        } satisfies CompactionEditDocument;
        expect(isCompactionEditDocument(edit)).toBe(true);
        expect(isCompactionEditDocument({ ...edit, edit_seq: 0 })).toBe(false);
        expect(
            isCompactionLeaseDocument({
                lease_id: "lease",
                owner_device_id: "device-a",
                range,
                created_at: 1000,
                expires_at: 2000,
                based_on_generation: 0,
            })
        ).toBe(true);
    });

    it("restores compact view with ordered and idempotent edits", () => {
        const snapshot = {
            generation: 0,
            created_at: 1000,
            compacted_boundary: null,
            segments: [],
        } satisfies SnapshotManifestDocument;
        const first = {
            edit_seq: 1,
            based_on_generation: 0,
            created_at: 2000,
            new_segment: {
                id: "compact-start-10",
                key: "_compact/start-10.pack",
                format: "journal-entry-stream-v1",
                covers: { from_exclusive: null, to_inclusive: "10-docs.jsonl.gz" },
            },
            replaces: [],
        } satisfies CompactionEditDocument;
        const second = {
            edit_seq: 2,
            based_on_generation: 0,
            created_at: 3000,
            new_segment: {
                id: "compact-10-20",
                key: "_compact/10-20.pack",
                format: "journal-entry-stream-v1",
                covers: { from_exclusive: "10-docs.jsonl.gz", to_inclusive: "20-docs.jsonl.gz" },
            },
            replaces: [],
        } satisfies CompactionEditDocument;
        const oldGeneration = { ...second, edit_seq: 3, based_on_generation: 1 } satisfies CompactionEditDocument;
        const nonPrefix = {
            ...second,
            edit_seq: 4,
            new_segment: {
                ...second.new_segment,
                id: "compact-gap",
                covers: { from_exclusive: "30-docs.jsonl.gz", to_inclusive: "40-docs.jsonl.gz" },
            },
        } satisfies CompactionEditDocument;
        const view = restoreCompactViewFromSnapshotAndEdits(snapshot, [second, first, first, oldGeneration, nonPrefix]);
        expect(view.compacted_boundary).toBe("20-docs.jsonl.gz");
        expect(view.segments.map((segment) => segment.id)).toEqual(["compact-start-10", "compact-10-20"]);
        expect(view.applied_edit_seq).toBe(2);
    });

    it("plans prefix compaction only after all active devices have 64 raw journals", () => {
        const view = {
            generation: 0,
            compacted_boundary: null,
            segments: [],
        };
        const rawKeys = Array.from(
            { length: COMPACT_TRIGGER_MIN_RAW_JOURNALS },
            (_, index) => `${index + 1}-docs.jsonl.gz`
        );
        const activeDevices = [
            { cursor: "64-docs.jsonl.gz", manifest_seen_generation: 0, last_heartbeat: 1000 },
            { cursor: "70-docs.jsonl.gz", manifest_seen_generation: 0, last_heartbeat: 1000 },
        ] satisfies DeviceStateDocument[];
        const plan = computePrefixCompactionPlan(view, activeDevices, rawKeys);
        expect(plan && plan.range).toEqual({ from_exclusive: null, to_inclusive: "64-docs.jsonl.gz" });
        expect(computePrefixCompactionPlan(view, [{ ...activeDevices[0], cursor: null }], rawKeys)).toBe(false);
        expect(computePrefixCompactionPlan(view, activeDevices, rawKeys.slice(0, 63))).toBe(false);
    });
});
