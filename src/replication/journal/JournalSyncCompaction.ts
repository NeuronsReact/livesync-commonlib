import { shareRunningResult } from "octagonal-wheels/concurrency/lock";

import { LOG_LEVEL_DEBUG, LOG_LEVEL_VERBOSE } from "../../common/types.ts";
import { Logger } from "../../common/logger.ts";
import type { JournalSyncAbstract } from "./JournalSyncAbstract.ts";
import {
    ACTIVE_HEARTBEAT_WINDOW_MS,
    COMPACT_SEGMENT_MAX_ENTRIES,
    COMPACT_SEGMENT_MAX_UNCOMPRESSED_BYTES,
    COMPACTION_LEASE_TTL_MS,
    JOURNAL_COMPACTION_EDITS_PREFIX,
    JOURNAL_COMPACTION_LEASE_PREFIX,
    JOURNAL_CURRENT_MANIFEST_KEY,
    compareRawJournalBoundaries,
    computeCursorFromJournalFileSets,
    computePrefixCompactionPlan,
    createCompactionRangeToken,
    formatCompactionEditKey,
    formatManifestKey,
    getActiveDeviceStates,
    isCompactionEditDocument,
    isCompactionLeaseDocument,
    isCurrentManifestPointer,
    isRawJournalKeyPublic,
    isSnapshotManifestDocument,
    restoreCompactViewFromSnapshotAndEdits,
    sortRawJournalKeys,
    type CompactView,
    type CompactionEditDocument,
    type CompactionLeaseDocument,
    type CompactionPlan,
    type CurrentManifestPointer,
    type EditSeq,
    type RawJournalKey,
    type RawJournalKeyRange,
    type SnapshotManifestDocument,
} from "./JournalSyncTypes.ts";
import {
    decodeJournalEntryStream,
    deflateJournalEntryStream,
    inflateJournalEntryStream,
} from "./JournalSyncSerialization.ts";

type PointerReadResult = { status: "ok"; pointer: CurrentManifestPointer } | { status: "missing" | "invalid" };

type SnapshotReadResult = { status: "ok"; snapshot: SnapshotManifestDocument } | { status: "missing" | "invalid" };

type SegmentChunk = {
    from_exclusive: RawJournalKeyRange["from_exclusive"];
    to_inclusive: RawJournalKey;
    buffers: Uint8Array[];
    uncompressedSize: number;
    entries: number;
};

export class JournalSyncCompaction {
    client: JournalSyncAbstract;
    lastRestoredView: CompactView | false = false;
    lastAppliedView: CompactView | false = false;

    constructor(client: JournalSyncAbstract) {
        this.client = client;
    }

    async readCurrentManifestPointer(): Promise<PointerReadResult> {
        const pointer = await this.client.downloadJson<CurrentManifestPointer>(JOURNAL_CURRENT_MANIFEST_KEY);
        if (!pointer) return { status: "missing" };
        if (!isCurrentManifestPointer(pointer)) return { status: "invalid" };
        return { status: "ok", pointer };
    }

    async readSnapshotManifest(pointer: CurrentManifestPointer): Promise<SnapshotReadResult> {
        const snapshot = await this.client.downloadJson<SnapshotManifestDocument>(pointer.current);
        if (!snapshot) return { status: "missing" };
        if (!isSnapshotManifestDocument(snapshot)) return { status: "invalid" };
        if (snapshot.generation !== pointer.generation) return { status: "invalid" };
        return { status: "ok", snapshot };
    }

    getInitialSnapshotManifest(now = Date.now()): SnapshotManifestDocument {
        return {
            generation: 0,
            created_at: now,
            compacted_boundary: null,
            segments: [],
        };
    }

    async ensureInitialSnapshotManifest(): Promise<CompactView | false> {
        const existing = await this.restoreCompactView();
        if (existing !== false) return existing;

        const snapshot = this.getInitialSnapshotManifest();
        const manifestKey = formatManifestKey(snapshot.generation);
        const pointer = { current: manifestKey, generation: snapshot.generation } satisfies CurrentManifestPointer;
        const manifestResult = await this.client.uploadJsonConditional(manifestKey, snapshot, { ifNoneMatch: "*" });
        if (manifestResult !== true && manifestResult !== "precondition-failed") return false;
        const pointerResult = await this.client.uploadJsonConditional(JOURNAL_CURRENT_MANIFEST_KEY, pointer, {
            ifNoneMatch: "*",
        });
        if (pointerResult !== true && pointerResult !== "precondition-failed") return false;
        return await this.restoreCompactView();
    }

    async readCompactionEdits(generation: number): Promise<CompactionEditDocument[]> {
        const keys = await this.client.listFilesByPrefix(JOURNAL_COMPACTION_EDITS_PREFIX);
        const edits = await Promise.all(
            keys.map(async (key) => {
                const edit = await this.client.downloadJson<CompactionEditDocument>(key);
                if (!isCompactionEditDocument(edit)) {
                    Logger(`Invalid compaction edit skipped: ${key}`, LOG_LEVEL_VERBOSE);
                    return false;
                }
                if (edit.based_on_generation !== generation) return false;
                return edit;
            })
        );
        return edits
            .filter((edit): edit is CompactionEditDocument => edit !== false)
            .sort((a, b) => a.edit_seq - b.edit_seq);
    }

