import { describe, expect, it } from "vitest";

import { CheckPointInfoDefault, formatManifestKey, JOURNAL_CURRENT_MANIFEST_KEY, type CheckPointInfo } from "./JournalSyncTypes.ts";
import { JournalSyncCompaction } from "./JournalSyncCompaction.ts";
import { deflateJournalEntryStream } from "./JournalSyncSerialization.ts";
import type { JournalSyncAbstract } from "./JournalSyncAbstract.ts";

type StoredObject = {
    body: unknown;
    etag: string;
};

class FakeCompactionClient {
    objects = new Map<string, StoredObject>();
    files = new Map<string, Uint8Array>();
    checkpoint: CheckPointInfo = {
        ...CheckPointInfoDefault,
        knownIDs: new Set(),
        sentIDs: new Set(),
        receivedFiles: new Set(),
        sentFiles: new Set(),
    };
    processedKeys: string[] = [];
    etagSeq = 0;

    async uploadJson(key: string, body: unknown) {
        this.objects.set(key, { body: structuredClone(body), etag: this.nextEtag() });
        return true;
    }

    async downloadJson<T>(key: string): Promise<T | false> {
        return (structuredClone(this.objects.get(key)?.body) as T | undefined) ?? false;
    }

    async uploadJsonConditional(key: string, body: unknown, condition: { ifNoneMatch: "*" } | { ifMatch: string }) {
        const existing = this.objects.get(key);
        if ("ifNoneMatch" in condition && existing) return "precondition-failed";
        if ("ifMatch" in condition && (!existing || existing.etag !== condition.ifMatch)) return "precondition-failed";
        await this.uploadJson(key, body);
        return true;
    }

    async downloadJsonWithMetadata<T>(key: string) {
        const existing = this.objects.get(key);
        if (!existing) return false;
        return { body: structuredClone(existing.body) as T, etag: existing.etag };
    }

    async uploadFile(key: string, blob: Blob) {
        this.files.set(key, new Uint8Array(await blob.arrayBuffer()));
        return true;
    }

    async downloadFile(key: string) {
        return this.files.get(key) ?? false;
    }

    async listFilesByPrefix(prefix: string) {
        return [...this.objects.keys(), ...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    async listFiles(from: string) {
        return [...this.files.keys()].filter((key) => key > from).sort();
    }

    async listRemoteDeviceStates() {
        return [];
    }

    async getCheckpointInfo() {
        return this.checkpoint;
    }

    async updateCheckPointInfo(func: (info: CheckPointInfo) => CheckPointInfo) {
        this.checkpoint = func(this.checkpoint);
        return this.checkpoint;
    }

    async processCompressedJournalBytes(key: string) {
        this.processedKeys.push(key);
        return true;
    }

    nextEtag() {
        this.etagSeq++;
        return `etag-${this.etagSeq}`;
    }
}

function createCompaction(fake = new FakeCompactionClient()) {
    return new JournalSyncCompaction(fake as unknown as JournalSyncAbstract);
}

describe("JournalSyncCompaction", () => {
    it("returns false when current manifest is missing", async () => {
        const compaction = createCompaction();
        await expect(compaction.restoreCompactView()).resolves.toBe(false);
    });

    it("creates an initial snapshot manifest once", async () => {
        const fake = new FakeCompactionClient();
        const compaction = createCompaction(fake);
        const view = await compaction.ensureInitialSnapshotManifest();
        expect(view && view.generation).toBe(0);
        expect(fake.objects.has(formatManifestKey(0))).toBe(true);
        expect(fake.objects.has(JOURNAL_CURRENT_MANIFEST_KEY)).toBe(true);
        const second = await compaction.ensureInitialSnapshotManifest();
        expect(second && second.generation).toBe(0);
    });

    it("applies compact segments and writes only boundary markers", async () => {
        const fake = new FakeCompactionClient();
        const compaction = createCompaction(fake);
        const segment = await deflateJournalEntryStream([
            new TextEncoder().encode(JSON.stringify({ _id: "a", _rev: "1-a" }) + "\n"),
        ]);
        fake.files.set("_compact/start.pack", segment);
        await fake.uploadJson(formatManifestKey(0), {
            generation: 0,
            created_at: 1000,
            compacted_boundary: "64-docs.jsonl.gz",
            segments: [
                {
                    id: "compact-start",
                    key: "_compact/start.pack",
                    covers: { from_exclusive: null, to_inclusive: "64-docs.jsonl.gz" },
                },
            ],
        });
        await fake.uploadJson(JOURNAL_CURRENT_MANIFEST_KEY, { current: formatManifestKey(0), generation: 0 });

        const view = await compaction.applyCompactSegmentsToLocalCheckpoint();
        expect(view && view.compacted_boundary).toBe("64-docs.jsonl.gz");
        expect(fake.processedKeys).toEqual(["_compact/start.pack"]);
        expect(fake.checkpoint.receivedFiles.has("64-docs.jsonl.gz")).toBe(true);
    });

    it("does not advance boundary marker when compact segment is missing", async () => {
        const fake = new FakeCompactionClient();
        const compaction = createCompaction(fake);
        await fake.uploadJson(formatManifestKey(0), {
            generation: 0,
            created_at: 1000,
            compacted_boundary: "64-docs.jsonl.gz",
            segments: [
                {
                    id: "compact-start",
                    key: "_compact/missing.pack",
                    covers: { from_exclusive: null, to_inclusive: "64-docs.jsonl.gz" },
                },
            ],
        });
        await fake.uploadJson(JOURNAL_CURRENT_MANIFEST_KEY, { current: formatManifestKey(0), generation: 0 });

        await compaction.applyCompactSegmentsToLocalCheckpoint();
        expect(fake.processedKeys).toEqual([]);
        expect(fake.checkpoint.receivedFiles.has("64-docs.jsonl.gz")).toBe(false);
    });

    it("respects active and expired leases", async () => {
        const fake = new FakeCompactionClient();
        const compaction = createCompaction(fake);
        const plan = {
            based_on_generation: 0,
            range: { from_exclusive: null, to_inclusive: "64-docs.jsonl.gz" },
            output_segment_id: "compact-start",
            output_key: "_compact/start.pack",
        };
        const activeLease = {
            lease_id: "lease",
            owner_device_id: "other-device",
            range: plan.range,
            created_at: Date.now() - 1000,
            expires_at: Date.now() + 100000,
            based_on_generation: 0,
        };
        await fake.uploadJson("_control/leases/compaction/start__64-docs.jsonl.gz.json", activeLease);
        await expect(compaction.acquireLease("device-a", plan)).resolves.toBe(false);

        const existing = fake.objects.get("_control/leases/compaction/start__64-docs.jsonl.gz.json")!;
        fake.objects.set("_control/leases/compaction/start__64-docs.jsonl.gz.json", {
            ...existing,
            body: { ...activeLease, expires_at: Date.now() - 1 },
        });
        const lease = await compaction.acquireLease("device-a", plan);
        expect(lease && lease.owner_device_id).toBe("device-a");
    });
});
