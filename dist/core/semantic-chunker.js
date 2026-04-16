"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkTextSemantic = chunkTextSemantic;
exports.splitSentences = splitSentences;
/**
 * Semantic Text Chunker
 */
const recursive_chunker_1 = require("./recursive-chunker");
async function chunkTextSemantic(text, opts) {
    const chunkSize = opts.chunkSize || 300;
    const chunkOverlap = opts.chunkOverlap || 50;
    const embedFn = opts.embedFn;
    if (!embedFn) {
        return (0, recursive_chunker_1.chunkText)(text, { chunkSize, chunkOverlap });
    }
    try {
        const sentences = splitSentences(text);
        if (sentences.length <= 3) {
            return (0, recursive_chunker_1.chunkText)(text, { chunkSize, chunkOverlap });
        }
        const embeddings = await embedFn(sentences);
        if (embeddings.length !== sentences.length) {
            return (0, recursive_chunker_1.chunkText)(text, { chunkSize, chunkOverlap });
        }
        const similarities = computeAdjacentSimilarities(embeddings);
        const boundaries = findBoundaries(similarities);
        const groups = groupAtBoundaries(sentences, boundaries);
        const chunks = [];
        let idx = 0;
        for (const group of groups) {
            const groupText = group.join(' ');
            const wordCount = (groupText.match(/\S+/g) || []).length;
            if (wordCount > chunkSize * 1.5) {
                const subChunks = (0, recursive_chunker_1.chunkText)(groupText, { chunkSize, chunkOverlap });
                for (const sc of subChunks) {
                    chunks.push({ text: sc.text, index: idx++ });
                }
            }
            else {
                chunks.push({ text: groupText.trim(), index: idx++ });
            }
        }
        return chunks;
    }
    catch (error) {
        console.error('Semantic chunker failed, falling back to recursive:', error);
        return (0, recursive_chunker_1.chunkText)(text, { chunkSize, chunkOverlap });
    }
}
function splitSentences(text) {
    const raw = text.split(/(?<=[.!?])\s+/);
    return raw
        .map(s => s.trim())
        .filter(s => s.length > 0);
}
function computeAdjacentSimilarities(embeddings) {
    const sims = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
        sims.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
    }
    return sims;
}
function findBoundaries(similarities) {
    if (similarities.length < 5) {
        return findBoundariesPercentile(similarities);
    }
    try {
        return findBoundariesSavGol(similarities);
    }
    catch {
        return findBoundariesPercentile(similarities);
    }
}
function findBoundariesSavGol(similarities) {
    const derivative = savitzkyGolay(similarities, 5, 3, 1);
    const minima = [];
    for (let i = 1; i < derivative.length; i++) {
        if (derivative[i - 1] < 0 && derivative[i] >= 0) {
            minima.push(i);
        }
    }
    const threshold = percentile(similarities, 0.2);
    const filtered = minima.filter(i => {
        const simIdx = Math.min(i, similarities.length - 1);
        return similarities[simIdx] < threshold;
    });
    return enforceMinDistance(filtered, 2);
}
function findBoundariesPercentile(similarities) {
    if (similarities.length === 0)
        return [];
    const threshold = percentile(similarities, 0.2);
    const boundaries = [];
    for (let i = 0; i < similarities.length; i++) {
        if (similarities[i] < threshold) {
            boundaries.push(i + 1);
        }
    }
    return enforceMinDistance(boundaries, 2);
}
function savitzkyGolay(data, windowSize, polyOrder, derivOrder) {
    const half = Math.floor(windowSize / 2);
    const n = data.length;
    if (n < windowSize)
        return data.slice();
    const J = [];
    for (let i = -half; i <= half; i++) {
        const row = [];
        for (let j = 0; j <= polyOrder; j++) {
            row.push(Math.pow(i, j));
        }
        J.push(row);
    }
    const JT = transpose(J);
    const JTJ = matMul(JT, J);
    const JTJinv = invertMatrix(JTJ);
    const coeffs = matMul(JTJinv, JT);
    const filterRow = coeffs[derivOrder];
    const factorial = factorialN(derivOrder);
    const result = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let val = 0;
        for (let j = -half; j <= half; j++) {
            const idx = Math.min(Math.max(i + j, 0), n - 1);
            val += filterRow[j + half] * data[idx];
        }
        result[i] = val * factorial;
    }
    return result;
}
function groupAtBoundaries(sentences, boundaries) {
    const groups = [];
    let start = 0;
    for (const b of boundaries) {
        if (b > start && b < sentences.length) {
            groups.push(sentences.slice(start, b));
            start = b;
        }
    }
    if (start < sentences.length) {
        groups.push(sentences.slice(start));
    }
    return groups.length > 0 ? groups : [sentences];
}
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(p * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)];
}
function enforceMinDistance(boundaries, minDist) {
    if (boundaries.length <= 1)
        return boundaries;
    const result = [boundaries[0]];
    for (let i = 1; i < boundaries.length; i++) {
        if (boundaries[i] - result[result.length - 1] >= minDist) {
            result.push(boundaries[i]);
        }
    }
    return result;
}
function transpose(m) {
    const rows = m.length, cols = m[0].length;
    const result = Array.from({ length: cols }, () => new Array(rows).fill(0));
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            result[j][i] = m[i][j];
        }
    }
    return result;
}
function matMul(a, b) {
    const rows = a.length, cols = b[0].length, inner = b.length;
    const result = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            for (let k = 0; k < inner; k++) {
                result[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    return result;
}
function invertMatrix(m) {
    const n = m.length;
    const aug = m.map((row, i) => {
        const identity = new Array(n).fill(0);
        identity[i] = 1;
        return [...row, ...identity];
    });
    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
                maxRow = row;
            }
        }
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
        const pivot = aug[col][col];
        if (Math.abs(pivot) < 1e-12) {
            throw new Error('Matrix is singular');
        }
        for (let j = 0; j < 2 * n; j++) {
            aug[col][j] /= pivot;
        }
        for (let row = 0; row < n; row++) {
            if (row === col)
                continue;
            const factor = aug[row][col];
            for (let j = 0; j < 2 * n; j++) {
                aug[row][j] -= factor * aug[col][j];
            }
        }
    }
    return aug.map(row => row.slice(n));
}
function factorialN(n) {
    let result = 1;
    for (let i = 2; i <= n; i++)
        result *= i;
    return result;
}
