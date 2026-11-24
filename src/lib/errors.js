/**
 * Error body (spec 1.7): { code, message, details?, requestId }. `message` is for logs/debug and is filled from i18n by
 * code unless given; the app translates by `code`.
 */
class AppError extends Error {
  constructor(status, code, details, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
    this.explicitMessage = message || null;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** `details` = { field, reason } */
const invalid = (field, reason = 'invalid') => new AppError(400, 'validation_failed', { field, reason });
const unauthorized = (code = 'unauthorized') => new AppError(401, code);
const forbidden = (code = 'forbidden') => new AppError(403, code);
const notFound = () => new AppError(404, 'not_found');
const conflict = (code, details) => new AppError(409, code, details);
const business = (code, details) => new AppError(422, code, details);
const tooMany = (retryAfter) => new AppError(429, 'rate_limited', { retryAfter });

module.exports = { AppError, asyncHandler, invalid, unauthorized, forbidden, notFound, conflict, business, tooMany };
