"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentDistiller = void 0;
const pdf_parse_1 = require("pdf-parse");
class DocumentDistiller {
    /**
     * Processes a raw file buffer and returns a simulated Markdown string.
     */
    async processBuffer(buffer, mimeType, filename) {
        let rawText = '';
        if (mimeType === 'application/pdf') {
            // Parse PDF using the new API
            const parser = new pdf_parse_1.PDFParse({ data: buffer });
            try {
                const result = await parser.getText();
                rawText = result.text;
            }
            finally {
                await parser.destroy();
            }
        }
        else if (mimeType === 'text/plain') {
            // Validate/read TXT as UTF-8
            rawText = buffer.toString('utf-8');
        }
        else {
            throw new Error(`Unsupported mimeType: ${mimeType} for file: ${filename}`);
        }
        return this.applyMarkdownHeuristics(rawText);
    }
    /**
     * Applies regex heuristics to simulate Markdown.
     */
    applyMarkdownHeuristics(text) {
        // 1. Remove carriage returns
        let processed = text.replace(/\r/g, '');
        // 2. Remove multiple empty lines (3 or more down to 2)
        processed = processed.replace(/\n{3,}/g, '\n\n');
        // 3. Detect uppercase lines (often headers) and convert to ## Titles.
        // Matches lines with at least 3 uppercase characters and spaces, but no lowercase letters.
        processed = processed.replace(/^([A-ZÁÉÍÓÚÑ0-9\s.,;:()\-]{4,})$/gm, (match) => {
            // Only transform if it has letters, not just numbers/symbols
            if (/[A-ZÁÉÍÓÚÑ]/.test(match)) {
                return `## ${match.trim()}`;
            }
            return match;
        });
        // 4. Ensure there's space around headers
        processed = processed.replace(/([^\n])\n(## [^\n]+)/g, '$1\n\n$2');
        processed = processed.replace(/(## [^\n]+)\n([^\n])/g, '$1\n\n$2');
        return processed.trim();
    }
}
exports.DocumentDistiller = DocumentDistiller;
