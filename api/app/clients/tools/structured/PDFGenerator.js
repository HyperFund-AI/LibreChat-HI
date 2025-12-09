const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { logger } = require('@librechat/data-schemas');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { FileContext, FileSources } = require('librechat-data-provider');
const { createFile } = require('~/models/File');

/**
 * PDF Generation Tool
 * Generates PDF documents from text content, conversation data, or structured information.
 */
class PDFGenerator extends Tool {
  name = 'generate_pdf';
  description =
    'Generates a PDF document from text content, conversation data, or structured information. ' +
    'Use this tool when the user asks to create, generate, or export content as a PDF. ' +
    'The tool accepts text content, title, and optional formatting options. ' +
    'Returns a file reference that can be downloaded.';

  schema = z.object({
    content: z
      .string()
      .describe(
        'The main content to include in the PDF. Can be plain text, markdown-like content, or structured data.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'Optional title for the PDF document. If not provided, a default title will be used.',
      ),
    filename: z
      .string()
      .optional()
      .describe(
        'Optional custom filename for the PDF (without .pdf extension). If not provided, a generated name will be used.',
      ),
    includeMetadata: z
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to include metadata (title, creation date) in the PDF.'),
  });

  constructor(fields = {}) {
    super();
    this.override = fields.override ?? false;
    // During tool loading/formatting, req may not be available
    // It will be set when the tool is actually invoked
    this.req = fields.req;
    this.userId = fields.userId || fields.req?.user?.id;
    // Extract conversationId and messageId from req.body if available
    this.conversationId = fields.conversationId || fields.req?.body?.conversationId;
    this.messageId = fields.messageId || fields.req?.body?.messageId;
    this.toolCallId = fields.toolCallId;
  }

