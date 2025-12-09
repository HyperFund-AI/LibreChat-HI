const { Tool } = require('@langchain/core/tools');
const { z } = require('zod');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
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
    'The tool accepts text content, title, optional formatting options, and can include images from URLs or base64 data. ' +
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
    images: z
      .array(
        z
          .string()
          .describe(
            'Image URL or base64-encoded image data (data:image/...;base64,... format). Can include multiple images.',
          ),
      )
      .optional()
      .describe(
        'Optional array of image URLs or base64-encoded images to include in the PDF. Images will be embedded in the document.',
      ),
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
   * Downloads an image from a URL or converts base64 to buffer
   * @param {string} imageSource - URL or base64 data URI
   * @returns {Promise<Buffer>} Image buffer
   */
  async getImageBuffer(imageSource) {
    try {
      // Handle base64 data URIs
      if (imageSource.startsWith('data:image/')) {
        const base64Match = imageSource.match(/^data:image\/\w+;base64,(.+)$/);
        if (base64Match) {
          return Buffer.from(base64Match[1], 'base64');
        }
      }

      // Handle URLs
      if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
        const response = await axios({
          url: imageSource,
          responseType: 'arraybuffer',
          timeout: 30000,
        });
        return Buffer.from(response.data, 'binary');
      }

      // If it's already a base64 string without data URI prefix
      if (typeof imageSource === 'string' && imageSource.length > 100) {
        try {
          return Buffer.from(imageSource, 'base64');
        } catch (e) {
          // Not valid base64, treat as URL
        }
      }

      throw new Error(`Invalid image source format: ${imageSource.substring(0, 50)}...`);
    } catch (error) {
      logger.error(`[PDFGenerator] Error loading image from ${imageSource.substring(0, 50)}:`, error);
      throw new Error(`Failed to load image: ${error.message}`);
    }
  }

  /**
   * Generates a PDF document from the provided content
   */
  async generatePDF({ content, title, filename, includeMetadata, images = [] }) {
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

        // Store images to process - we'll add them after content
        const imagesToProcess = images || [];

        // Process images synchronously before finalizing
        // We'll process images in a promise and wait for them before ending the document
        const processImagesPromise = (async () => {
          if (imagesToProcess.length > 0) {
            doc.moveDown(2);
            doc.fontSize(14).font('Helvetica-Bold').text('Images:', { align: 'left' });
            doc.moveDown(1);

            for (let i = 0; i < imagesToProcess.length; i++) {
              try {
                const imageBuffer = await this.getImageBuffer(imagesToProcess[i]);
                const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
                const maxWidth = pageWidth;
                const maxHeight = 400; // Maximum height for images

                // Check if we need a new page
                const currentY = doc.y;
                const pageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
                if (currentY + maxHeight > pageHeight - 50) {
                  doc.addPage();
                }

                // Add image - pdfkit will maintain aspect ratio if we specify fit
                // Center horizontally
                const imageX = doc.page.margins.left;
                doc.image(imageBuffer, imageX, doc.y, {
                  fit: [maxWidth, maxHeight],
                });

                // Move down after image
                doc.moveDown(1);
                if (i < imagesToProcess.length - 1) {
                  doc.moveDown(1);
                }
              } catch (imageError) {
                logger.error(`[PDFGenerator] Error adding image ${i + 1}:`, imageError);
                doc.fontSize(10).font('Helvetica').fillColor('red');
                doc.text(`[Image ${i + 1} could not be loaded: ${imageError.message}]`, {
                  align: 'left',
                });
                doc.fillColor('black');
                doc.moveDown(1);
              }
            }
          }
        })();

        // Wait for images to be processed, then finalize PDF
        processImagesPromise
          .then(() => {
            doc.end();
          })
          .catch((error) => {
            logger.error('[PDFGenerator] Error processing images:', error);
            // Still finalize the PDF even if images fail
            doc.end();
          });

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

            // Save PDF directly to uploads directory (bypassing saveBuffer to avoid path issues)
            const formattedDate = new Date().toISOString();
            const userUploadDir = path.join(appConfig.paths.uploads, this.userId.toString());

            if (!fs.existsSync(userUploadDir)) {
              fs.mkdirSync(userUploadDir, { recursive: true });
            }

            const finalPath = path.join(userUploadDir, pdfFilename);
            fs.writeFileSync(finalPath, pdfBuffer);

            // Verify file was written
            if (!fs.existsSync(finalPath)) {
              throw new Error(`Failed to save PDF file to ${finalPath}`);
            }

            const actualFileSize = fs.statSync(finalPath).size;
            logger.debug(
              `[PDFGenerator] PDF saved successfully: ${finalPath} (${actualFileSize} bytes)`,
            );

            // Filepath should be relative to uploads root: /uploads/userId/filename.pdf
            const filepath = path.posix.join('/', 'uploads', this.userId.toString(), pdfFilename);
            const bytes = actualFileSize;

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
      const { content, title, filename, includeMetadata = true, images } = args;

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
        images: images || [],
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