    async restoreCompactView(): Promise<CompactView | false> {
        const pointerResult = await this.readCurrentManifestPointer();
        if (pointerResult.status !== "ok") {
            this.lastRestoredView = false;
            return false;
        }
        const snapshotResult = await this.readSnapshotManifest(pointerResult.pointer);
        if (snapshotResult.status !== "ok") {
            this.lastRestoredView = false;
            return false;
        }
        const edits = await this.readCompactionEdits(snapshotResult.snapshot.generation);
        const view = restoreCompactViewFromSnapshotAndEdits(snapshotResult.snapshot, edits);
        this.lastRestoredView = view;
        return view;
    }

    async applyCompactSegmentsToLocalCheckpoint(): Promise<CompactView | false> {
        try {
            const view = await this.restoreCompactView();
            if (view === false) return false;
            const segments = [...view.segments].sort((a, b) =>
                compareRawJournalBoundaries(a.covers.to_inclusive, b.covers.to_inclusive)
            );
            let checkpoint = await this.client.getCheckpointInfo();
            let localCursor = computeCursorFromJournalFileSets(checkpoint.receivedFiles, []);
            for (const segment of segments) {
                if (compareRawJournalBoundaries(segment.covers.to_inclusive, localCursor) <= 0) continue;
                if (compareRawJournalBoundaries(segment.covers.from_exclusive, localCursor) > 0) {
                    Logger(
                        `Compact segment gap detected before ${segment.key}; falling back to raw tail`,
                        LOG_LEVEL_VERBOSE
                    );
                    break;
                }
                const data = await this.client.downloadFile(segment.key);
                if (data === false) {
                    Logger(
                        `Compact segment missing or unreadable: ${segment.key}; falling back to raw tail`,
                        LOG_LEVEL_VERBOSE
                    );
                    break;
                }
                if (!(await this.client.processCompressedJournalBytes(segment.key, data))) {
                    Logger(
                        `Could not process compact segment: ${segment.key}; falling back to raw tail`,
                        LOG_LEVEL_VERBOSE
                    );
                    break;
                }
                checkpoint = await this.client.updateCheckPointInfo((info) => ({
                    ...info,
                    receivedFiles: info.receivedFiles.add(segment.covers.to_inclusive),
                }));
                localCursor = computeCursorFromJournalFileSets(checkpoint.receivedFiles, checkpoint.sentFiles);
            }
            this.lastAppliedView = view;
            return view;
        } catch (ex) {
            Logger(`Could not apply compact segments; falling back to raw journals`, LOG_LEVEL_VERBOSE);
            Logger(ex, LOG_LEVEL_DEBUG);
            return false;
        }
    }

