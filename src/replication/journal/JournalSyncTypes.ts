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
export type DeviceID = string;
export type RawJournalKey = string;
export type RawJournalBoundary = RawJournalKey | null;
export type DeviceStateKind = "active" | "stale" | "retired";

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
export const ACTIVE_HEARTBEAT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const CURSOR_REPORT_ADVANCE_THRESHOLD = 32;
export const CURSOR_REPORT_MIN_INTERVAL_MS = 60_000;

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

function isRawJournalKey(key: string): key is RawJournalKey {
    return key.length > 0 && !key.startsWith("_");
}

export function computeCursorFromJournalFileSets(
    receivedFiles: Iterable<string>,
    sentFiles: Iterable<string>
): RawJournalBoundary {
    const rawJournalKeys = sortRawJournalKeys(
        [...new Set([...receivedFiles, ...sentFiles])].filter((key) => isRawJournalKey(key))
    );
    return rawJournalKeys[rawJournalKeys.length - 1] ?? null;
}

export function countRawJournalKeysBetween(
    keys: Iterable<string>,
    fromExclusive: RawJournalBoundary,
    toInclusive: RawJournalBoundary
): number {
    if (toInclusive === null) return 0;
    return sortRawJournalKeys([...new Set(keys)].filter((key) => isRawJournalKey(key))).filter(
        (key) =>
            compareRawJournalBoundaries(key, fromExclusive) > 0 &&
            compareRawJournalBoundaries(key, toInclusive) <= 0
    ).length;
}

export function getDeviceStateObjectKey(deviceId: DeviceID): string {
    return `${JOURNAL_DEVICE_STATE_PREFIX}${encodeURIComponent(deviceId)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isDeviceStateKind(value: unknown): value is DeviceStateKind {
    return value === "active" || value === "stale" || value === "retired";
}

function isRawJournalBoundary(value: unknown): value is RawJournalBoundary {
    return value === null || typeof value === "string";
}

export function isDeviceStateDocument(value: unknown): value is DeviceStateDocument {
    if (!isRecord(value)) return false;
    if (!isRawJournalBoundary(value.cursor)) return false;
    if (typeof value.manifest_seen_generation !== "number" || !Number.isFinite(value.manifest_seen_generation)) {
        return false;
    }
    if (typeof value.last_heartbeat !== "number" || !Number.isFinite(value.last_heartbeat)) return false;
    if (value.last_applied_edit_seq !== undefined) {
        if (typeof value.last_applied_edit_seq !== "number" || !Number.isFinite(value.last_applied_edit_seq)) {
            return false;
        }
    }
    if (value.state !== undefined && !isDeviceStateKind(value.state)) return false;
    return true;
}

export function getActiveDeviceStates(
    states: Iterable<DeviceStateDocument>,
    now: number,
    windowMs: number = ACTIVE_HEARTBEAT_WINDOW_MS
): DeviceStateDocument[] {
    return [...states].filter(
        (state) =>
            (state.state === undefined || state.state === "active") && now - state.last_heartbeat <= windowMs
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
