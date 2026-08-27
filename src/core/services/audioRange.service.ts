export interface ByteRange {
    start: number
    end: number
}

/** Parse exactly one RFC 7233 byte range for a known-size local file. */
export function parseSingleByteRange(value: string | undefined, fileSize: number): ByteRange | null {
    if (!value || fileSize <= 0 || value.includes(',')) return null
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
    if (!match) return null

    const [, rawStart, rawEnd] = match
    if (!rawStart && !rawEnd) return null

    if (!rawStart) {
        const suffixLength = Number(rawEnd)
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
        return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 }
    }

    const start = Number(rawStart)
    const requestedEnd = rawEnd ? Number(rawEnd) : fileSize - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
        || start < 0 || requestedEnd < start || start >= fileSize) return null

    return { start, end: Math.min(requestedEnd, fileSize - 1) }
}
