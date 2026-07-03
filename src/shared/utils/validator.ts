export function isValidAShareSymbol(symbol: string): boolean {
    return /^\d{6}$/.test(symbol);
}

export function isValidGlobalIndexSymbol(symbol: string): boolean {
    return /^[A-Z0-9]{1,10}$/i.test(symbol);
}

export function isValidTagCode(tagCode: string): boolean {
    return /^BK\d{4}$/i.test(tagCode);
}
