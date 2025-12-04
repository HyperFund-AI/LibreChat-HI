const crypto = require('crypto');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const { getPresets, savePreset, deletePresets } = require('~/models');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { storage } = require('./files/multer');

const router = express.Router();
router.use(requireJwtAuth);

router.get('/', async (req, res) => {
  const presets = (await getPresets(req.user.id)).map((preset) => preset);
  res.status(200).json(presets);
});

router.post('/', async (req, res) => {
  const update = req.body || {};

  update.presetId = update?.presetId || crypto.randomUUID();

  try {
    const preset = await savePreset(req.user.id, update);
    res.status(201).json(preset);
  } catch (error) {
    logger.error('[/presets] error saving preset', error);
    res.status(500).send('There was an error when saving the preset');
  }
});

router.post('/delete', async (req, res) => {
  let filter = {};
  const { presetId } = req.body || {};

  if (presetId) {
    filter = { presetId };
  }

  logger.debug('[/presets/delete] delete preset filter', filter);

  try {
    const deleteCount = await deletePresets(req.user.id, filter);
    res.status(201).json(deleteCount);
  } catch (error) {
    logger.error('[/presets/delete] error deleting presets', error);
    res.status(500).send('There was an error deleting the presets');
  }
});

/**
 * Upload a persona file and create a preset from it
 * Accepts .md, .txt, or .markdown files
 */
router.post('/upload-persona', async (req, res) => {
  // Custom file filter for persona files
  const personaFileFilter = (req, file, cb) => {
    if (!file) {
      return cb(new Error('No file provided'), false);
    }

    const allowedMimeTypes = ['text/markdown', 'text/plain', 'text/x-markdown'];
    const fileExt = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.md', '.txt', '.markdown'];

    // Check both mime type and file extension
    const isValidMimeType = allowedMimeTypes.includes(file.mimetype);
    const isValidExtension = allowedExtensions.includes(fileExt);

    if (isValidMimeType || isValidExtension) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only .md, .txt, and .markdown files are allowed'), false);
    }
  };

  const upload = multer({
    storage,
    fileFilter: personaFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for persona files
  }).single('personaFile');

  upload(req, res, async (err) => {
    if (err) {
      logger.error('[/presets/upload-persona] multer error', err);
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const file = req.file;
    const fileExt = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.md', '.txt', '.markdown'];

    if (!allowedExtensions.includes(fileExt)) {
      try {
        await fs.unlink(file.path);
      } catch (unlinkError) {
        logger.warn('[/presets/upload-persona] Error deleting temp file', unlinkError);
      }
      return res.status(400).json({
        error: 'Invalid file type. Only .md, .txt, and .markdown files are allowed',
      });
    }

    try {
      // Read the file content
      const fileContent = await fs.readFile(file.path, 'utf-8');

      // Clean up temp file
      await fs.unlink(file.path);

      // Extract title from filename (remove extension)
      const baseName = path.basename(file.originalname, fileExt);
      const presetTitle = req.body.title || baseName || 'Persona Preset';

      // Create preset with the persona content in the system field
      const preset = {
        presetId: crypto.randomUUID(),
        title: presetTitle,
        endpoint: req.body.endpoint || 'anthropic',
        system: fileContent,
        // Set default model if not provided
        model: req.body.model || undefined,
      };

      const savedPreset = await savePreset(req.user.id, preset);
      res.status(201).json(savedPreset);
    } catch (error) {
      logger.error('[/presets/upload-persona] error processing persona file', error);

      // Try to clean up temp file on error
      try {
        await fs.unlink(file.path);
      } catch (unlinkError) {
        logger.warn('[/presets/upload-persona] Error deleting temp file on error', unlinkError);
      }

      res.status(500).json({ error: 'There was an error processing the persona file' });
    }
  });
});

module.exports = router;
