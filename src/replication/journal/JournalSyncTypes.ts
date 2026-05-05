export type CheckPointInfo = {
    lastLocalSeq: number | string;
    journalEpoch: string;
    knownIDs: Set<string>;
    sentIDs: Set<string>;
    receivedFiles: Set<string>;
    sentFiles: Set<string>;
};
export const CheckPointInfoDefault: CheckPointInfo = {
    lastLocalSeq: 0,
    journalEpoch: "",
    knownIDs: new Set<string>(),
    sentIDs: new Set<string>(),
    receivedFiles: new Set<string>(),
    sentFiles: new Set<string>(),
};

export type Generation = number;
export type EditSeq = number;
export type SegmentID = string;
export type DeviceID = string;
export type RawJournalKey = string;
export type RawJournalBoundary = RawJournalKey | null;
export type DeviceStateKind = "active" | "stale" | "retired";

export interface RawJournalKeyRange {
    from_exclusive: RawJournalBoundary;
    to_inclusive: RawJournalKey;
}

export interface ManifestSegmentEntry {
    id: SegmentID;
    key: string;
    covers: RawJournalKeyRange;
    created_at?: number;
    checksum?: string;
    size?: number;
}

export interface SnapshotManifestDocument {
    generation: Generation;
    created_at: number;
    compacted_boundary: RawJournalBoundary;
    segments: ManifestSegmentEntry[];
}

export interface CurrentManifestPointer {
    current: string;
    generation: Generation;
}

export type CompactSegmentFormat = "journal-entry-stream-v1";

export interface CompactionEditNewSegment {
    id: SegmentID;
    key: string;
    format: CompactSegmentFormat;
    covers: RawJournalKeyRange;
    checksum?: string;
    size?: number;
}

export interface CompactionEditDocument {
    edit_seq: EditSeq;
    based_on_generation: Generation;
    created_at: number;
    new_segment: CompactionEditNewSegment;
    replaces: SegmentID[];
}

export interface CompactionLeaseDocument {
    lease_id: string;
    owner_device_id: DeviceID;
    range: RawJournalKeyRange;
    created_at: number;
    expires_at: number;
    based_on_generation: Generation;
}

export interface CompactView {
    generation: Generation;
    compacted_boundary: RawJournalBoundary;
    segments: ManifestSegmentEntry[];
    applied_edit_seq?: EditSeq;
}

export interface CompactionPlan {
    based_on_generation: Generation;
    range: RawJournalKeyRange;
    output_segment_id: SegmentID;
    output_key: string;
}

export type ObjectStoreUploadCondition = { ifNoneMatch: "*" } | { ifMatch: string };
export type ConditionalUploadResult = boolean | "precondition-failed";
export interface DownloadedJsonWithMetadata<T> {
    body: T;
    etag?: string;
}

export interface DeviceStateDocument {
    cursor: RawJournalBoundary;
    manifest_seen_generation: Generation;
    last_applied_edit_seq?: EditSeq;
    last_heartbeat: number;
    state?: DeviceStateKind;
}

export interface DeviceParticipationRule {
    active_heartbeat_window_ms: number;
}

export const JOURNAL_CONTROL_PREFIX = "_control/";
export const JOURNAL_DEVICE_STATE_PREFIX = `${JOURNAL_CONTROL_PREFIX}devices/`;
export const JOURNAL_CURRENT_MANIFEST_KEY = `${JOURNAL_CONTROL_PREFIX}current-manifest`;
export const JOURNAL_MANIFEST_PREFIX = `${JOURNAL_CONTROL_PREFIX}manifest/`;
export const JOURNAL_COMPACTION_EDITS_PREFIX = `${JOURNAL_CONTROL_PREFIX}compaction-edits/`;
export const JOURNAL_COMPACT_PREFIX = "_compact/";
export const JOURNAL_COMPACTION_LEASE_PREFIX = `${JOURNAL_CONTROL_PREFIX}leases/compaction/`;
export const ACTIVE_HEARTBEAT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const CURSOR_REPORT_ADVANCE_THRESHOLD = 32;
export const CURSOR_REPORT_MIN_INTERVAL_MS = 60_000;
export const COMPACT_TRIGGER_MIN_RAW_JOURNALS = 64;
export const COMPACT_SEGMENT_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const COMPACT_SEGMENT_MAX_ENTRIES = 2000;
export const COMPACTION_LEASE_TTL_MS = 10 * 60 * 1000;

