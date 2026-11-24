const config = require('../config');
const { AppError } = require('../lib/errors');
const { t } = require('../i18n');

const notFound = (_req, _res, next) => next(new AppError(404, 'not_found'));

/** Never leaks internals, never echoes tokens, passwords or bodies. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  let code = typeof err.code === 'string' ? err.code : null;
  let details = err.details;
  let message = err.explicitMessage || null;

  if (err.code === 11000) {
    status = 409;
    code = 'duplicate';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'bad_request';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    code = 'bad_request';
  }

  const known = err instanceof AppError || err.type || err.code === 11000;
  if (!known) status = 500;
  if (status >= 500) {
    console.error(req.requestId, err);
    code = status === 503 ? 'service_unavailable' : 'server_error';
    details = undefined;
    message = config.env === 'production' ? null : err.message;
  }
  if (status === 429 && details?.retryAfter) res.set('Retry-After', String(details.retryAfter));
  const body = { code: code || 'error', message: message || t(code, req.lang) || code };
  if (details !== undefined) body.details = details;
  body.requestId = req.requestId;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
