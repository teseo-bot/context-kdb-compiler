"use strict";
/**
 * Recursive Delimiter-Aware Text Chunker
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkText = chunkText;
const DELIMITERS = [
    ['\n\n'], // L0: paragraphs
    ['\n'], // L1: lines
    ['. ', '! ', '? ', '.\n', '!\n', '?\n'], // L2: sentences
    ['; ', ': ', ', '], // L3: clauses
    [], // L4: words (whitespace split)
];
function chunkText(text, opts) {
    const chunkSize = opts?.chunkSize || 300;
    const chunkOverlap = opts?.chunkOverlap || 50;
    if (!text || text.trim().length === 0)
        return [];
    const wordCount = countWords(text);
    if (wordCount <= chunkSize) {
        return [{ text: text.trim(), index: 0 }];
    }
    const pieces = recursiveSplit(text, 0, chunkSize);
    const merged = greedyMerge(pieces, chunkSize);
    const withOverlap = applyOverlap(merged, chunkOverlap);
    return withOverlap.map((t, i) => ({ text: t.trim(), index: i }));
}
function recursiveSplit(text, level, target) {
    if (level >= DELIMITERS.length) {
        return splitOnWhitespace(text, target);
    }
    const delimiters = DELIMITERS[level];
    if (delimiters.length === 0) {
        return splitOnWhitespace(text, target);
    }
    const pieces = splitAtDelimiters(text, delimiters);
    if (pieces.length <= 1) {
        return recursiveSplit(text, level + 1, target);
    }
    const result = [];
    for (const piece of pieces) {
        if (countWords(piece) > target) {
            result.push(...recursiveSplit(piece, level + 1, target));
        }
        else {
            result.push(piece);
        }
    }
    return result;
}
function splitAtDelimiters(text, delimiters) {
    const pieces = [];
    let remaining = text;
    while (remaining.length > 0) {
        let earliest = -1;
        let earliestDelim = '';
        for (const delim of delimiters) {
            const idx = remaining.indexOf(delim);
            if (idx !== -1 && (earliest === -1 || idx < earliest)) {
                earliest = idx;
                earliestDelim = delim;
            }
        }
        if (earliest === -1) {
            pieces.push(remaining);
            break;
        }
        const piece = remaining.slice(0, earliest + earliestDelim.length);
        if (piece.trim().length > 0) {
            pieces.push(piece);
        }
        remaining = remaining.slice(earliest + earliestDelim.length);
    }
    return pieces.filter(p => p.trim().length > 0);
}
function splitOnWhitespace(text, target) {
    const words = text.match(/\S+\s*/g) || [];
    if (words.length === 0)
        return [];
    const pieces = [];
    for (let i = 0; i < words.length; i += target) {
        const slice = words.slice(i, i + target).join('');
        if (slice.trim().length > 0) {
            pieces.push(slice);
        }
    }
    return pieces;
}
function greedyMerge(pieces, target) {
    if (pieces.length === 0)
        return [];
    const result = [];
    let current = pieces[0];
    for (let i = 1; i < pieces.length; i++) {
        const combined = current + pieces[i];
        if (countWords(combined) <= Math.ceil(target * 1.5)) {
            current = combined;
        }
        else {
            result.push(current);
            current = pieces[i];
        }
    }
    if (current.trim().length > 0) {
        result.push(current);
    }
    return result;
}
function applyOverlap(chunks, overlapWords) {
    if (chunks.length <= 1 || overlapWords <= 0)
        return chunks;
    const result = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
        const prevTrailing = extractTrailingContext(chunks[i - 1], overlapWords);
        result.push(prevTrailing + chunks[i]);
    }
    return result;
}
function extractTrailingContext(text, targetWords) {
    const words = text.match(/\S+\s*/g) || [];
    if (words.length <= targetWords)
        return '';
    const trailing = words.slice(-targetWords).join('');
    const sentenceStart = trailing.search(/[.!?]\s+/);
    if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
        const afterSentence = trailing.slice(sentenceStart).replace(/^[.!?]\s+/, '');
        if (afterSentence.trim().length > 0) {
            return afterSentence;
        }
    }
    return trailing;
}
function countWords(text) {
    return (text.match(/\S+/g) || []).length;
}