  /**
   * Converts markdown-like formatting to plain text for PDF
   */
  stripMarkdown(text) {
    return text
      .replace(/#{1,6}\s+/g, '') // Remove headers
      .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.+?)\*/g, '$1') // Remove italic
      .replace(/`(.+?)`/g, '$1') // Remove code
      .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Remove links
      .replace(/\n{3,}/g, '\n\n') // Normalize line breaks
      .trim();
  }

  /**
   * Generates a PDF document from the provided content
   */
  async generatePDF({ content, title, filename, includeMetadata }) {
    return new Promise((resolve, reject) => {
      try {
        const appConfig = this.req.config;
        const file_id = uuidv4();
        const pdfFilename = filename ? `${filename}.pdf` : `${file_id}.pdf`;
        const tempDir = path.join(appConfig.paths.uploads, 'temp', this.userId);

        // Ensure temp directory exists
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const tempFilePath = path.join(tempDir, pdfFilename);
        const doc = new PDFDocument({
          margins: { top: 50, bottom: 50, left: 50, right: 50 },
        });

        const stream = fs.createWriteStream(tempFilePath);
        doc.pipe(stream);

        // Add title and metadata if requested
        if (includeMetadata && title) {
          doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
          doc.moveDown(2);
        }

        // Add creation date
        if (includeMetadata) {
          doc.fontSize(10).font('Helvetica').fillColor('gray');
          doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'right' });
          doc.moveDown(1);
          doc.fillColor('black');
        }

        // Process and add content
        const cleanContent = this.stripMarkdown(content);
        doc.fontSize(12).font('Helvetica');

        // Split content into paragraphs and add them
        const paragraphs = cleanContent.split(/\n\n+/);
        paragraphs.forEach((paragraph, index) => {
          if (paragraph.trim()) {
            // Check if this looks like a header (all caps or starts with number)
            if (paragraph.match(/^[A-Z\s]+$/) || paragraph.match(/^\d+\./)) {
              doc.fontSize(14).font('Helvetica-Bold');
              doc.text(paragraph.trim());
              doc.fontSize(12).font('Helvetica');
            } else {
              doc.text(paragraph.trim(), {
                align: 'left',
                lineGap: 5,
              });
            }
            if (index < paragraphs.length - 1) {
              doc.moveDown(1);
            }
          }
        });

        // Finalize PDF
        doc.end();

        stream.on('finish', async () => {
          try {
            // Read the generated PDF file
            const pdfBuffer = fs.readFileSync(tempFilePath);
            const fileSize = pdfBuffer.length;

            // Get file storage strategy
            const source = getFileStrategy(appConfig, {
              isImage: false,
              context: FileContext.pdf_generation,
            });

            // Save PDF using the appropriate storage strategy
            const { saveBuffer } = getStrategyFunctions(source);
            const formattedDate = new Date().toISOString();

            let filepath;
            let bytes = fileSize;

            if (saveBuffer) {
              // Use storage strategy to save the buffer
              // saveBuffer typically returns a filepath string for local storage
              try {
                const savedPath = await saveBuffer({
                  userId: this.userId,
                  buffer: pdfBuffer,
                  fileName: pdfFilename,
                  basePath: 'uploads',
                });
                filepath =
                  savedPath ||
                  path.posix.join('/', 'uploads', this.userId.toString(), pdfFilename);
              } catch (saveError) {
                logger.error('[PDFGenerator] Error saving buffer:', saveError);
                // Fallback to temp file path
                const relativePath = path.relative(appConfig.paths.uploads, tempFilePath);
                filepath = `/api/files/${relativePath}`;
              }
            } else {
              // Fallback to local file path
              const relativePath = path.relative(appConfig.paths.uploads, tempFilePath);
              filepath = `/api/files/${relativePath}`;
            }

            // Create file record in database
            const file = {
              file_id,
              filename: pdfFilename,
              filepath,
              bytes,
              type: 'application/pdf',
              user: this.userId,
              conversationId: this.conversationId,
              source: source || FileSources.local,
              context: FileContext.pdf_generation,
              usage: 1,
              createdAt: formattedDate,
              updatedAt: formattedDate,
            };

            await createFile(file, true);

            // Clean up temp file if it was moved
            try {
              if (fs.existsSync(tempFilePath) && saveBuffer) {
                fs.unlinkSync(tempFilePath);
              }
            } catch (cleanupError) {
              logger.warn(`Failed to cleanup temp file: ${cleanupError.message}`);
            }

            resolve({
              file_id,
              filename: pdfFilename,
              filepath,
              bytes,
              message: `PDF generated successfully: ${pdfFilename}`,
            });
          } catch (error) {
            logger.error('[PDFGenerator] Error saving PDF:', error);
            reject(error);
          }
        });

        stream.on('error', (error) => {
          logger.error('[PDFGenerator] Stream error:', error);
          reject(error);
        });
      } catch (error) {
        logger.error('[PDFGenerator] Error generating PDF:', error);
        reject(error);
      }
    });
  }

  async _call(args) {
    try {
      const { content, title, filename, includeMetadata = true } = args;

      if (!content || content.trim().length === 0) {
        return JSON.stringify({
          error: 'Content is required to generate a PDF',
        });
      }

      // Ensure req is available (should be set when tool is instantiated for actual use)
      if (!this.req) {
        return JSON.stringify({
          success: false,
          error: 'PDF generation tool is not properly initialized. Please try again.',
        });
      }

      const result = await this.generatePDF({
        content,
        title: title || 'Generated Document',
        filename,
        includeMetadata,
      });

      return JSON.stringify({
        success: true,
        message: result.message,
        file: {
          file_id: result.file_id,
          filename: result.filename,
          filepath: result.filepath,
          bytes: result.bytes,
        },
        download_url: result.filepath,
      });
    } catch (error) {
      logger.error('[PDFGenerator] Tool call error:', error);
      return JSON.stringify({
        success: false,
        error: `Failed to generate PDF: ${error.message}`,
      });
    }
  }
}

module.exports = PDFGenerator;
