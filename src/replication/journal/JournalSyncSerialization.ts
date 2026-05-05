import { type DocumentID, type EntryDoc, type EntryLeaf } from "../../common/types.ts";
import { concatUInt8Array, escapeNewLineFromString, unescapeNewLineFromString } from "../../common/utils.ts";
import { wrappedDeflate, wrappedInflate } from "../../pouchdb/compress.ts";

const RECORD_SPLIT = `\n`;
const UNIT_SPLIT = `\u001f`;
const te = new TextEncoder();

export type ProcessingEntry = PouchDB.Core.PutDocument<EntryDoc> & PouchDB.Core.GetMeta;

export function serializeJournalEntry(doc: EntryDoc): Uint8Array {
    if (doc._id.startsWith("h:")) {
        const data = (doc as EntryLeaf).data;
        const writeData = escapeNewLineFromString(data);
        return te.encode(`~${doc._id}${UNIT_SPLIT}${writeData}${RECORD_SPLIT}`);
    }
    return te.encode(JSON.stringify(doc) + RECORD_SPLIT);
}

export function decodeJournalEntryStream(decompressed: Uint8Array): ProcessingEntry[] {
    let idxFrom = 0;
    let idxTo = 0;
    const decoder = new TextDecoder();
    const result = [] as ProcessingEntry[];
    do {
        idxTo = decompressed.indexOf(0x0a, idxFrom);
        if (idxTo == -1) {
            break;
        }
        const piece = decompressed.slice(idxFrom, idxTo);
        const strPiece = decoder.decode(piece);
        if (strPiece.startsWith("~")) {
            const [key, data] = strPiece.substring(1).split(UNIT_SPLIT);
            result.push({
                _id: key as DocumentID,
                data: unescapeNewLineFromString(data),
                type: "leaf",
                _rev: "",
            });
        } else {
            result.push(JSON.parse(strPiece));
        }
        idxFrom = idxTo + 1;
    } while (idxTo > 0);
    return result;
}

export async function inflateJournalEntryStream(compressed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    return await wrappedInflate(new Uint8Array(compressed), { consume: true });
}

export async function deflateJournalEntryStream(decompressed: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
    return await wrappedDeflate(concatUInt8Array(decompressed), { consume: true, level: 8 });
}
