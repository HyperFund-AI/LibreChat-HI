// Manual mock for winston-daily-rotate-file
// This prevents the module from trying to load file-stream-rotator
const winston = require('winston');

class DailyRotateFile extends winston.Transport {
  constructor(options = {}) {
    super(options);
    this.level = options?.level || 'error';
    this.filename = options?.filename || '../logs/error-%DATE%.log';
    this.datePattern = options?.datePattern || 'YYYY-MM-DD';
    this.zippedArchive = options?.zippedArchive !== false;
    this.maxSize = options?.maxSize || '20m';
    this.maxFiles = options?.maxFiles || '14d';
    this.format = options?.format || null;
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });
    callback();
  }
}

// Add to winston.transports (side-effect, like the real module does)
winston.transports.DailyRotateFile = DailyRotateFile;

module.exports = DailyRotateFile;
