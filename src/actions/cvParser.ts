import mammoth from "mammoth";

/**
 * Extract plain text from a DOCX buffer using mammoth.
 */
export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(): Promise<{ text: string }>;
    getScreenshot(opts?: { scale?: number }): Promise<{
      pages: Array<{ data: Uint8Array; pageNumber: number; width: number; height: number }>;
      total: number;
    }>;
  };
};

/**
 * Extract plain text from a PDF buffer.
 * Returns the cleaned text ready for Claude.
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const data = await parser.getText();

  // Clean up: collapse excessive whitespace, normalize line breaks
  return data.text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Download a file from Telegram and return its buffer.
 */
export async function downloadTelegramFile(
  fileId: string,
  botToken: string
): Promise<{ buffer: Buffer; filename: string }> {
  // Step 1: get the file path from Telegram
  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  );
  const meta = (await metaRes.json()) as {
    ok: boolean;
    result: { file_path: string };
  };

  if (!meta.ok) throw new Error("Could not get file info from Telegram");

  const filePath = meta.result.file_path;
  const filename = filePath.split("/").pop() ?? "cv.pdf";

  // Step 2: download the actual file bytes
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`
  );

  if (!fileRes.ok) throw new Error(`Failed to download file: ${fileRes.status}`);

  const arrayBuffer = await fileRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), filename };
}

/**
 * Render each page of a PDF as a PNG buffer.
 * Returns up to maxPages pages.
 */
export async function extractPDFPages(
  buffer: Buffer,
  maxPages = 10
): Promise<Array<{ pageNumber: number; png: Buffer }>> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getScreenshot({ scale: 0.75 });

  return result.pages
    .slice(0, maxPages)
    .map((page) => ({
      pageNumber: page.pageNumber,
      png: Buffer.from(page.data),
    }));
}
