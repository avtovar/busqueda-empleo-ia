// MÓDULO DE LOGGING - versíon simplificada
// Para usar: const logger = require('./logger')
//logger.info('mensaje', { data: 'test' })
//logger.error('error', { code: 404 })
//logger.access('GET', '/api/job', 200, 45)

const fs = require('fs');
const path = require('path');

// Directorio de logs
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'api-requests.log');

// Crear directorio si no existe
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  console.error('No se pudo crear directorio de logs:', e.message);
}

// Timestamp
const getTimestamp = () => new Date().toISOString();

// Loguear a archivo
function logToFile(level, message, meta = {}) {
  try {
    const line = `[${getTimestamp()}] [${level.toUpperCase()}] ${message} ${JSON.stringify(meta)}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // Silenciar errors de logueo para no Infinite Loop
    console.error('Logger error:', e.message);
  }
}

// Exportar funciones de logging
const logger = {
  info: (message, meta = {}) => {
    const ts = getTimestamp();
    const line = `[${ts}] [INFO] ${message} ${JSON.stringify(meta)}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
    console.log(`[INFO] ${message}`, meta);
  },
  error: (message, meta = {}) => {
    const ts = getTimestamp();
    const line = `[${ts}] [ERROR] ${message} ${JSON.stringify(meta)}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
    console.error(`[ERROR] ${message}`, meta);
  },
  warn: (message, meta = {}) => {
    const ts = getTimestamp();
    const line = `[${ts}] [WARN] ${message} ${JSON.stringify(meta)}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
    console.warn(`[WARN] ${message}`, meta);
  },
  access: (method, url, status, responseTimeMs, ip = 'unknown', userAgent = 'unknown') => {
    const ts = getTimestamp();
    const line = `[${ts}] [ACCESS] ${method} ${url} ${status} ${responseTimeMs}ms ${ip}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
    console.log(`[ACCESS] ${method} ${url} ${status} ${responseTimeMs}ms ${ip}`);
  }
};

// Middleware simple para Express/Connect que loguea cada petición
logger.middleware = (req, res, next) => {
  const start = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('User-Agent') || 'unknown';
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const url = req.originalUrl || req.url;
    
    logger.access(method, url, duration, status, ip, userAgent);
    
    if (status >= 400) {
      logger.warn(`Status ${status} for ${method} ${url}`, { ip, responseTime: duration });
    }
    if (status >= 500) {
      logger.error(`Server error ${status} for ${method} ${url}`, { ip, responseTime: duration });
    }
  });
  
  next();
};

module.exports = logger;