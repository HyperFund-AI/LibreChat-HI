// Manual mock for multer to avoid missing busboy dependency
const multerMock = jest.fn(() => {
  return {
    single: jest.fn(() => (req, res, next) => next()),
    array: jest.fn(() => (req, res, next) => next()),
    fields: jest.fn(() => (req, res, next) => next()),
    any: jest.fn(() => (req, res, next) => next()),
    none: jest.fn(() => (req, res, next) => next()),
  };
});

// Add static methods that multer exports
multerMock.diskStorage = jest.fn((options) => {
  const storage = {
    _handleFile: jest.fn((req, file, cb) => {
      if (options.destination) {
        options.destination(req, file, (err, dest) => {
          if (err) return cb(err);
          if (options.filename) {
            options.filename(req, file, (err, filename) => {
              if (err) return cb(err);
              cb(null, { destination: dest, filename: filename });
            });
          } else {
            cb(null, { destination: dest });
          }
        });
      } else {
        cb(null, {});
      }
    }),
    _removeFile: jest.fn((req, file, cb) => cb(null)),
  };
  
  // Add getDestination and getFilename methods for testing
  if (options.destination) {
    storage.getDestination = options.destination;
  }
  if (options.filename) {
    storage.getFilename = options.filename;
  }
  
  return storage;
});

multerMock.memoryStorage = jest.fn(() => ({
  _handleFile: jest.fn((req, file, cb) => {
    const buffer = Buffer.from('mock file content');
    cb(null, { buffer: buffer });
  }),
  _removeFile: jest.fn((req, file, cb) => cb(null)),
}));

module.exports = multerMock;