export type DeviceStateCursorAdvanceInput = {
    previousReportedCursor: RawJournalBoundary;
    currentCursor: RawJournalBoundary;
    receivedFiles: Iterable<string>;
    sentFiles: Iterable<string>;
    lastReportedAt: number;
    now: number;
};

export function compareRawJournalKeys(a: RawJournalKey, b: RawJournalKey): number {
    return a.localeCompare(b, undefined, { numeric: true });
}

export function compareRawJournalBoundaries(a: RawJournalBoundary, b: RawJournalBoundary): number {
    if (a === b) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return compareRawJournalKeys(a, b);
}

export function sortRawJournalKeys(keys: Iterable<string>): RawJournalKey[] {
    return [...keys].sort(compareRawJournalKeys);
}

export function isRawJournalKeyPublic(key: string): key is RawJournalKey {
    return key.length > 0 && !key.startsWith("_");
}

export function computeCursorFromJournalFileSets(
    receivedFiles: Iterable<string>,
    sentFiles: Iterable<string>
): RawJournalBoundary {
    const rawJournalKeys = sortRawJournalKeys(
        [...new Set([...receivedFiles, ...sentFiles])].filter((key) => isRawJournalKeyPublic(key))
    );
    return rawJournalKeys[rawJournalKeys.length - 1] ?? null;
}

export function countRawJournalKeysBetween(
    keys: Iterable<string>,
    fromExclusive: RawJournalBoundary,
    toInclusive: RawJournalBoundary
): number {
    if (toInclusive === null) return 0;
    return sortRawJournalKeys([...new Set(keys)].filter((key) => isRawJournalKeyPublic(key))).filter(
        (key) =>
            compareRawJournalBoundaries(key, fromExclusive) > 0 && compareRawJournalBoundaries(key, toInclusive) <= 0
    ).length;
}