    async appendCompactionEdit(
        editFactory: (editSeq: EditSeq) => Omit<CompactionEditDocument, "edit_seq">
    ): Promise<CompactionEditDocument | "already-covered" | false> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const existingEdits = await this.readCompactionEdits(editFactory(1).based_on_generation);
            const nextSeq = Math.max(0, ...existingEdits.map((edit) => edit.edit_seq)) + 1;
            const edit = { edit_seq: nextSeq, ...editFactory(nextSeq) } satisfies CompactionEditDocument;
            const result = await this.client.uploadJsonConditional(formatCompactionEditKey(nextSeq), edit, {
                ifNoneMatch: "*",
            });
            if (result === true) return edit;
            if (result === false) return false;
            const view = await this.restoreCompactView();
            if (
                view !== false &&
                compareRawJournalBoundaries(view.compacted_boundary, edit.new_segment.covers.to_inclusive) >= 0
            ) {
                return "already-covered";
            }
        }
        return false;
    }

    async runPrefixCompaction(ownerDeviceId: string): Promise<boolean> {
        return (
            (await shareRunningResult("journal_prefix_compaction", async () => {
                try {
                    const initialView = await this.ensureInitialSnapshotManifest();
                    if (initialView === false) return false;
                    const activeDevices = getActiveDeviceStates(
                        await this.client.listRemoteDeviceStates(),
                        Date.now(),
                        ACTIVE_HEARTBEAT_WINDOW_MS
                    );
                    const rawKeys = sortRawJournalKeys(
                        (await this.client.listFilesByPrefix("")).filter(isRawJournalKeyPublic)
                    );
                    const plan = computePrefixCompactionPlan(initialView, activeDevices, rawKeys);
                    if (plan === false) return true;
                    return await this.executeCompactionPlan(ownerDeviceId, plan, rawKeys);
                } catch (ex) {
                    Logger(`Journal prefix compaction failed`, LOG_LEVEL_VERBOSE);
                    Logger(ex, LOG_LEVEL_DEBUG);
                    return false;
                }
            })) ?? false
        );
    }

    async executeCompactionPlan(
        ownerDeviceId: string,
        plan: CompactionPlan,
        rawKeys: RawJournalKey[]
    ): Promise<boolean> {
        const lease = await this.acquireLease(ownerDeviceId, plan);
        if (!lease) return true;
        const chunks = await this.buildSegmentChunks(plan, rawKeys);
        for (const chunk of chunks) {
            const range = {
                from_exclusive: chunk.from_exclusive,
                to_inclusive: chunk.to_inclusive,
            } satisfies RawJournalKeyRange;
            const token = createCompactionRangeToken(range);
            const segmentId = `compact-${token}`;
            const outputKey = `_compact/${token}.pack`;
            const compressed = await deflateJournalEntryStream(chunk.buffers);
            const uploaded = await this.client.uploadFile(
                outputKey,
                new Blob([compressed]),
                "application/octet-stream"
            );
            if (!uploaded) return false;
            const latestView = await this.restoreCompactView();
            if (latestView === false) return false;
            if (latestView.generation !== plan.based_on_generation) return false;
            if (compareRawJournalBoundaries(latestView.compacted_boundary, range.to_inclusive) >= 0) continue;
            if (compareRawJournalBoundaries(latestView.compacted_boundary, range.from_exclusive) !== 0) return true;
            const appended = await this.appendCompactionEdit(() => ({
                based_on_generation: latestView.generation,
                created_at: Date.now(),
                new_segment: {
                    id: segmentId,
                    key: outputKey,
                    format: "journal-entry-stream-v1",
                    covers: range,
                    size: compressed.byteLength,
                },
                replaces: [],
            }));
            if (appended === false) return false;
        }
        return true;
    }

    async buildSegmentChunks(plan: CompactionPlan, rawKeys: RawJournalKey[]): Promise<SegmentChunk[]> {
        const keys = rawKeys.filter(
            (key) =>
                compareRawJournalBoundaries(key, plan.range.from_exclusive) > 0 &&
                compareRawJournalBoundaries(key, plan.range.to_inclusive) <= 0
        );
        const chunks = [] as SegmentChunk[];
        let current = this.createEmptySegmentChunk(plan.range.from_exclusive);
        for (const key of keys) {
            const compressed = await this.client.downloadFile(key);
            if (compressed === false) throw new Error(`Missing raw journal while compacting: ${key}`);
            const decompressed = await inflateJournalEntryStream(compressed);
            const entries = decodeJournalEntryStream(decompressed).length;
            const wouldExceedSize =
                current.uncompressedSize > 0 &&
                current.uncompressedSize + decompressed.byteLength > COMPACT_SEGMENT_MAX_UNCOMPRESSED_BYTES;
            const wouldExceedEntries = current.entries > 0 && current.entries + entries > COMPACT_SEGMENT_MAX_ENTRIES;
            if (wouldExceedSize || wouldExceedEntries) {
                chunks.push(current);
                current = this.createEmptySegmentChunk(current.to_inclusive);
            }
            current.buffers.push(decompressed);
            current.uncompressedSize += decompressed.byteLength;
            current.entries += entries;
            current.to_inclusive = key;
        }
        if (current.buffers.length > 0) chunks.push(current);
        return chunks;
    }

    createEmptySegmentChunk(fromExclusive: RawJournalKeyRange["from_exclusive"]): SegmentChunk {
        return {
            from_exclusive: fromExclusive,
            to_inclusive: "" as RawJournalKey,
            buffers: [],
            uncompressedSize: 0,
            entries: 0,
        };
    }

    async acquireLease(ownerDeviceId: string, plan: CompactionPlan): Promise<CompactionLeaseDocument | false> {
        const now = Date.now();
        const rangeToken = createCompactionRangeToken(plan.range);
        const key = `${JOURNAL_COMPACTION_LEASE_PREFIX}${rangeToken}.json`;
        const existing = await this.client.downloadJsonWithMetadata<CompactionLeaseDocument>(key);
        if (existing !== false && isCompactionLeaseDocument(existing.body)) {
            if (existing.body.expires_at > now && existing.body.owner_device_id !== ownerDeviceId) return false;
        }
        const lease = {
            lease_id: `${ownerDeviceId}-${now}-${Math.random().toString(36).slice(2)}`,
            owner_device_id: ownerDeviceId,
            range: plan.range,
            created_at: now,
            expires_at: now + COMPACTION_LEASE_TTL_MS,
            based_on_generation: plan.based_on_generation,
        } satisfies CompactionLeaseDocument;
        const condition = existing === false ? { ifNoneMatch: "*" as const } : { ifMatch: existing.etag ?? "" };
        if ("ifMatch" in condition && condition.ifMatch === "") return false;
        const result = await this.client.uploadJsonConditional(key, lease, condition);
        return result === true ? lease : false;
    }
}
