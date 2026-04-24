import { PDFParse } from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import { config } from 'dotenv';

config();

const apiKey = process.env.GEMINI_DIRECT_KEY || process.env.GEMINI_API_KEYS?.split(',')[0] || '';
const ai = new GoogleGenAI({ apiKey });

export class DocumentDistiller {
  /**
   * Destila contenido multimedia usando Gemini Vision/Audio
   */
  private async distillMedia(buffer: Buffer, mimeType: string): Promise<string> {
    const base64Data = buffer.toString('base64');
    
    console.log(`[DocumentDistiller] Destilando media con Gemini... mimeType: ${mimeType}`);
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: base64Data, mimeType } },
            { text: "Analiza detalladamente este asset (imagen/documento/audio/video). Genera una transcripción o descripción técnica exhaustiva, optimizada para ser indexada en un sistema RAG de base de conocimiento." }
          ]
        }
      ]
    });
    
    console.log(`[DocumentDistiller] Destilación completada.`);
    return response.text || '';
  }

  /**
   * Processes a raw file buffer and returns a simulated Markdown string.
   */
  async processBuffer(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    let rawText = '';

    const mediaTypes = [
      'image/jpeg', 'image/png', 'image/webp',
      'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/mpeg',
      'video/mp4'
    ];

    if (mimeType === 'application/pdf') {
      // Parse PDF using the new API
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        rawText = result.text;
      } finally {
        await parser.destroy();
      }
    } else if (mimeType === 'text/plain') {
      // Validate/read TXT as UTF-8
      rawText = buffer.toString('utf-8');
    } else if (mediaTypes.includes(mimeType)) {
      rawText = await this.distillMedia(buffer, mimeType);
    } else {
      throw new Error(`Unsupported mimeType: ${mimeType} for file: ${filename}`);
    }

    return this.applyMarkdownHeuristics(rawText);
  }

  /**
   * Applies regex heuristics to simulate Markdown.
   */
  private applyMarkdownHeuristics(text: string): string {
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