export function getDeviceStateObjectKey(deviceId: DeviceID): string {
    return `${JOURNAL_DEVICE_STATE_PREFIX}${encodeURIComponent(deviceId)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRawJournalKey(value: unknown): value is RawJournalKey {
    return typeof value === "string" && isRawJournalKeyPublic(value);
}

function isDeviceStateKind(value: unknown): value is DeviceStateKind {
    return value === "active" || value === "stale" || value === "retired";
}

function isRawJournalBoundary(value: unknown): value is RawJournalBoundary {
    return value === null || isRawJournalKey(value);
}

export function isRawJournalKeyRange(value: unknown): value is RawJournalKeyRange {
    if (!isRecord(value)) return false;
    if (!isRawJournalBoundary(value.from_exclusive)) return false;
    if (!isRawJournalKey(value.to_inclusive)) return false;
    return compareRawJournalBoundaries(value.from_exclusive, value.to_inclusive) < 0;
}

function isManifestSegmentEntry(value: unknown): value is ManifestSegmentEntry {
    if (!isRecord(value)) return false;
    if (typeof value.id !== "string" || value.id.length === 0) return false;
    if (typeof value.key !== "string" || !value.key.startsWith(JOURNAL_COMPACT_PREFIX)) return false;
    if (!isRawJournalKeyRange(value.covers)) return false;
    if (value.created_at !== undefined && !isFiniteNumber(value.created_at)) return false;
    if (value.checksum !== undefined && typeof value.checksum !== "string") return false;
    if (value.size !== undefined && !isFiniteNumber(value.size)) return false;
    return true;
}

export function isSnapshotManifestDocument(value: unknown): value is SnapshotManifestDocument {
    if (!isRecord(value)) return false;
    if (!isFiniteNumber(value.generation) || value.generation < 0) return false;
    if (!isFiniteNumber(value.created_at)) return false;
    if (!isRawJournalBoundary(value.compacted_boundary)) return false;
    const compactedBoundary = value.compacted_boundary;
    if (!Array.isArray(value.segments) || !value.segments.every(isManifestSegmentEntry)) return false;
    return value.segments.every(
        (segment) => compareRawJournalBoundaries(segment.covers.to_inclusive, compactedBoundary) <= 0
    );
}

export function isCurrentManifestPointer(value: unknown): value is CurrentManifestPointer {
    if (!isRecord(value)) return false;
    if (typeof value.current !== "string" || !value.current.startsWith(JOURNAL_MANIFEST_PREFIX)) return false;
    if (!isFiniteNumber(value.generation) || value.generation < 0) return false;
    return true;
}

function isCompactSegmentFormat(value: unknown): value is CompactSegmentFormat {
    return value === "journal-entry-stream-v1";
}

function isCompactionEditNewSegment(value: unknown): value is CompactionEditNewSegment {
    if (!isRecord(value)) return false;
    if (typeof value.id !== "string" || value.id.length === 0) return false;
    if (typeof value.key !== "string" || !value.key.startsWith(JOURNAL_COMPACT_PREFIX)) return false;
    if (!isCompactSegmentFormat(value.format)) return false;
    if (!isRawJournalKeyRange(value.covers)) return false;
    if (value.checksum !== undefined && typeof value.checksum !== "string") return false;
    if (value.size !== undefined && !isFiniteNumber(value.size)) return false;
    return true;
}

export function isCompactionEditDocument(value: unknown): value is CompactionEditDocument {
    if (!isRecord(value)) return false;
    if (!isFiniteNumber(value.edit_seq) || value.edit_seq < 1) return false;
    if (!isFiniteNumber(value.based_on_generation) || value.based_on_generation < 0) return false;
    if (!isFiniteNumber(value.created_at)) return false;
    if (!isCompactionEditNewSegment(value.new_segment)) return false;
    if (!isStringArray(value.replaces)) return false;
    return true;
}

export function isCompactionLeaseDocument(value: unknown): value is CompactionLeaseDocument {
    if (!isRecord(value)) return false;
    if (typeof value.lease_id !== "string" || value.lease_id.length === 0) return false;
    if (typeof value.owner_device_id !== "string" || value.owner_device_id.length === 0) return false;
    if (!isRawJournalKeyRange(value.range)) return false;
    if (!isFiniteNumber(value.created_at)) return false;
    if (!isFiniteNumber(value.expires_at)) return false;
    if (!isFiniteNumber(value.based_on_generation) || value.based_on_generation < 0) return false;
    return value.expires_at > value.created_at;
}

export function isDeviceStateDocument(value: unknown): value is DeviceStateDocument {
    if (!isRecord(value)) return false;
    if (!isRawJournalBoundary(value.cursor)) return false;
    if (!isFiniteNumber(value.manifest_seen_generation)) {
        return false;
    }
    if (!isFiniteNumber(value.last_heartbeat)) return false;
    if (value.last_applied_edit_seq !== undefined) {
        if (!isFiniteNumber(value.last_applied_edit_seq)) return false;
    }
    if (value.state !== undefined && !isDeviceStateKind(value.state)) return false;
    return true;
}

export function formatManifestKey(generation: Generation): string {
    return `${JOURNAL_MANIFEST_PREFIX}manifest-${generation.toString().padStart(6, "0")}.json`;
}

export function formatCompactionEditKey(editSeq: EditSeq): string {
    return `${JOURNAL_COMPACTION_EDITS_PREFIX}${editSeq.toString().padStart(12, "0")}.json`;
}

export function createCompactionRangeToken(range: RawJournalKeyRange): string {
    const from = range.from_exclusive === null ? "start" : encodeURIComponent(range.from_exclusive);
    const to = encodeURIComponent(range.to_inclusive);
    return `${from}__${to}`;
}

export function applyCompactionEditToView(view: CompactView, edit: CompactionEditDocument): CompactView {
    if (edit.based_on_generation !== view.generation) return view;
    if (view.segments.some((segment) => segment.id === edit.new_segment.id)) {
        return { ...view, applied_edit_seq: edit.edit_seq };
    }
    if (compareRawJournalBoundaries(edit.new_segment.covers.to_inclusive, view.compacted_boundary) <= 0) {
        return { ...view, applied_edit_seq: edit.edit_seq };
    }
    if (compareRawJournalBoundaries(edit.new_segment.covers.from_exclusive, view.compacted_boundary) !== 0) {
        return view;
    }
    const replaced = new Set(edit.replaces);
    const newSegment: ManifestSegmentEntry = {
        id: edit.new_segment.id,
        key: edit.new_segment.key,
        covers: edit.new_segment.covers,
        created_at: edit.created_at,
        checksum: edit.new_segment.checksum,
        size: edit.new_segment.size,
    };
    return {
        generation: view.generation,
        compacted_boundary: edit.new_segment.covers.to_inclusive,
        segments: [...view.segments.filter((segment) => !replaced.has(segment.id)), newSegment],
        applied_edit_seq: edit.edit_seq,
    };
}

export function restoreCompactViewFromSnapshotAndEdits(
    snapshot: SnapshotManifestDocument,
    edits: Iterable<CompactionEditDocument>
): CompactView {
    return [...edits]
        .filter((edit) => edit.based_on_generation === snapshot.generation)
        .sort((a, b) => a.edit_seq - b.edit_seq)
        .reduce<CompactView>((view, edit) => applyCompactionEditToView(view, edit), {
            generation: snapshot.generation,
            compacted_boundary: snapshot.compacted_boundary,
            segments: [...snapshot.segments],
        });
}

export function computePrefixCompactionPlan(
    view: CompactView,
    activeDevices: Iterable<DeviceStateDocument>,
    rawKeys: Iterable<string>
): CompactionPlan | false {
    const devices = [...activeDevices];
    if (devices.length === 0 || devices.some((device) => device.cursor === null)) return false;
    const cursors = devices.map((device) => device.cursor as RawJournalKey).sort(compareRawJournalKeys);
    const minActiveCursor = cursors[0];
    if (!minActiveCursor) return false;
    if (compareRawJournalBoundaries(minActiveCursor, view.compacted_boundary) <= 0) return false;

    const candidateKeys = sortRawJournalKeys([...new Set(rawKeys)].filter((key) => isRawJournalKeyPublic(key))).filter(
        (key) =>
            compareRawJournalBoundaries(key, view.compacted_boundary) > 0 &&
            compareRawJournalBoundaries(key, minActiveCursor) <= 0
    );
    if (candidateKeys.length < COMPACT_TRIGGER_MIN_RAW_JOURNALS) return false;

    const toInclusive = candidateKeys[candidateKeys.length - 1];
    const range = {
        from_exclusive: view.compacted_boundary,
        to_inclusive: toInclusive,
    } satisfies RawJournalKeyRange;
    const rangeToken = createCompactionRangeToken(range);
    return {
        based_on_generation: view.generation,
        range,
        output_segment_id: `compact-${rangeToken}`,
        output_key: `${JOURNAL_COMPACT_PREFIX}${rangeToken}.pack`,
    };
}

export function getActiveDeviceStates(
    states: Iterable<DeviceStateDocument>,
    now: number,
    windowMs: number = ACTIVE_HEARTBEAT_WINDOW_MS
): DeviceStateDocument[] {
    return [...states].filter(
        (state) => (state.state === undefined || state.state === "active") && now - state.last_heartbeat <= windowMs
    );
}

export function shouldReportDeviceStateByCursorAdvance(input: DeviceStateCursorAdvanceInput): boolean {
    const { previousReportedCursor, currentCursor, receivedFiles, sentFiles, lastReportedAt, now } = input;
    if (currentCursor === null) return false;
    if (now - lastReportedAt < CURSOR_REPORT_MIN_INTERVAL_MS) return false;
    if (previousReportedCursor !== null && compareRawJournalBoundaries(previousReportedCursor, currentCursor) >= 0) {
        return false;
    }
    if (previousReportedCursor === null) return true;
    const advancedCount = countRawJournalKeysBetween(
        [...receivedFiles, ...sentFiles],
        previousReportedCursor,
        currentCursor
    );
    return advancedCount > CURSOR_REPORT_ADVANCE_THRESHOLD;
}
