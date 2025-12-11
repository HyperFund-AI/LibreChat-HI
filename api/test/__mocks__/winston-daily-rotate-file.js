// Manual mock for winston-daily-rotate-file
// This prevents the module from trying to load file-stream-rotator
module.exports = jest.fn().mockImplementation(function(options) {
  this.level = options?.level || 'error';
  this.filename = options?.filename || '../logs/error-%DATE%.log';
  this.datePattern = options?.datePattern || 'YYYY-MM-DD';
  this.zippedArchive = options?.zippedArchive !== false;
  this.maxSize = options?.maxSize || '20m';
  this.maxFiles = options?.maxFiles || '14d';
  this.format = options?.format || null;
  return this;
});
